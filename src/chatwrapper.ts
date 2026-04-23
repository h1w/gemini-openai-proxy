// src/chatwrapper.ts
import {
  AuthType,
  createContentGeneratorConfig,
  createContentGenerator,
} from '@google/gemini-cli-core/dist/src/core/contentGenerator.js';
import { ensureOauthCredentials } from './oauth-preflight';

const authType = process.env.AUTH_TYPE ?? 'gemini-api-key';
const authTypeEnum = authType as AuthType;

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
  // For AUTH_TYPE='oauth-personal': run our own OAuth flow on a fixed port
  // so it works inside Docker. No-op if credentials are already cached or
  // if a different auth type is in use.
  await ensureOauthCredentials();

  // Pass undefined for model so the helper falls back to DEFAULT_GEMINI_MODEL
  const cfg = await createContentGeneratorConfig(
    model, // let default model be used
    authTypeEnum
  );
  modelName = cfg.model;           // remember the actual model string
  console.log(`Gemini CLI returned model: ${modelName}`);

  return await createContentGenerator(cfg);
})();

/* ------------------------------------------------------------------ */
/* 2.  Helpers consumed by server.ts                                   */
/* ------------------------------------------------------------------ */
type GenConfig = Record<string, unknown>;

export async function sendChat({
  contents,
  generationConfig = {},
}: {
  contents: any[];
  generationConfig?: GenConfig;
  tools?: unknown;                // accepted but ignored for now
}) {
  const generator: any = await generatorPromise;
  return await generator.generateContent({
    model: modelName,
    contents,
    config: generationConfig,
  });
}

export async function* sendChatStream({
  contents,
  generationConfig = {},
}: {
  contents: any[];
  generationConfig?: GenConfig;
  tools?: unknown;
}) {
  const generator: any = await generatorPromise;
  const stream = await generator.generateContentStream({
    model: modelName,
    contents,
    config: generationConfig,
  });
  for await (const chunk of stream) yield chunk;
}

/* ------------------------------------------------------------------ */
/* 3.  Minimal stubs so server.ts compiles (extend later)              */
/* ------------------------------------------------------------------ */
export function listModels() {
  return [{ 
    id: modelName,
    object: 'model',
    owned_by: 'google'
  }];
}

export function getModel() {
  return modelName;
}
