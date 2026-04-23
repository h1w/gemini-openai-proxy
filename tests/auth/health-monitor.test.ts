import test from 'node:test';
import assert from 'node:assert/strict';
import { createHealthMonitor } from '../../src/auth/health-monitor';

function fakeDeps(overrides: Record<string, unknown> = {}) {
  let now = 1_000_000;
  const intervals: Array<{ id: number; every: number; nextAt: number; fn: () => void }> = [];
  let nextId = 1;

  const setIntervalFn = ((fn: () => void, ms: number) => {
    const id = nextId++;
    intervals.push({ id, every: ms, nextAt: now + ms, fn });
    return id as unknown as NodeJS.Timeout;
  }) as typeof setInterval;

  const clearIntervalFn = ((id: unknown) => {
    const idx = intervals.findIndex((t) => t.id === id);
    if (idx >= 0) intervals.splice(idx, 1);
  }) as typeof clearInterval;

  let reportAuthFailureCount = 0;
  let probeCount = 0;
  let probeReturn: { ok: boolean; reason?: string } = { ok: true };
  const events: unknown[] = [];

  const controllerStub = {
    getState: () => 'valid' as const,
    probe: async () => { probeCount++; return probeReturn; },
    reportAuthFailure: () => { reportAuthFailureCount++; },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    on: (_l: unknown) => () => {},
    getGenerator: async () => ({
      generator: {
        countTokens: async () => ({ totalTokens: 3 }),
      },
      model: 'gemini-2.5-pro',
    }),
  };

  const advance = (ms: number) => {
    now += ms;
    for (const t of intervals.slice()) {
      while (t.nextAt <= now) {
        t.fn();
        t.nextAt += t.every;
      }
    }
  };

  const deps = {
    controller: controllerStub,
    windowMs: 15 * 60 * 1000,
    probeIntervalMs: 10 * 60 * 1000,
    maxConsecutiveTransportFailures: 3,
    now: () => now,
    setIntervalFn,
    clearIntervalFn,
    ...overrides,
  };

  return {
    deps,
    advance,
    getProbeCount: () => probeCount,
    setProbeReturn: (r: { ok: boolean; reason?: string }) => { probeReturn = r; },
    getReportCount: () => reportAuthFailureCount,
    events,
  };
}

test('passive: onSuccess / onFailure update sliding window counters', () => {
  const { deps } = fakeDeps();
  const mon = createHealthMonitor(deps);
  mon.onSuccess('chat', 120);
  mon.onSuccess('chat', 130);
  mon.onFailure('chat', new Error('500 bad gateway'));
  const s = mon.getSnapshot();
  assert.equal(s.window.ok, 2);
  assert.equal(s.window.fail, 1);
});

test('passive: auth-ish failure escalates to controller.reportAuthFailure', () => {
  const { deps, getReportCount } = fakeDeps();
  const mon = createHealthMonitor(deps);
  const e: Error & { status?: number } = Object.assign(new Error('Unauthorized'), { status: 401 });
  mon.onFailure('chat', e);
  assert.equal(getReportCount(), 1);
});

test('passive: non-auth failure does NOT escalate', () => {
  const { deps, getReportCount } = fakeDeps();
  const mon = createHealthMonitor(deps);
  const e: Error & { status?: number } = Object.assign(new Error('Too many'), { status: 429 });
  mon.onFailure('chat', e);
  assert.equal(getReportCount(), 0);
});

test('active probe runs on interval when state is valid', async () => {
  const { deps, advance, getProbeCount } = fakeDeps();
  const mon = createHealthMonitor(deps);
  mon.start();
  assert.equal(getProbeCount(), 0);
  advance(10 * 60 * 1000);
  await new Promise((r) => setImmediate(r));
  assert.equal(getProbeCount(), 1);
  mon.stop();
});

test('active probe skipped when state is not valid', async () => {
  const { deps, advance, getProbeCount } = fakeDeps({
    controller: {
      getState: () => 'pending',
      probe: async () => ({ ok: true }),
      reportAuthFailure: () => {},
      on: () => () => {},
      getGenerator: async () => { throw new Error('not valid'); },
    },
  });
  const mon = createHealthMonitor(deps);
  mon.start();
  advance(10 * 60 * 1000);
  await new Promise((r) => setImmediate(r));
  assert.equal(getProbeCount(), 0);
  mon.stop();
});

test('pingGemini: happy path returns ok + latency', async () => {
  const { deps } = fakeDeps();
  const mon = createHealthMonitor(deps);
  const r = await mon.pingGemini();
  assert.equal(r.ok, true);
  assert.equal(typeof r.latencyMs, 'number');
});

test('pingGemini: generator throws → ok=false', async () => {
  const { deps } = fakeDeps({
    controller: {
      getState: () => 'broken',
      probe: async () => ({ ok: false }),
      reportAuthFailure: () => {},
      on: () => () => {},
      getGenerator: async () => { throw new Error('broken'); },
    },
  });
  const mon = createHealthMonitor(deps);
  const r = await mon.pingGemini();
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /broken/);
});

test('active probe: 3 consecutive transport failures escalate to reportAuthFailure', async () => {
  let reportCount = 0;
  const controllerStub = {
    getState: () => 'valid' as const,
    probe: async () => ({ ok: false, reason: 'ETIMEDOUT network unreachable' }),
    reportAuthFailure: () => { reportCount++; },
    on: () => () => {},
    getGenerator: async () => ({ generator: { countTokens: async () => ({}) }, model: 'x' }),
  };
  const { deps, advance } = fakeDeps({ controller: controllerStub });
  const mon = createHealthMonitor(deps);
  mon.start();
  advance(10 * 60 * 1000);
  await new Promise((r) => setImmediate(r));
  assert.equal(reportCount, 0);
  advance(10 * 60 * 1000);
  await new Promise((r) => setImmediate(r));
  assert.equal(reportCount, 0);
  advance(10 * 60 * 1000);
  await new Promise((r) => setImmediate(r));
  assert.equal(reportCount, 1);
  mon.stop();
});

test('active probe: auth-signal failure escalates immediately on first probe', async () => {
  let reportCount = 0;
  const controllerStub = {
    getState: () => 'valid' as const,
    probe: async () => ({ ok: false, reason: 'invalid_grant: token revoked' }),
    reportAuthFailure: () => { reportCount++; },
    on: () => () => {},
    getGenerator: async () => ({ generator: { countTokens: async () => ({}) }, model: 'x' }),
  };
  const { deps, advance } = fakeDeps({ controller: controllerStub });
  const mon = createHealthMonitor(deps);
  mon.start();
  advance(10 * 60 * 1000);
  await new Promise((r) => setImmediate(r));
  assert.equal(reportCount, 1);
  mon.stop();
});

test('transport-fail counter resets when state leaves valid (I5)', async () => {
  // Controller that reports valid, then goes pending, then back to valid; probe always fails transport.
  let reportCount = 0;
  let currentState: 'valid' | 'pending' = 'valid';
  type AuthEventLite = { type: 'stateChange'; to: 'valid' | 'pending' };
  const listeners: Array<(e: AuthEventLite) => void> = [];
  const controllerStub = {
    getState: () => currentState,
    probe: async () => ({ ok: false, reason: 'ETIMEDOUT' }),
    reportAuthFailure: () => { reportCount++; },
    on: (l: (e: AuthEventLite) => void) => { listeners.push(l); return () => {}; },
    getGenerator: async () => ({ generator: { countTokens: async () => ({}) }, model: 'x' }),
  };
  const { deps, advance } = fakeDeps({ controller: controllerStub });
  const mon = createHealthMonitor(deps);
  mon.start();

  // Probe 1 + 2 fail (count=2), state stays valid.
  advance(10 * 60 * 1000);
  await new Promise((r) => setImmediate(r));
  advance(10 * 60 * 1000);
  await new Promise((r) => setImmediate(r));
  assert.equal(reportCount, 0);

  // State leaves valid → controller emits stateChange → counter resets.
  currentState = 'pending';
  for (const l of listeners) l({ type: 'stateChange', to: 'pending' });

  // Back to valid.
  currentState = 'valid';
  for (const l of listeners) l({ type: 'stateChange', to: 'valid' });

  // Probe 3 fails — would be the escalation WITHOUT reset; with reset it's just probe#1 again.
  advance(10 * 60 * 1000);
  await new Promise((r) => setImmediate(r));
  assert.equal(reportCount, 0, 'counter should have been reset when state left valid');

  mon.stop();
});
