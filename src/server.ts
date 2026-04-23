import http from 'http';
import { sendChat, sendChatStream, listModels } from './chatwrapper';
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

    /* -------- /v1/models ---------- */
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          data: listModels(),
        }),
      );
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
        console.error('HTTP 500 Proxy error ➜', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: err?.message ?? String(err) } }));
        } else {
          try {
            res.write(
              `data: ${JSON.stringify({ error: { message: err?.message ?? String(err) } })}\n\n`,
            );
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
