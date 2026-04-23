/* ------------------------------------------------------------------ */
/*  mapper.ts – OpenAI ⇆ Gemini bridge (multi-turn, tools, streaming)   */
/* ------------------------------------------------------------------ */
import { fetchAndEncode } from './remoteimage';
import { getModel } from './chatwrapper';

/* ------------------------------------------------------------------ */
type Part = {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { id?: string; name: string; args: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
  thought?: boolean;
  thoughtSignature?: string;
};

/* ------------------------------------------------------------------ */
/* thoughtSignature <-> tool_call.id round-trip                        */
/*   Gemini 3.x thinking models reject replayed functionCall parts    */
/*   that miss their original `thoughtSignature`. OpenAI tool_call.id */
/*   is opaque, so we use it to carry the signature invisibly.        */
/* ------------------------------------------------------------------ */
const SIG_ID_PREFIX = 'gfc_';

function encodeToolCallId(
  geminiId: string | undefined,
  sig: string | undefined,
  fallbackIndex: number,
  created: number,
): string {
  if (sig) {
    const b64 = Buffer.from(sig, 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    return `${SIG_ID_PREFIX}${b64}`;
  }
  return geminiId || `call_${created}_${fallbackIndex}`;
}

function decodeThoughtSignature(id: string | undefined): string | undefined {
  if (!id || !id.startsWith(SIG_ID_PREFIX)) return undefined;
  const body = id.slice(SIG_ID_PREFIX.length)
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const pad = body.length % 4 ? 4 - (body.length % 4) : 0;
  try {
    return Buffer.from(body + '='.repeat(pad), 'base64').toString('utf8');
  } catch {
    return undefined;
  }
}
type Content = { role: 'user' | 'model'; parts: Part[] };

type OpenAIToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

/* ================================================================== */
/* Helpers                                                             */
/* ================================================================== */
function parseJsonSafe(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined || raw === '') return {};
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  try {
    const v = JSON.parse(String(raw));
    return typeof v === 'object' && v !== null ? v : { value: v };
  } catch {
    return { value: String(raw) };
  }
}

function mapToolChoice(
  tc: unknown,
): { functionCallingConfig: { mode: string; allowedFunctionNames?: string[] } } | undefined {
  if (tc === undefined || tc === null) return undefined;
  if (typeof tc === 'string') {
    if (tc === 'auto') return { functionCallingConfig: { mode: 'AUTO' } };
    if (tc === 'none') return { functionCallingConfig: { mode: 'NONE' } };
    if (tc === 'required' || tc === 'any')
      return { functionCallingConfig: { mode: 'ANY' } };
  }
  if (typeof tc === 'object') {
    const obj = tc as any;
    if (obj.type === 'function' && obj.function?.name) {
      return {
        functionCallingConfig: {
          mode: 'ANY',
          allowedFunctionNames: [obj.function.name],
        },
      };
    }
  }
  return undefined;
}

async function openAIContentToParts(content: unknown): Promise<Part[]> {
  if (content === null || content === undefined) return [];
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return [{ text: String(content) }];

  const parts: Part[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'text' && typeof item.text === 'string') {
      parts.push({ text: item.text });
    } else if (item.type === 'image_url' && item.image_url?.url) {
      parts.push({ inlineData: await fetchAndEncode(item.image_url.url) });
    } else if (item.type === 'input_text' && typeof item.text === 'string') {
      // Some clients use OpenAI Responses API style
      parts.push({ text: item.text });
    }
  }
  return parts;
}

function buildToolCallIdToNameMap(messages: any[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of messages) {
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc?.id && tc?.function?.name) map.set(tc.id, tc.function.name);
      }
    }
  }
  return map;
}

/* ================================================================== */
/* Request mapper: OpenAI ➞ Gemini                                     */
/* ================================================================== */
export async function mapRequest(body: any) {
  const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
  const idToName = buildToolCallIdToNameMap(messages);

  const systemParts: Part[] = [];
  const contents: Content[] = [];

  // Helper to push or merge turn with previous same-role turn.
  const pushTurn = (role: 'user' | 'model', parts: Part[]) => {
    if (parts.length === 0) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      last.parts.push(...parts);
    } else {
      contents.push({ role, parts });
    }
  };

  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role;

    if (role === 'system' || role === 'developer') {
      systemParts.push(...(await openAIContentToParts(m.content)));
      continue;
    }

    if (role === 'user') {
      pushTurn('user', await openAIContentToParts(m.content));
      continue;
    }

    if (role === 'assistant') {
      const parts: Part[] = [];
      if (m.content) parts.push(...(await openAIContentToParts(m.content)));
      const toolCalls: any[] = Array.isArray(m.tool_calls)
        ? m.tool_calls
        : m.function_call
          ? [{ id: undefined, function: m.function_call }]
          : [];
      for (const tc of toolCalls) {
        const name = tc?.function?.name;
        if (!name) continue;
        const sig = decodeThoughtSignature(tc.id);
        const part: Part = {
          functionCall: {
            id: sig ? undefined : tc.id,
            name,
            args: parseJsonSafe(tc.function?.arguments),
          },
        };
        if (sig) part.thoughtSignature = sig;
        parts.push(part);
      }
      pushTurn('model', parts);
      continue;
    }

    if (role === 'tool' || role === 'function') {
      const id = m.tool_call_id ?? undefined;
      const name = m.name ?? (id ? idToName.get(id) : undefined) ?? 'unknown_tool';
      const response = parseJsonSafe(m.content);
      // Strip our gfc_ prefix from id — it carries signature, not a Gemini-side id.
      const geminiId = id && id.startsWith(SIG_ID_PREFIX) ? undefined : id;
      pushTurn('user', [
        {
          functionResponse: { id: geminiId, name, response },
        },
      ]);
      continue;
    }
    // unknown role: ignore
  }

  // Gemini requires contents to start with a user turn; prepend a stub if needed.
  if (contents.length === 0 || contents[0].role !== 'user') {
    contents.unshift({ role: 'user', parts: [{ text: '' }] });
  }

  /* ---- Tools --------------------------------------------------- */
  const functionDeclarations: any[] = [];

  if (Array.isArray(body.tools)) {
    for (const t of body.tools) {
      if (t?.type === 'function' && t.function?.name) {
        functionDeclarations.push({
          name: t.function.name,
          description: t.function.description ?? '',
          parametersJsonSchema: t.function.parameters ?? { type: 'object', properties: {} },
        });
      }
    }
  }
  if (Array.isArray(body.functions)) {
    for (const fn of body.functions) {
      if (!fn?.name) continue;
      functionDeclarations.push({
        name: fn.name,
        description: fn.description ?? '',
        parametersJsonSchema: fn.parameters ?? { type: 'object', properties: {} },
      });
    }
  }

  const tools =
    functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined;
  const toolConfig = mapToolChoice(body.tool_choice ?? body.function_call);

  /* ---- Generation config -------------------------------------- */
  const config: Record<string, unknown> = {};
  if (body.temperature !== undefined) config.temperature = body.temperature;
  if (body.top_p !== undefined) config.topP = body.top_p;
  if (body.max_tokens !== undefined) config.maxOutputTokens = body.max_tokens;
  if (body.max_completion_tokens !== undefined)
    config.maxOutputTokens = body.max_completion_tokens;
  if (Array.isArray(body.stop)) config.stopSequences = body.stop;
  else if (typeof body.stop === 'string') config.stopSequences = [body.stop];
  if (body.presence_penalty !== undefined)
    config.presencePenalty = body.presence_penalty;
  if (body.frequency_penalty !== undefined)
    config.frequencyPenalty = body.frequency_penalty;
  if (body.seed !== undefined) config.seed = body.seed;

  if (systemParts.length > 0) config.systemInstruction = { parts: systemParts };
  if (tools) config.tools = tools;
  if (toolConfig) config.toolConfig = toolConfig;

  // Thinking / reasoning
  if (body.include_reasoning === true || body.reasoning_effort) {
    const budget =
      typeof body.thinking_budget === 'number'
        ? body.thinking_budget
        : body.reasoning_effort === 'low'
          ? 1024
          : body.reasoning_effort === 'high'
            ? 8192
            : 2048;
    config.thinkingConfig = { includeThoughts: true, thinkingBudget: budget };
  }

  const geminiReq = { contents, config };

  // Brief summary for logs
  const summary = contents.map((c) => {
    const parts = c.parts.map((p) => {
      if (p.functionCall) return `fc:${p.functionCall.name}${p.thoughtSignature ? '+sig' : ''}`;
      if (p.functionResponse) return `fr:${p.functionResponse.name}`;
      if (p.inlineData) return `img:${p.inlineData.mimeType}`;
      if (p.text !== undefined) return `text:${(p.text || '').slice(0, 30).replace(/\s+/g, ' ')}`;
      return 'unknown';
    });
    return `${c.role}[${parts.join('|')}]`;
  });
  const toolsCount =
    (config.tools as any[] | undefined)?.[0]?.functionDeclarations?.length ?? 0;
  console.log(`➜ mapped: ${summary.join(' → ')} | tools=${toolsCount}`);

  return { geminiReq };
}

/* ================================================================== */
/* Finish reason mapping                                               */
/* ================================================================== */
function mapFinishReason(
  reason: string | undefined,
  hasToolCalls: boolean,
): 'stop' | 'length' | 'tool_calls' | 'content_filter' | null {
  if (hasToolCalls) return 'tool_calls';
  if (!reason) return 'stop';
  switch (reason) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'IMAGE_SAFETY':
      return 'content_filter';
    default:
      return 'stop';
  }
}

/* ================================================================== */
/* Non-stream response: Gemini ➞ OpenAI                                */
/* ================================================================== */
export function mapResponse(gResp: any) {
  const usage = gResp?.usageMetadata ?? {};
  const candidate = gResp?.candidates?.[0];

  if (!candidate) {
    return {
      error: {
        message: gResp?.promptFeedback?.blockReason ?? 'No candidates returned.',
      },
    };
  }

  const parts: any[] = candidate?.content?.parts ?? [];
  let contentText = '';
  let thoughtText = '';
  const toolCalls: OpenAIToolCall[] = [];
  let toolCounter = 0;
  const now = Date.now();

  for (const p of parts) {
    if (p.functionCall) {
      const id = encodeToolCallId(p.functionCall.id, p.thoughtSignature, toolCounter, now);
      toolCalls.push({
        id,
        type: 'function',
        function: {
          name: p.functionCall.name ?? '',
          arguments: JSON.stringify(p.functionCall.args ?? {}),
        },
      });
      toolCounter++;
    } else if (typeof p.text === 'string') {
      if (p.thought === true) thoughtText += p.text;
      else contentText += p.text;
    }
  }

  const finalContent =
    (thoughtText ? `<think>${thoughtText}</think>` : '') + contentText;

  const message: any = {
    role: 'assistant',
    content: finalContent || null,
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: getModel(),
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapFinishReason(candidate?.finishReason, toolCalls.length > 0),
      },
    ],
    usage: {
      prompt_tokens: usage.promptTokenCount ?? usage.promptTokens ?? 0,
      completion_tokens:
        usage.candidatesTokenCount ?? usage.candidatesTokens ?? 0,
      total_tokens: usage.totalTokenCount ?? usage.totalTokens ?? 0,
    },
  };
}

/* ================================================================== */
/* Stream chunk mapper: Gemini ➞ OpenAI                                */
/* ================================================================== */
export type StreamState = {
  id: string;
  created: number;
  toolCallIndex: number;
  inThink: boolean;
  roleEmitted: boolean;
};

export function makeStreamState(): StreamState {
  return {
    id: `chatcmpl-${Date.now()}`,
    created: Math.floor(Date.now() / 1000),
    toolCallIndex: 0,
    inThink: false,
    roleEmitted: false,
  };
}

function emptyDeltaChunk(state: StreamState, model: string, delta: any, finish?: string | null) {
  return {
    id: state.id,
    object: 'chat.completion.chunk',
    created: state.created,
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finish ?? null,
      },
    ],
  };
}

export function mapStreamChunks(chunk: any, state: StreamState): any[] {
  const model = getModel();
  const out: any[] = [];
  const candidate = chunk?.candidates?.[0];
  const parts: any[] = candidate?.content?.parts ?? [];

  if (!state.roleEmitted && parts.length > 0) {
    out.push(emptyDeltaChunk(state, model, { role: 'assistant', content: '' }));
    state.roleEmitted = true;
  }

  for (const p of parts) {
    if (p.functionCall) {
      const id = encodeToolCallId(
        p.functionCall.id,
        p.thoughtSignature,
        state.toolCallIndex,
        state.created,
      );
      out.push(
        emptyDeltaChunk(state, model, {
          tool_calls: [
            {
              index: state.toolCallIndex,
              id,
              type: 'function',
              function: {
                name: p.functionCall.name ?? '',
                arguments: JSON.stringify(p.functionCall.args ?? {}),
              },
            },
          ],
        }),
      );
      state.toolCallIndex++;
    } else if (typeof p.text === 'string') {
      if (p.thought === true) {
        const prefix = state.inThink ? '' : '<think>';
        state.inThink = true;
        out.push(emptyDeltaChunk(state, model, { content: prefix + p.text }));
      } else {
        const prefix = state.inThink ? '</think>' : '';
        state.inThink = false;
        out.push(emptyDeltaChunk(state, model, { content: prefix + p.text }));
      }
    }
  }

  const finishReason = candidate?.finishReason;
  if (finishReason) {
    if (state.inThink) {
      out.push(emptyDeltaChunk(state, model, { content: '</think>' }));
      state.inThink = false;
    }
    out.push(
      emptyDeltaChunk(
        state,
        model,
        {},
        mapFinishReason(finishReason, state.toolCallIndex > 0),
      ),
    );
  }
  return out;
}
