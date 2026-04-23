import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { startCallbackServer } from '../../src/auth/callback-server';

async function httpGet(url: string): Promise<{ statusCode: number; location?: string; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () =>
        resolve({
          statusCode: res.statusCode ?? 0,
          location: res.headers.location as string | undefined,
          body: Buffer.concat(chunks).toString('utf-8'),
        }),
      );
    }).on('error', reject);
  });
}

test('callback-server: success redirects to SIGN_IN_SUCCESS_URL', async () => {
  const controller = {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    completeLoginWithCode: async (_code: string, _state: string) => {},
  };
  const srv = await startCallbackServer({ port: 0, controller });
  try {
    const addr = srv.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const r = await httpGet(`http://127.0.0.1:${port}/oauth2callback?code=c&state=s`);
    assert.equal(r.statusCode, 301);
    assert.ok(r.location && /auth_success_gemini/.test(r.location));
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

test('callback-server: no pending / state mismatch → 400', async () => {
  const controller = {
    completeLoginWithCode: async () => { const e = new Error('state mismatch'); e.name = 'StateMismatchError'; throw e; },
  };
  const srv = await startCallbackServer({ port: 0, controller });
  try {
    const addr = srv.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const r = await httpGet(`http://127.0.0.1:${port}/oauth2callback?code=c&state=wrong`);
    assert.equal(r.statusCode, 400);
    assert.match(r.body, /no pending/i);
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

test('callback-server: code exchange failure → 301 to failure URL', async () => {
  const controller = {
    completeLoginWithCode: async () => { throw new Error('google said no'); },
  };
  const srv = await startCallbackServer({ port: 0, controller, logger: { log: () => {}, error: () => {} } });
  try {
    const addr = srv.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const r = await httpGet(`http://127.0.0.1:${port}/oauth2callback?code=c&state=s`);
    assert.equal(r.statusCode, 301);
    assert.ok(r.location && /auth_failure_gemini/.test(r.location));
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

test('callback-server: unknown path → 404', async () => {
  const controller = { completeLoginWithCode: async () => {} };
  const srv = await startCallbackServer({ port: 0, controller });
  try {
    const addr = srv.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const r = await httpGet(`http://127.0.0.1:${port}/nope`);
    assert.equal(r.statusCode, 404);
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

test('callback-server: missing code or state → 400', async () => {
  const controller = { completeLoginWithCode: async () => {} };
  const srv = await startCallbackServer({ port: 0, controller });
  try {
    const addr = srv.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const r = await httpGet(`http://127.0.0.1:${port}/oauth2callback?code=c`);
    assert.equal(r.statusCode, 400);
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});
