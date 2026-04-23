import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthController, AuthEvent } from '../../src/auth/auth-controller';

// ---- Fake deps factory ----------------------------------------------------
function fakeDeps(overrides: Record<string, unknown> = {}) {
  let now = 1_000_000;
  const timers: Array<{ id: number; at: number; fn: () => void }> = [];
  let nextId = 1;

  const setTimeoutFn = ((fn: () => void, ms: number) => {
    const id = nextId++;
    timers.push({ id, at: now + ms, fn });
    return id as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;

  const clearTimeoutFn = ((id: unknown) => {
    const idx = timers.findIndex((t) => t.id === id);
    if (idx >= 0) timers.splice(idx, 1);
  }) as typeof clearTimeout;

  const advance = (ms: number) => {
    now += ms;
    while (true) {
      const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at);
      if (!due.length) break;
      for (const t of due) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
    }
  };

  const writtenFiles = new Map<string, unknown>();

  const deps = {
    authType: 'oauth-personal',
    callbackPort: 8085,
    pendingTimeoutMs: 10 * 60 * 1000,
    debounceMs: 5000,
    now: () => now,
    setTimeoutFn,
    clearTimeoutFn,
    credsPath: '/tmp/creds.json',
    accountIdPath: '/tmp/accountid',
    loadClientCreds: async () => ({ clientId: 'CID', clientSecret: 'CSECRET' }),
    probeCreds: async () => ({ ok: true, expiresAt: 123, hasRefreshToken: true }),
    createGenerator: async () => ({ generator: { fake: true }, model: 'gemini-2.5-pro' }),
    buildAuthUrl: ({ state }: { state: string }) =>
      `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
    exchangeCode: async () => ({
      credentials: { access_token: 'a', refresh_token: 'r' },
      client: {} as unknown as import('google-auth-library').OAuth2Client,
    }),
    fetchAccountId: async () => 'google-acct-id',
    writeCreds: async (p: string, c: unknown) => { writtenFiles.set(p, c); },
    deleteCreds: async (p: string) => { writtenFiles.delete(p); },
    writeAccountId: async (p: string, id: string) => { writtenFiles.set(p, id); },
    randomState: (() => {
      let n = 0;
      return () => `state-${++n}`;
    })(),
    logger: { log: () => {}, error: () => {} },
    ...overrides,
  };

  return { deps, advance, writtenFiles, timers };
}

test('init: valid cached creds → state becomes valid', async () => {
  const { deps } = fakeDeps();
  const ctl = createAuthController(deps);
  const events: AuthEvent[] = [];
  ctl.on((e) => events.push(e));

  await ctl.init();

  assert.equal(ctl.getState(), 'valid');
  assert.ok(events.some((e) => e.type === 'stateChange' && e.to === 'valid'));
});

test('init: invalid cached creds → state becomes broken', async () => {
  const { deps } = fakeDeps({
    probeCreds: async () => ({ ok: false, reason: 'expired' }),
  });
  const ctl = createAuthController(deps);
  await ctl.init();
  assert.equal(ctl.getState(), 'broken');
});

test('init: AUTH_TYPE != oauth-personal does not call probe', async () => {
  let probed = 0;
  const { deps } = fakeDeps({
    authType: 'gemini-api-key',
    probeCreds: async () => { probed++; return { ok: false }; },
    loadClientCreds: async () => { throw new Error('should not be called'); },
  });
  const ctl = createAuthController(deps);
  await ctl.init();
  assert.equal(ctl.getState(), 'valid');
  assert.equal(probed, 0);
});
