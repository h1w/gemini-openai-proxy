// src/code-assist.ts
// Minimal direct HTTP client for Google's Code Assist API
// (cloudcode-pa.googleapis.com). Replaces @google/gemini-cli-core's
// ContentGenerator machinery so we are not coupled to its rapidly
// evolving Config-based API.
//
// Wire format mirrors what the official CLI sends, extracted from
// @google/gemini-cli-core/dist/src/code_assist/{server,converter,setup}.js.

import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import * as readline from 'node:readline';
import { OAuth2Client } from 'google-auth-library';

const CODE_ASSIST_ENDPOINT =
  process.env.CODE_ASSIST_ENDPOINT ?? 'https://cloudcode-pa.googleapis.com';
const CODE_ASSIST_API_VERSION =
  process.env.CODE_ASSIST_API_VERSION ?? 'v1internal';

const USER_TIER_FREE = 'free-tier';
const USER_TIER_LEGACY = 'legacy-tier';

type Part = Record<string, unknown>;
type Content = { role: 'user' | 'model'; parts: Part[] };

export type GenerateContentReq = {
  model: string;
  contents: Content[];
  config?: Record<string, unknown>;
};

export type GenerateContentResp = {
  candidates?: Array<{
    content?: { role?: string; parts?: Part[] };
    finishReason?: string;
    index?: number;
    safetyRatings?: unknown[];
  }>;
  promptFeedback?: unknown;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  modelVersion?: string;
  responseId?: string;
};

// ---------------------------------------------------------------------------
// Wire-format builders (mirrors code_assist/converter.js)
// ---------------------------------------------------------------------------

function toVertexGenerationConfig(
  config: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!config) return undefined;
  const out: Record<string, unknown> = {};
  const keys = [
    'temperature', 'topP', 'topK', 'candidateCount', 'maxOutputTokens',
    'stopSequences', 'responseLogprobs', 'logprobs', 'presencePenalty',
    'frequencyPenalty', 'seed', 'responseMimeType', 'responseSchema',
    'responseJsonSchema', 'routingConfig', 'modelSelectionConfig',
    'responseModalities', 'mediaResolution', 'speechConfig',
    'audioTimestamp', 'thinkingConfig',
  ];
  for (const k of keys) {
    if (k in config) out[k] = (config as Record<string, unknown>)[k];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function toWireRequest(
  req: GenerateContentReq,
  userPromptId: string,
  projectId: string | undefined,
  sessionId: string,
): Record<string, unknown> {
  const cfg = req.config ?? {};
  return {
    model: req.model,
    project: projectId,
    user_prompt_id: userPromptId,
    request: {
      contents: req.contents,
      systemInstruction: cfg.systemInstruction,
      cachedContent: cfg.cachedContent,
      tools: cfg.tools,
      toolConfig: cfg.toolConfig,
      labels: cfg.labels,
      safetySettings: cfg.safetySettings,
      generationConfig: toVertexGenerationConfig(cfg),
      session_id: sessionId,
    },
  };
}

// Responses from Code Assist wrap the Vertex response under a `response` field.
function unwrapResponse(raw: {
  response?: GenerateContentResp;
  traceId?: string;
}): GenerateContentResp {
  const inner = raw.response ?? {};
  return {
    ...inner,
    responseId: inner.responseId ?? raw.traceId,
  };
}

// ---------------------------------------------------------------------------
// Code Assist client
// ---------------------------------------------------------------------------

export interface CodeAssistClientOpts {
  oauth: OAuth2Client;
  model: string;
  cliVersion?: string;
  extraHeaders?: Record<string, string>;
}

export class CodeAssistClient {
  readonly oauth: OAuth2Client;
  readonly model: string;
  private projectId: string | undefined;
  private setupPromise: Promise<string | undefined> | null = null;
  private readonly cliVersion: string;
  private readonly extraHeaders: Record<string, string>;

  constructor(opts: CodeAssistClientOpts) {
    this.oauth = opts.oauth;
    this.model = opts.model;
    this.cliVersion = opts.cliVersion ?? process.env.CLI_VERSION ?? '0.39.1';
    this.extraHeaders = opts.extraHeaders ?? {};
  }

  private baseUrl(): string {
    return `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}`;
  }

  private methodUrl(method: string): string {
    return `${this.baseUrl()}:${method}`;
  }

  private userAgent(): string {
    return `GeminiCLI/${this.cliVersion}/${this.model} (${process.platform}; ${process.arch}; terminal)`;
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'User-Agent': this.userAgent(),
      ...this.extraHeaders,
    };
  }

  /**
   * Ensure the OAuth account is associated with a Code Assist project.
   * For the free tier the server returns `cloudaicompanionProject`
   * automatically; for standard tier we require GOOGLE_CLOUD_PROJECT.
   * Result is cached for the lifetime of the client instance.
   */
  async ensureSetup(): Promise<string | undefined> {
    if (this.setupPromise) return this.setupPromise;
    this.setupPromise = (async () => {
      const envProject =
        process.env.GOOGLE_CLOUD_PROJECT ||
        process.env.GOOGLE_CLOUD_PROJECT_ID ||
        undefined;

      const coreMetadata = {
        ideType: 'IDE_UNSPECIFIED',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI',
      };

      type LoadResp = {
        currentTier?: { id?: string; name?: string; hasOnboardedPreviously?: boolean };
        paidTier?: { id?: string; name?: string };
        allowedTiers?: Array<{
          id?: string;
          name?: string;
          isDefault?: boolean;
          userDefinedCloudaicompanionProject?: boolean;
        }>;
        cloudaicompanionProject?: string;
      };

      const loadResp = await this.requestJson<LoadResp>('loadCodeAssist', {
        cloudaicompanionProject: envProject,
        metadata: envProject
          ? { ...coreMetadata, duetProject: envProject }
          : coreMetadata,
      });

      if (loadResp.currentTier) {
        const project = loadResp.cloudaicompanionProject ?? envProject;
        this.projectId = project;
        return project;
      }

      // Need onboarding.
      const tier =
        loadResp.allowedTiers?.find((t) => t.isDefault) ??
        { id: USER_TIER_LEGACY, name: '', userDefinedCloudaicompanionProject: true };

      const onboardReq =
        tier.id === USER_TIER_FREE
          ? { tierId: tier.id, cloudaicompanionProject: undefined, metadata: coreMetadata }
          : {
            tierId: tier.id,
            cloudaicompanionProject: envProject,
            metadata: envProject ? { ...coreMetadata, duetProject: envProject } : coreMetadata,
          };

      type Lro = {
        name?: string;
        done?: boolean;
        response?: { cloudaicompanionProject?: { id?: string } };
      };
      let lro = await this.requestJson<Lro>('onboardUser', onboardReq);
      while (!lro.done && lro.name) {
        await new Promise((r) => setTimeout(r, 5000));
        lro = await this.requestJsonGet<Lro>(lro.name);
      }

      const project = lro.response?.cloudaicompanionProject?.id ?? envProject;
      this.projectId = project;
      return project;
    })();
    return this.setupPromise;
  }

  async generateContent(req: GenerateContentReq): Promise<GenerateContentResp> {
    const project = await this.ensureSetup();
    const wire = toWireRequest(req, randomUUID(), project, randomUUID());
    const raw = await this.requestJson<{ response?: GenerateContentResp; traceId?: string }>(
      'generateContent',
      wire,
    );
    return unwrapResponse(raw);
  }

  async *generateContentStream(
    req: GenerateContentReq,
  ): AsyncGenerator<GenerateContentResp> {
    const project = await this.ensureSetup();
    const wire = toWireRequest(req, randomUUID(), project, randomUUID());
    const stream = await this.requestStreamSse('streamGenerateContent', wire);
    for await (const chunk of stream) {
      const parsed = chunk as { response?: GenerateContentResp; traceId?: string };
      yield unwrapResponse(parsed);
    }
  }

  // ---- low-level HTTP --------------------------------------------------

  private async requestJson<T>(method: string, body: unknown): Promise<T> {
    const res = await this.oauth.request<T>({
      url: this.methodUrl(method),
      method: 'POST',
      headers: this.headers(),
      responseType: 'json',
      data: body,
    });
    return res.data;
  }

  private async requestJsonGet<T>(operationName: string): Promise<T> {
    const url = `${this.baseUrl()}/${operationName}`;
    const res = await this.oauth.request<T>({
      url,
      method: 'GET',
      headers: this.headers(),
      responseType: 'json',
    });
    return res.data;
  }

  private async requestStreamSse(
    method: string,
    body: unknown,
  ): Promise<AsyncIterable<unknown>> {
    const res = await this.oauth.request<NodeJS.ReadableStream>({
      url: this.methodUrl(method),
      method: 'POST',
      params: { alt: 'sse' },
      headers: this.headers(),
      responseType: 'stream',
      data: body,
    });

    const src = res.data as NodeJS.ReadableStream;
    const rl = readline.createInterface({
      input: Readable.from(src),
      crlfDelay: Infinity,
    });

    async function* iterator() {
      let buf: string[] = [];
      for await (const line of rl) {
        if (line.startsWith('data: ')) {
          buf.push(line.slice(6).trim());
          continue;
        }
        if (line === '') {
          if (buf.length === 0) continue;
          const chunk = buf.join('\n');
          buf = [];
          try {
            yield JSON.parse(chunk);
          } catch {
            // ignore malformed chunk
          }
        }
      }
    }
    return iterator();
  }
}
