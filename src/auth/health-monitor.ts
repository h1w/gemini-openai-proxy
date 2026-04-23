import type { AuthController } from './auth-controller';

export interface HealthSnapshot {
  window: { ok: number; fail: number; windowMs: number };
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastFailureReason?: string;
  recentErrors: Array<{ at: number; label: string; status?: number; message: string }>;
  probeLastOkAt?: number;
  probeLastFailAt?: number;
  probeLastFailReason?: string;
}

export interface HealthMonitor {
  onSuccess(label: string, latencyMs: number): void;
  onFailure(label: string, err: unknown): void;
  getSnapshot(): HealthSnapshot;
  pingGemini(): Promise<{ ok: boolean; latencyMs: number; error?: string }>;
  start(): void;
  stop(): void;
}

type ControllerPort = Pick<AuthController, 'getState' | 'probe' | 'reportAuthFailure' | 'getGenerator' | 'on'>;

export interface HealthMonitorDeps {
  controller: ControllerPort;
  windowMs?: number;
  probeIntervalMs?: number;
  maxConsecutiveTransportFailures?: number;
  now?: () => number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  logger?: { log: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}


function looksLikeAuthError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { status?: number; code?: number | string; message?: string };
  if (e.status === 401 || e.status === 403 || e.code === 401) return true;
  const msg = (e.message ?? '').toLowerCase();
  return (
    msg.includes('invalid_grant') ||
    msg.includes('invalid_token') ||
    msg.includes('unauthorized') ||
    msg.includes('permission_denied')
  );
}

export function createHealthMonitor(deps: HealthMonitorDeps): HealthMonitor {
  const now = deps.now ?? Date.now;
  const setIntervalFn = deps.setIntervalFn ?? setInterval;
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  const windowMs = deps.windowMs ?? 15 * 60 * 1000;
  const probeIntervalMs = deps.probeIntervalMs ?? 10 * 60 * 1000;
  const maxTransportFails = deps.maxConsecutiveTransportFailures ?? 3;
  const logger = deps.logger ?? console;

  type WinEntry = { at: number; ok: boolean };
  const win: WinEntry[] = [];
  const trimWin = () => {
    const cutoff = now() - windowMs;
    while (win.length && win[0].at < cutoff) win.shift();
  };

  let lastSuccessAt: number | undefined;
  let lastFailureAt: number | undefined;
  let lastFailureReason: string | undefined;
  const recentErrors: HealthSnapshot['recentErrors'] = [];

  let probeLastOkAt: number | undefined;
  let probeLastFailAt: number | undefined;
  let probeLastFailReason: string | undefined;
  let consecutiveTransportFails = 0;

  const unsubscribeController = deps.controller.on((e) => {
    if (e.type === 'stateChange' && e.to !== 'valid') {
      consecutiveTransportFails = 0;
    }
  });

  let intervalId: ReturnType<typeof setIntervalFn> | null = null;

  async function runProbeTick() {
    if (deps.controller.getState() !== 'valid') return;
    try {
      const r = await deps.controller.probe();
      if (r.ok) {
        probeLastOkAt = now();
        consecutiveTransportFails = 0;
      } else {
        probeLastFailAt = now();
        probeLastFailReason = r.reason;
        if (looksLikeAuthError({ message: r.reason })) {
          deps.controller.reportAuthFailure(new Error(r.reason ?? 'probe auth fail'));
          consecutiveTransportFails = 0;
        } else {
          consecutiveTransportFails += 1;
          if (consecutiveTransportFails >= maxTransportFails) {
            deps.controller.reportAuthFailure(
              new Error(`probe failed ${consecutiveTransportFails} times in a row: ${r.reason}`),
            );
            consecutiveTransportFails = 0;
          }
        }
      }
    } catch (e) {
      logger.error('probe tick threw:', e);
    }
  }

  return {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    onSuccess(_label, _latencyMs) {
      trimWin();
      win.push({ at: now(), ok: true });
      lastSuccessAt = now();
    },
    onFailure(label, err) {
      trimWin();
      win.push({ at: now(), ok: false });
      lastFailureAt = now();
      const e = err as { message?: string; status?: number };
      lastFailureReason = e?.message ?? String(err);
      recentErrors.push({
        at: now(),
        label,
        status: e?.status,
        message: (e?.message ?? String(err)).slice(0, 400),
      });
      while (recentErrors.length > 10) recentErrors.shift();

      if (looksLikeAuthError(err)) {
        deps.controller.reportAuthFailure(err);
      }
    },
    getSnapshot() {
      trimWin();
      const ok = win.filter((e) => e.ok).length;
      const fail = win.length - ok;
      return {
        window: { ok, fail, windowMs },
        lastSuccessAt,
        lastFailureAt,
        lastFailureReason,
        recentErrors: [...recentErrors],
        probeLastOkAt,
        probeLastFailAt,
        probeLastFailReason,
      };
    },
    async pingGemini() {
      const started = now();
      try {
        const { generator } = await deps.controller.getGenerator();
        const g = generator as { countTokens: (req: unknown) => Promise<{ totalTokens?: number }> };
        await g.countTokens({
          contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
        });
        return { ok: true, latencyMs: now() - started };
      } catch (e: unknown) {
        return {
          ok: false,
          latencyMs: now() - started,
          error: (e as Error)?.message ?? String(e),
        };
      }
    },
    start() {
      if (intervalId) return;
      intervalId = setIntervalFn(runProbeTick, probeIntervalMs);
    },
    stop() {
      if (intervalId) { clearIntervalFn(intervalId); intervalId = null; }
      unsubscribeController();
    },
  };
}
