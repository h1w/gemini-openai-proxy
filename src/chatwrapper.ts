// src/chatwrapper.ts
import { OAuth2Client } from 'google-auth-library';
import type { AuthController, GeneratorHandle } from './auth/auth-controller';
import type { HealthMonitor } from './auth/health-monitor';
import {
  getCachedCredentialPath,
  loadUpstreamOauthClientCredentials,
  readCachedCredentials,
} from './auth/oauth-flow';
import { CodeAssistClient } from './code-assist';

if (!process.env.CLI_VERSION) {
  process.env.CLI_VERSION = '0.39.1';
}

console.log(
  `Impersonating Gemini CLI as: GeminiCLI/${process.env.CLI_VERSION} (${process.platform}; ${process.arch})`,
);

export type AuthType = 'oauth-personal' | 'gemini-api-key' | 'vertex-ai';

export const authType = (process.env.AUTH_TYPE ?? 'gemini-api-key') as AuthType;
export const modelOverride = process.env.MODEL ?? undefined;

if (modelOverride) console.log(`Model override: ${modelOverride}`);
console.log(`Auth type: ${authType}`);

// Injected at bootstrap from server.ts.
let _controller: AuthController | null = null;
let _health: HealthMonitor | null = null;

export function bindChatwrapper(controller: AuthController, health: HealthMonitor) {
  _controller = controller;
  _health = health;
}

function ctl(): AuthController {
  if (!_controller) throw new Error('chatwrapper not bound: call bindChatwrapper first');
  return _controller;
}
function hm(): HealthMonitor {
  if (!_health) throw new Error('chatwrapper not bound: call bindChatwrapper first');
  return _health;
}

const DEFAULT_MODEL = 'gemini-2.5-pro';

async function buildOAuthClient(): Promise<OAuth2Client> {
  const { clientId, clientSecret } = await loadUpstreamOauthClientCredentials();
  const creds = await readCachedCredentials(getCachedCredentialPath());
  if (!creds) {
    throw new Error('No cached OAuth credentials — run login flow first');
  }
  const client = new OAuth2Client({ clientId, clientSecret });
  client.setCredentials(creds);
  return client;
}

// Factory passed INTO the controller so it owns generator lifecycle.
export async function defaultCreateGenerator(
  at: string,
  model?: string,
): Promise<GeneratorHandle> {
  if (at !== 'oauth-personal') {
    throw new Error(
      `AUTH_TYPE=${at} is not supported in this build — use oauth-personal`,
    );
  }
  const resolvedModel = model ?? DEFAULT_MODEL;
  const oauth = await buildOAuthClient();
  const client = new CodeAssistClient({ oauth, model: resolvedModel });
  return { generator: client as unknown, model: resolvedModel };
}

type GeminiReq = {
  contents: Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }>;
  config?: Record<string, unknown>;
};

const RETRY_DELAYS_MS = [1000, 3000, 9000];
function isRetryable(err: unknown): boolean {
  const e = err as { status?: number; code?: number; response?: { status?: number } };
  const status = e?.status ?? e?.code ?? e?.response?.status;
  if (typeof status !== 'number') return false;
  return status === 429 || (status >= 500 && status < 600);
}

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
    try {
      return await fn();
    } catch (err: unknown) {
      if (i === RETRY_DELAYS_MS.length || !isRetryable(err)) throw err;
      const delay = RETRY_DELAYS_MS[i];
      const e = err as { status?: number; code?: number; response?: { status?: number } };
      const status = e.status ?? e.code ?? e.response?.status;
      console.log(
        `[retry] ${label} got ${status}; waiting ${delay}ms (attempt ${i + 1}/${RETRY_DELAYS_MS.length})`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error('retry loop exhausted');
}

async function instrumented<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const r = await fn();
    hm().onSuccess(label, Date.now() - started);
    return r;
  } catch (e) {
    hm().onFailure(label, e);
    throw e;
  }
}

export async function sendChat({ contents, config = {} }: GeminiReq) {
  const { generator, model } = await ctl().getGenerator();
  const client = generator as CodeAssistClient;
  return instrumented('chat', () =>
    withRetry('sendChat', () => client.generateContent({ model, contents, config })),
  );
}

export async function* sendChatStream({ contents, config = {} }: GeminiReq) {
  const { generator, model } = await ctl().getGenerator();
  const client = generator as CodeAssistClient;
  const started = Date.now();
  let failed = false;
  try {
    const stream = await withRetry('sendChatStream', () =>
      Promise.resolve(client.generateContentStream({ model, contents, config })),
    );
    for await (const chunk of stream) yield chunk;
  } catch (e) {
    failed = true;
    hm().onFailure('chat_stream', e);
    throw e;
  } finally {
    if (!failed) hm().onSuccess('chat_stream', Date.now() - started);
  }
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
export const embeddingsAvailable = authType !== 'oauth-personal' || !!GEMINI_API_KEY;

export async function embedContent({
  model,
  contents,
  config,
}: {
  model: string;
  contents: Array<{ role: string; parts: Array<{ text?: string }> }>;
  config?: Record<string, unknown>;
}) {
  // Code Assist (oauth-personal) does not support embeddings directly;
  // always route embeddings through the generativelanguage API-key endpoint.
  if (!GEMINI_API_KEY) {
    const err = new Error(
      'Embeddings require GEMINI_API_KEY (set it even with AUTH_TYPE=oauth-personal)',
    );
    (err as { statusCode?: number }).statusCode = 501;
    throw err;
  }

  const modelId = model.startsWith('models/') ? model.slice(7) : model;
  const outputDim = (config as { outputDimensionality?: number } | undefined)?.outputDimensionality;
  const taskType = (config as { taskType?: string } | undefined)?.taskType;
  const title = (config as { title?: string } | undefined)?.title;

  const requests = contents.map((c) => {
    const r: Record<string, unknown> = {
      model: `models/${modelId}`,
      content: { parts: c.parts, role: 'user' },
    };
    if (outputDim !== undefined) r.outputDimensionality = outputDim;
    if (taskType) r.taskType = taskType;
    if (title) r.title = title;
    return r;
  });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    modelId,
  )}:batchEmbedContents?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  return instrumented('embed_apikey', async () => {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests }),
    });
    if (!resp.ok) {
      throw new Error(`Gemini embed API ${resp.status}: ${await resp.text()}`);
    }
    const data = (await resp.json()) as { embeddings?: Array<{ values?: number[] }> };
    return {
      embeddings: (data.embeddings ?? []).map((e) => ({ values: e.values ?? [] })),
    };
  });
}

export function listModels() {
  const snap = _controller?.getSnapshot();
  const id = snap?.model ?? modelOverride ?? DEFAULT_MODEL;
  return [{ id, object: 'model', owned_by: 'google' }];
}

export function getModel() {
  return _controller?.getSnapshot().model ?? modelOverride ?? DEFAULT_MODEL;
}
