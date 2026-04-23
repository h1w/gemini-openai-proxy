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
  await ensureOauthCredentials();

  const cfg = await createContentGeneratorConfig(model, authTypeEnum);
  modelName = cfg.model;
  console.log(`Gemini CLI returned model: ${modelName}`);

  return await createContentGenerator(cfg);
})();

/* ------------------------------------------------------------------ */
/* 2.  Helpers consumed by server.ts                                   */
/* ------------------------------------------------------------------ */
type GeminiReq = {
  contents: unknown[];
  config?: Record<string, unknown>;
};

export async function sendChat({ contents, config = {} }: GeminiReq) {
  const generator: any = await generatorPromise;
  return await generator.generateContent({
    model: modelName,
    contents,
    config,
  });
}

export async function* sendChatStream({ contents, config = {} }: GeminiReq) {
  const generator: any = await generatorPromise;
  const stream = await generator.generateContentStream({
    model: modelName,
    contents,
    config,
  });
  for await (const chunk of stream) yield chunk;
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
