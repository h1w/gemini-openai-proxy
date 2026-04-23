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

test('startLogin: happy path emits loginStarted and moves to pending', async () => {
  const { deps } = fakeDeps({
    probeCreds: async () => ({ ok: false, reason: 'no creds' }),
  });
  const ctl = createAuthController(deps);
  const events: AuthEvent[] = [];
  ctl.on((e) => events.push(e));
  await ctl.init();

  const { authUrl } = await ctl.startLogin('telegram');

  assert.equal(ctl.getState(), 'pending');
  assert.match(authUrl, /state=state-1/);
  const loginStarted = events.find((e) => e.type === 'loginStarted');
  assert.ok(loginStarted);
});

test('startLogin: debounced within 5s returns the same URL', async () => {
  const { deps, advance } = fakeDeps({
    probeCreds: async () => ({ ok: false }),
  });
  const ctl = createAuthController(deps);
  await ctl.init();
  const first = await ctl.startLogin('telegram');
  advance(1000);
  const second = await ctl.startLogin('telegram');
  assert.equal(first.authUrl, second.authUrl);
});

test('startLogin: after debounce window regenerates', async () => {
  const { deps, advance } = fakeDeps({
    probeCreds: async () => ({ ok: false }),
  });
  const ctl = createAuthController(deps);
  await ctl.init();
  const first = await ctl.startLogin('telegram');
  advance(6000);
  const second = await ctl.startLogin('telegram');
  assert.notEqual(first.authUrl, second.authUrl);
});

test('startLogin: rejects when authType is not oauth-personal', async () => {
  const { deps } = fakeDeps({ authType: 'gemini-api-key' });
  const ctl = createAuthController(deps);
  await ctl.init();
  await assert.rejects(
    () => ctl.startLogin('telegram'),
    (err: Error) => err.name === 'OAuthNotSupportedError',
  );
});

test('completeLoginWithCode: happy path writes creds and transitions to valid', async () => {
  const { deps, writtenFiles } = fakeDeps({
    probeCreds: async () => ({ ok: false }),
  });
  const ctl = createAuthController(deps);
  const events: AuthEvent[] = [];
  ctl.on((e) => events.push(e));
  await ctl.init();
  await ctl.startLogin('telegram');

  await ctl.completeLoginWithCode('authcode', 'state-1');

  assert.equal(ctl.getState(), 'valid');
  assert.ok(writtenFiles.has('/tmp/creds.json'));
  assert.ok(writtenFiles.has('/tmp/accountid'));
  assert.ok(events.find((e) => e.type === 'loginCompleted'));
});

test('completeLoginWithCode: no pending → NoPendingLoginError', async () => {
  const { deps } = fakeDeps({ probeCreds: async () => ({ ok: false }) });
  const ctl = createAuthController(deps);
  await ctl.init();
  await assert.rejects(
    () => ctl.completeLoginWithCode('code', 'whatever'),
    (err: Error) => err.name === 'NoPendingLoginError',
  );
});

test('completeLoginWithCode: state mismatch → StateMismatchError, stays pending', async () => {
  const { deps } = fakeDeps({ probeCreds: async () => ({ ok: false }) });
  const ctl = createAuthController(deps);
  await ctl.init();
  await ctl.startLogin('telegram');
  await assert.rejects(
    () => ctl.completeLoginWithCode('code', 'wrong-state'),
    (err: Error) => err.name === 'StateMismatchError',
  );
  assert.equal(ctl.getState(), 'pending');
});

test('completeLoginWithCode: exchange failure moves to broken and emits loginFailed', async () => {
  const { deps } = fakeDeps({
    probeCreds: async () => ({ ok: false }),
    exchangeCode: async () => { throw new Error('google said no'); },
  });
  const ctl = createAuthController(deps);
  const events: AuthEvent[] = [];
  ctl.on((e) => events.push(e));
  await ctl.init();
  await ctl.startLogin('telegram');
  await assert.rejects(() => ctl.completeLoginWithCode('code', 'state-1'));
  assert.equal(ctl.getState(), 'broken');
  assert.ok(events.find((e) => e.type === 'loginFailed' && e.reason === 'google said no'));
});

test('submitCallbackUrl: parses URL then delegates to completeLoginWithCode', async () => {
  const { deps } = fakeDeps({ probeCreds: async () => ({ ok: false }) });
  const ctl = createAuthController(deps);
  await ctl.init();
  await ctl.startLogin('telegram');
  await ctl.submitCallbackUrl('http://localhost:8085/oauth2callback?code=c&state=state-1');
  assert.equal(ctl.getState(), 'valid');
});

test('submitCallbackUrl: garbage text throws InvalidCallbackUrlError', async () => {
  const { deps } = fakeDeps({ probeCreds: async () => ({ ok: false }) });
  const ctl = createAuthController(deps);
  await ctl.init();
  await ctl.startLogin('telegram');
  await assert.rejects(
    () => ctl.submitCallbackUrl('hello there'),
    (err: Error) => err.name === 'InvalidCallbackUrlError',
  );
});

test('pending session times out after 10 minutes → broken + loginFailed', async () => {
  const { deps, advance } = fakeDeps({ probeCreds: async () => ({ ok: false }) });
  const ctl = createAuthController(deps);
  const events: AuthEvent[] = [];
  ctl.on((e) => events.push(e));
  await ctl.init();
  await ctl.startLogin('telegram');
  advance(10 * 60 * 1000 + 1);
  assert.equal(ctl.getState(), 'broken');
  assert.ok(events.find((e) => e.type === 'loginFailed' && /expired/.test(e.reason)));
});

test('logout: transitions to broken and deletes creds', async () => {
  const { deps, writtenFiles } = fakeDeps();
  const ctl = createAuthController(deps);
  writtenFiles.set('/tmp/creds.json', { stale: true });
  await ctl.init();
  assert.equal(ctl.getState(), 'valid');
  await ctl.logout();
  assert.equal(ctl.getState(), 'broken');
  assert.equal(writtenFiles.has('/tmp/creds.json'), false);
});

test('reportAuthFailure: valid → broken', async () => {
  const { deps } = fakeDeps();
  const ctl = createAuthController(deps);
  await ctl.init();
  assert.equal(ctl.getState(), 'valid');
  ctl.reportAuthFailure(new Error('401 Unauthorized'));
  assert.equal(ctl.getState(), 'broken');
});

test('reportAuthFailure: pending stays pending', async () => {
  const { deps } = fakeDeps({ probeCreds: async () => ({ ok: false }) });
  const ctl = createAuthController(deps);
  await ctl.init();
  await ctl.startLogin('telegram');
  ctl.reportAuthFailure(new Error('transient'));
  assert.equal(ctl.getState(), 'pending');
});

test('getGenerator: valid → returns generator with model populated', async () => {
  const { deps } = fakeDeps();
  const ctl = createAuthController(deps);
  await ctl.init();
  const g = await ctl.getGenerator();
  assert.equal(g.model, 'gemini-2.5-pro');
  assert.equal(ctl.getSnapshot().model, 'gemini-2.5-pro');
});

test('getGenerator: broken → AuthBrokenError with hint', async () => {
  const { deps } = fakeDeps({ probeCreds: async () => ({ ok: false }) });
  const ctl = createAuthController(deps);
  await ctl.init();
  await assert.rejects(
    () => ctl.getGenerator(),
    (err: Error) => err.name === 'AuthBrokenError',
  );
});

test('probe: failure emits probeFailed but does not change state by itself', async () => {
  let ok = true;
  const { deps } = fakeDeps({
    probeCreds: async () => ok ? { ok: true, expiresAt: 1 } : { ok: false, reason: 'expired' },
  });
  const ctl = createAuthController(deps);
  const events: AuthEvent[] = [];
  ctl.on((e) => events.push(e));
  await ctl.init();
  ok = false;
  const r = await ctl.probe();
  assert.equal(r.ok, false);
  assert.ok(events.find((e) => e.type === 'probeFailed'));
  assert.equal(ctl.getState(), 'valid');
});
