// src/chatwrapper.ts
import { randomUUID } from 'crypto';
import {
  AuthType,
  createContentGeneratorConfig,
  createContentGenerator,
} from '@google/gemini-cli-core/dist/src/core/contentGenerator.js';
import { ensureOauthCredentials } from './oauth-preflight';

const authType = process.env.AUTH_TYPE ?? 'gemini-api-key';
const authTypeEnum = authType as AuthType;

// Pretend to be the real Gemini CLI so Code Assist doesn't throttle us harder
// than the official client.
if (!process.env.CLI_VERSION) {
  process.env.CLI_VERSION = '0.39.0';
}

const sessionId = randomUUID();
console.log(`Session ID: ${sessionId}`);
console.log(
  `Impersonating Gemini CLI as: GeminiCLI/${process.env.CLI_VERSION} (${process.platform}; ${process.arch})`,
);

export const currentAuthType = authType;

console.log(`Auth type: ${authType}`);

const model = process.env.MODEL ?? undefined;

if (model) {
  console.log(`Model override: ${model}`);
}

/* ------------------------------------------------------------------ */
/* 1.  Build the ContentGenerator exactly like the CLI does           */
/* ------------------------------------------------------------------ */
let modelName: string;
const generatorPromise = (async () => {
  await ensureOauthCredentials();

  const cfg = await createContentGeneratorConfig(model, authTypeEnum);
  modelName = cfg.model;
  console.log(`Gemini CLI returned model: ${modelName}`);

  return await createContentGenerator(cfg, sessionId);
})();

/* ------------------------------------------------------------------ */
/* 2.  Helpers consumed by server.ts                                   */
/* ------------------------------------------------------------------ */
type GeminiReq = {
  contents: unknown[];
  config?: Record<string, unknown>;
};

// Retry on 429 (rate-limit) and 5xx with exponential backoff.
const RETRY_DELAYS_MS = [1000, 3000, 9000];

function isRetryable(err: any): boolean {
  const status = err?.status ?? err?.code;
  if (typeof status !== 'number') return false;
  return status === 429 || (status >= 500 && status < 600);
}

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
    try {
      return await fn();
    } catch (err: any) {
      if (i === RETRY_DELAYS_MS.length || !isRetryable(err)) throw err;
      const delay = RETRY_DELAYS_MS[i];
      const status = err?.status ?? err?.code;
      console.log(
        `[retry] ${label} got ${status}; waiting ${delay}ms (attempt ${i + 1}/${RETRY_DELAYS_MS.length})`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  // unreachable
  throw new Error('retry loop exhausted');
}

export async function sendChat({ contents, config = {} }: GeminiReq) {
  const generator: any = await generatorPromise;
  return await withRetry('sendChat', () =>
    generator.generateContent({ model: modelName, contents, config }),
  );
}

export async function* sendChatStream({ contents, config = {} }: GeminiReq) {
  const generator: any = await generatorPromise;
  const stream: any = await withRetry('sendChatStream', () =>
    generator.generateContentStream({ model: modelName, contents, config }),
  );
  for await (const chunk of stream) yield chunk;
}

/* ------------------------------------------------------------------ */
/* Embeddings                                                          */
/*                                                                     */
/*  Google's embedding endpoint does NOT accept user OAuth tokens:     */
/*    * generativelanguage.googleapis.com: API key only                */
/*    * cloudcode-pa (Code Assist): no embed method at all             */
/*    * Vertex AI: needs own GCP project + billing                     */
/*  So for oauth-personal we require an additional GEMINI_API_KEY env  */
/*  — same key users already have for the Gemini Developer API.        */
/* ------------------------------------------------------------------ */
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
export const embeddingsAvailable =
  authType !== 'oauth-personal' || !!GEMINI_API_KEY;

export async function embedContent({
  model,
  contents,
  config,
}: {
  model: string;
  contents: Array<{ role: string; parts: Array<{ text?: string }> }>;
  config?: Record<string, unknown>;
}) {
  if (authType !== 'oauth-personal') {
    const generator: any = await generatorPromise;
    return await generator.embedContent({ model, contents, config });
  }

  if (!GEMINI_API_KEY) {
    const err: any = new Error(
      'Embeddings are not available through AUTH_TYPE=oauth-personal — Google does not ' +
        'expose the embed endpoint to user OAuth tokens on any host (cloudcode-pa, ' +
        'generativelanguage, Vertex AI all confirmed). Set GEMINI_API_KEY env var ' +
        '(free at https://aistudio.google.com/apikey) alongside AUTH_TYPE=oauth-personal — ' +
        'it will be used exclusively for /v1/embeddings; chat continues to use OAuth.',
    );
    err.statusCode = 501;
    throw err;
  }

  // OAuth-personal + API key present → call Gemini Developer API with the key.
  const modelId = model.startsWith('models/') ? model.slice(7) : model;
  const outputDim = (config as any)?.outputDimensionality;
  const taskType = (config as any)?.taskType;
  const title = (config as any)?.title;

  const requests = contents.map((c) => {
    const r: any = {
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
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
  });
  if (!resp.ok) {
    throw new Error(`Gemini embed API ${resp.status}: ${await resp.text()}`);
  }
  const data: any = await resp.json();
  return {
    embeddings: (data.embeddings ?? []).map((e: any) => ({ values: e.values ?? [] })),
  };
}

/* ------------------------------------------------------------------ */
/* 3.  /v1/models: return the active model                             */
/* ------------------------------------------------------------------ */
export function listModels() {
  return [
    {
      id: modelName,
      object: 'model',
      owned_by: 'google',
    },
  ];
}

export function getModel() {
  return modelName;
}
