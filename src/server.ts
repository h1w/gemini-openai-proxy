import http from 'http';
import {
  sendChat,
  sendChatStream,
  listModels,
  embedContent,
  bindChatwrapper,
  defaultCreateGenerator,
  authType,
  modelOverride,
} from './chatwrapper';
import { mapRequest, mapResponse, mapStreamChunks, makeStreamState } from './mapper';
import { createAuthController } from './auth/auth-controller';
import { startCallbackServer } from './auth/callback-server';
import { createHealthMonitor } from './auth/health-monitor';
import { createTelegramBot } from './telegram/bot';
import { AuthBrokenError } from './auth/errors';

const PORT = Number(process.env.PORT ?? 11434);
const CALLBACK_PORT = Number(process.env.OAUTH_CALLBACK_PORT ?? 8085);

process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
});

// ---- Bootstrap ---------------------------------------------------------------
const controller = createAuthController({
  authType,
  callbackPort: CALLBACK_PORT,
  modelOverride,
  createGenerator: defaultCreateGenerator,
});
const health = createHealthMonitor({ controller });
bindChatwrapper(controller, health);

// Kick off init (non-blocking); if OAuth creds are missing, auto-start login.
void controller.init({ autoStartLoginIfBroken: true }).catch((e) => {
  console.error('AuthController init failed:', e);
});

health.start();

let callbackServer: import('http').Server | undefined;
let telegramBot: import('./telegram/bot').TelegramBotHandle | undefined;

let shutdownCalled = false;
async function shutdown(signal: string) {
  if (shutdownCalled) return;
  shutdownCalled = true;
  console.log(`Received ${signal}, shutting down`);
  try { health.stop(); } catch (e) { console.error('health.stop:', e); }
  try { controller.dispose(); } catch (e) { console.error('controller.dispose:', e); }
  if (telegramBot) {
    try { await telegramBot.stop(); } catch (e) { console.error('telegramBot.stop:', e); }
  }
  if (callbackServer) {
    await new Promise<void>((resolve) => callbackServer!.close(() => resolve()));
  }
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

// ---- Callback server (oauth-personal only) ----------------------------------
if (authType === 'oauth-personal') {
  startCallbackServer({ port: CALLBACK_PORT, controller })
    .then((srv) => {
      controller.setCallbackServerReady(true);
      console.log(`OAuth callback server on http://localhost:${CALLBACK_PORT}`);
      callbackServer = srv;
    })
    .catch((e) => {
      controller.setCallbackServerReady(false);
      console.error(`OAuth callback server failed to bind port ${CALLBACK_PORT}:`, e);
    });
} else {
  controller.setCallbackServerReady(false);
}

// ---- Telegram bot (only if both env vars set) --------------------------------
{
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const userIdRaw = process.env.TELEGRAM_USER_ID?.trim();
  const userId = userIdRaw ? Number(userIdRaw) : NaN;
  if (!token || !userIdRaw) {
    console.log('Telegram bot disabled (TELEGRAM_BOT_TOKEN and TELEGRAM_USER_ID must both be set)');
  } else if (!Number.isInteger(userId) || userId <= 0) {
    console.error(`TELEGRAM_USER_ID must be a positive integer, got "${userIdRaw}" — bot disabled`);
  } else {
    const bot = createTelegramBot({
      token, userId, controller, health,
      proxyPort: PORT, callbackPort: CALLBACK_PORT,
      cliVersion: process.env.CLI_VERSION,
    });
    bot.start().catch((e) => console.error('telegram bot failed to start:', e));
    telegramBot = bot;
  }
}

// ---- CORS / JSON helpers -----------------------------------------------------
function allowCors(res: http.ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}

function readJSON(req: http.IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (!data) { resolve({}); return; }
      try { resolve(JSON.parse(data)); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

// ---- HTTP server -------------------------------------------------------------
http.createServer(async (req, res) => {
  allowCors(res);
  console.log('➜', req.method, req.url);

  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'gemini-openai-proxy',
      authState: controller.getState(),
      callbackServerReady: controller.getSnapshot().callbackServerReady ?? false,
    }));
    return;
  }

  if (req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: listModels() }));
    return;
  }

  if (req.url?.startsWith('/v1/models/') && req.method === 'GET') {
    const requestedId = decodeURIComponent(req.url.slice('/v1/models/'.length));
    const models = listModels();
    const found = models.find((m) => m.id === requestedId) ?? models[0];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...found, id: requestedId }));
    return;
  }

  if (req.url === '/v1/embeddings' && req.method === 'POST') {
    const body = await readJSON(req);
    if (!body) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Malformed JSON body' } }));
      return;
    }
    try {
      const rawInput = (body as { input?: unknown }).input;
      const inputs: string[] = Array.isArray(rawInput)
        ? rawInput.map(String)
        : rawInput === undefined || rawInput === null ? [] : [String(rawInput)];

      if (inputs.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'input is required' } }));
        return;
      }

      const modelIn = (body as { model?: unknown }).model;
      const embedModel =
        typeof modelIn === 'string' && modelIn.startsWith('gemini-') ? modelIn : 'gemini-embedding-001';

      const contents = inputs.map((text) => ({ role: 'user', parts: [{ text }] }));
      const config: Record<string, unknown> = {};
      const dims = (body as { dimensions?: unknown }).dimensions;
      if (typeof dims === 'number') config.outputDimensionality = dims;

      const gResp = await embedContent({
        model: embedModel, contents,
        config: Object.keys(config).length > 0 ? config : undefined,
      });

      const embs = (gResp as { embeddings?: Array<{ values?: number[] }> })?.embeddings ?? [];
      const data = embs.map((e, index) => ({ object: 'embedding', index, embedding: e?.values ?? [] }));
      const promptTokens = inputs.reduce((s, t) => s + Math.ceil(t.length / 4), 0);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list', data, model: embedModel,
        usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
      }));
      console.log(`✅ /v1/embeddings: ${data.length} vectors, model=${embedModel}`);
    } catch (err: unknown) {
      if (err instanceof AuthBrokenError) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `${err.message}: ${err.hint}` } }));
        return;
      }
      const e = err as { statusCode?: number; message?: string };
      const statusCode = typeof e?.statusCode === 'number' ? e.statusCode : 500;
      const msg = e?.message ?? String(err);
      console.error(`HTTP ${statusCode} /v1/embeddings error ➜`, msg);
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: msg } }));
    }
    return;
  }

  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    const body = await readJSON(req);
    if (!body) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Malformed JSON body' } }));
      return;
    }
    try {
      const { geminiReq } = await mapRequest(body);

      const INLINE_LIMIT_BYTES = 18 * 1024 * 1024;
      let inlineBytes = 0;
      for (const c of geminiReq.contents as Array<{ parts?: Array<{ inlineData?: { data?: string } }> }>) {
        for (const p of c.parts ?? []) {
          const b64 = p?.inlineData?.data;
          if (typeof b64 === 'string') inlineBytes += Math.floor((b64.length * 3) / 4);
        }
      }
      if (inlineBytes > INLINE_LIMIT_BYTES) {
        const mb = (inlineBytes / 1024 / 1024).toFixed(1);
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Inline payload ${mb}MB exceeds 20MB Gemini limit` } }));
        return;
      }

      if ((body as { stream?: unknown }).stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const state = makeStreamState();
        for await (const chunk of sendChatStream(geminiReq)) {
          for (const out of mapStreamChunks(chunk, state)) {
            res.write(`data: ${JSON.stringify(out)}\n\n`);
          }
        }
        res.end('data: [DONE]\n\n');
      } else {
        const gResp = await sendChat(geminiReq);
        const mapped = mapResponse(gResp);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(mapped));
      }
    } catch (err: unknown) {
      if (err instanceof AuthBrokenError) {
        if (!res.headersSent) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `${err.message}: ${err.hint}` } }));
        } else {
          try {
            res.write(`data: ${JSON.stringify({ error: { message: `${err.message}: ${err.hint}` } })}\n\n`);
            res.end('data: [DONE]\n\n');
          } catch { /* socket closed */ }
        }
        return;
      }
      const e = err as { status?: number; code?: number; message?: string; errors?: Array<{ message?: string }>; response?: { data?: { error?: { message?: string } } } };
      const upstream = typeof e?.status === 'number' ? e.status : typeof e?.code === 'number' ? e.code : undefined;
      const status = upstream && upstream >= 400 && upstream < 600 ? upstream : 500;
      const msg = e?.errors?.[0]?.message ?? e?.response?.data?.error?.message ?? e?.message ?? String(err);
      console.error(`HTTP ${status} Proxy error ➜`, msg);
      if (!res.headersSent) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: msg, upstream_status: upstream } }));
      } else {
        try {
          res.write(`data: ${JSON.stringify({ error: { message: msg, upstream_status: upstream } })}\n\n`);
          res.end('data: [DONE]\n\n');
        } catch { /* socket closed */ }
      }
    }
    return;
  }

  console.log('➜ unknown request, returning HTTP 404');
  res.writeHead(404).end();
}).listen(PORT, () => console.log(`OpenAI proxy listening on http://localhost:${PORT}`));
