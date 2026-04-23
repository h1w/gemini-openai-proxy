import * as http from 'node:http';
import { URL } from 'node:url';
import { SIGN_IN_SUCCESS_URL, SIGN_IN_FAILURE_URL } from './oauth-flow';

interface ControllerPort {
  completeLoginWithCode(code: string, state: string): Promise<void>;
}

export interface CallbackServerOptions {
  port: number;
  controller: ControllerPort;
  logger?: { log: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}

export async function startCallbackServer(
  opts: CallbackServerOptions,
): Promise<http.Server> {
  const logger = opts.logger ?? console;
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname;
      if (req.method !== 'GET' || pathname !== '/oauth2callback') {
        res.writeHead(404).end();
        return;
      }
      const params = new URL(req.url ?? '/', 'http://x').searchParams;
      const code = params.get('code');
      const state = params.get('state');
      if (!code || !state) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing code or state parameter');
        return;
      }
      try {
        await opts.controller.completeLoginWithCode(code, state);
        res.writeHead(301, { Location: SIGN_IN_SUCCESS_URL });
        res.end();
      } catch (e: unknown) {
        const name = (e as { name?: string })?.name;
        if (name === 'NoPendingLoginError' || name === 'StateMismatchError') {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end(
            'No pending login or state mismatch — request a new login via Telegram or restart proxy.',
          );
          return;
        }
        logger.error('callback-server: exchange failed:', e);
        res.writeHead(301, { Location: SIGN_IN_FAILURE_URL });
        res.end();
      }
    } catch (e) {
      logger.error('callback-server: handler crashed:', e);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return server;
}
