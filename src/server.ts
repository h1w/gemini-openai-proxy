import http from 'http';
import {
  sendChat,
  sendChatStream,
  listModels,
  embedContent,
} from './chatwrapper';
import { mapRequest, mapResponse, mapStreamChunks, makeStreamState } from './mapper';

/* ── basic config ─────────────────────────────────────────────────── */
const PORT = Number(process.env.PORT ?? 11434);

process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
});

/* ── CORS helper ──────────────────────────────────────────────────── */
function allowCors(res: http.ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}

/* ── JSON body helper ─────────────────────────────────────────────── */
function readJSON(req: http.IncomingMessage): Promise<any | null> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (!data) { resolve({}); return; }
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

/* ── server ───────────────────────────────────────────────────────── */
http
  .createServer(async (req, res) => {
    allowCors(res);

    console.log('➜', req.method, req.url);

    /* -------- pre-flight ---------- */
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    /* -------- GET / or /health ---------- */
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'gemini-openai-proxy' }));
      return;
    }

    /* -------- /v1/models ---------- */
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: listModels(),
        }),
      );
      return;
    }

    /* -------- /v1/models/{id} ---------- */
    if (req.url?.startsWith('/v1/models/') && req.method === 'GET') {
      const requestedId = decodeURIComponent(req.url.slice('/v1/models/'.length));
      const models = listModels();
      const found = models.find((m) => m.id === requestedId) ?? models[0];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...found, id: requestedId }));
      return;
    }

    /* -------- /v1/embeddings ---------- */
    if (req.url === '/v1/embeddings' && req.method === 'POST') {
      const body = await readJSON(req);
      if (!body) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Malformed JSON body' } }));
        return;
      }
      try {
        const rawInput = body.input;
        const inputs: string[] = Array.isArray(rawInput)
          ? rawInput.map(String)
          : rawInput === undefined || rawInput === null
            ? []
            : [String(rawInput)];

        if (inputs.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'input is required' } }));
          return;
        }

        const embedModel =
          typeof body.model === 'string' && body.model.startsWith('gemini-')
            ? body.model
            : 'gemini-embedding-001';

        const contents = inputs.map((text) => ({
          role: 'user',
          parts: [{ text }],
        }));
        const config: Record<string, unknown> = {};
        if (typeof body.dimensions === 'number') {
          config.outputDimensionality = body.dimensions;
        }

        const gResp: any = await embedContent({
          model: embedModel,
          contents,
          config: Object.keys(config).length > 0 ? config : undefined,
        });

        const embs: any[] = gResp?.embeddings ?? [];
        const data = embs.map((e, index) => ({
          object: 'embedding',
          index,
          embedding: e?.values ?? [],
        }));
        const promptTokens = inputs.reduce((s, t) => s + Math.ceil(t.length / 4), 0);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            object: 'list',
            data,
            model: embedModel,
            usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
          }),
        );
        console.log(`✅ /v1/embeddings: ${data.length} vectors, model=${embedModel}`);
      } catch (err: any) {
        const msg = err?.message || err?.toString?.() || 'Embeddings failed';
        const statusCode = typeof err?.statusCode === 'number' ? err.statusCode : 500;
        console.error(`HTTP ${statusCode} /v1/embeddings error ➜`, msg);
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: msg } }));
      }
      return;
    }

    /* ---- /v1/chat/completions ---- */
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      const body = await readJSON(req);
      if (!body) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Malformed JSON body' } }));
        console.log('HTTP 400 Proxy error: malformed JSON');
        return;
      }

      try {
        const { geminiReq } = await mapRequest(body);

        // Guard: Gemini rejects inlineData payloads > ~20MB. Check total size
        // across all parts, fail early with 413 + clear message before we waste
        // bandwidth and tokens sending it.
        const INLINE_LIMIT_BYTES = 18 * 1024 * 1024;
        let inlineBytes = 0;
        for (const c of geminiReq.contents as any[]) {
          for (const p of c.parts ?? []) {
            const b64 = p?.inlineData?.data;
            if (typeof b64 === 'string') inlineBytes += Math.floor((b64.length * 3) / 4);
          }
        }
        if (inlineBytes > INLINE_LIMIT_BYTES) {
          const mb = (inlineBytes / 1024 / 1024).toFixed(1);
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                message: `Inline image/audio/file data totals ${mb}MB, exceeds Gemini's 20MB inline limit. Downscale the image or use Gemini's Files API for larger content.`,
              },
            }),
          );
          console.log(`HTTP 413: inline payload ${mb}MB exceeds 18MB guard`);
          return;
        }

        if (body.stream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });

          console.log('➜ sending HTTP 200 streamed response');

          const state = makeStreamState();
          for await (const chunk of sendChatStream(geminiReq)) {
            for (const out of mapStreamChunks(chunk, state)) {
              res.write(`data: ${JSON.stringify(out)}\n\n`);
            }
          }
          res.end('data: [DONE]\n\n');

          console.log('➜ done sending streamed response');
        } else {
          const gResp = await sendChat(geminiReq);
          const mapped = mapResponse(gResp);
          const code = 200;
          res.writeHead(code, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(mapped));

          console.log('✅ Replied HTTP ' + code + ' response', mapped);
        }
      } catch (err: any) {
        // Propagate upstream Gemini status (429 rate-limit, 413 too-large, 403 perms, etc.)
        // Gaxios errors expose `.status` / `.code`; other errors fall back to 500.
        const upstream =
          typeof err?.status === 'number'
            ? err.status
            : typeof err?.code === 'number'
              ? err.code
              : undefined;
        const status = upstream && upstream >= 400 && upstream < 600 ? upstream : 500;
        const msg =
          err?.errors?.[0]?.message ??
          err?.response?.data?.error?.message ??
          err?.message ??
          String(err);
        console.error(`HTTP ${status} Proxy error ➜`, msg);
        if (!res.headersSent) {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: msg, upstream_status: upstream } }));
        } else {
          try {
            res.write(`data: ${JSON.stringify({ error: { message: msg, upstream_status: upstream } })}\n\n`);
            res.end('data: [DONE]\n\n');
          } catch { /* socket already closed */ }
        }
      }

      return;
    }

    console.log('➜ unknown request, returning HTTP 404');
    /* ---- anything else ---------- */
    res.writeHead(404).end();
  })
  .listen(PORT, () => console.log(`OpenAI proxy listening on http://localhost:${PORT}`));
