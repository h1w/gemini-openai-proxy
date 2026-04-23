// src/auth/auth-controller.ts
// Single source of truth for auth state. See docs/superpowers/specs/
// 2026-04-23-telegram-auth-bot-design.md §4.

import type { OAuth2Client } from 'google-auth-library';
import {
  buildAuthUrl as realBuildAuthUrl,
  exchangeCode as realExchangeCode,
  fetchGoogleAccountId,
  loadUpstreamOauthClientCredentials,
  writeCredentials,
  writeGoogleAccountId,
  deleteCachedCredentials,
  getCachedCredentialPath,
  getGoogleAccountIdCachePath,
  probeCachedCredentials,
} from './oauth-flow';
import {
  AuthBrokenError,
  NoPendingLoginError,
  OAuthNotSupportedError,
  StateMismatchError,
} from './errors';
import { extractOauthCallback } from '../telegram/url-extractor';
import * as crypto from 'node:crypto';

export type AuthState = 'idle' | 'valid' | 'pending' | 'broken';

export type AuthEvent =
  | { type: 'stateChange'; from: AuthState; to: AuthState; reason: string }
  | { type: 'loginStarted'; authUrl: string; expiresAt: number }
  | { type: 'loginCompleted' }
  | { type: 'loginFailed'; reason: string }
  | { type: 'probeFailed'; reason: string };

export interface AuthSnapshot {
  state: AuthState;
  authType: string;
  model?: string;
  tokenExpiresAt?: number;
  hasRefreshToken?: boolean;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastFailureReason?: string;
  callbackServerReady?: boolean;
}

export type LoginTrigger = 'startup' | 'telegram' | 'probe' | 'passive';

export interface GeneratorHandle {
  generator: unknown;
  model: string;
}

export interface AuthControllerDeps {
  authType: string;
  callbackPort: number;
  modelOverride?: string;
  pendingTimeoutMs?: number;
  debounceMs?: number;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  loadClientCreds?: () => Promise<{ clientId: string; clientSecret: string }>;
  credsPath?: string;
  accountIdPath?: string;
  createGenerator?: (authType: string, model?: string) => Promise<GeneratorHandle>;
  buildAuthUrl?: (args: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    state: string;
  }) => string;
  exchangeCode?: (args: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    code: string;
  }) => Promise<{ credentials: unknown; client: OAuth2Client }>;
  fetchAccountId?: (client: OAuth2Client) => Promise<string | null>;
  writeCreds?: (path: string, creds: unknown) => Promise<void>;
  deleteCreds?: (path: string) => Promise<void>;
  writeAccountId?: (path: string, id: string) => Promise<void>;
  probeCreds?: (
    credsPath: string,
    clientId: string,
    clientSecret: string,
  ) => Promise<{ ok: boolean; reason?: string; expiresAt?: number; hasRefreshToken?: boolean }>;
  randomState?: () => string;
  logger?: { log: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}

export interface AuthController {
  getState(): AuthState;
  getSnapshot(): AuthSnapshot;
  setCallbackServerReady(ready: boolean): void;
  startLogin(trigger: LoginTrigger): Promise<{ authUrl: string }>;
  completeLoginWithCode(code: string, state: string): Promise<void>;
  submitCallbackUrl(rawUrl: string): Promise<void>;
  logout(): Promise<void>;
  probe(): Promise<{ ok: boolean; reason?: string }>;
  reportAuthFailure(err: unknown): void;
  getGenerator(): Promise<GeneratorHandle>;
  on(listener: (e: AuthEvent) => void): () => void;
  init(options?: { autoStartLoginIfBroken?: boolean }): Promise<void>;
  dispose(): void;
}

export function createAuthController(deps: AuthControllerDeps): AuthController {
  const now = deps.now ?? (() => Date.now());
  const setT = deps.setTimeoutFn ?? setTimeout;
  const clearT = deps.clearTimeoutFn ?? clearTimeout;
  const credsPath = deps.credsPath ?? getCachedCredentialPath();
  const accountIdPath = deps.accountIdPath ?? getGoogleAccountIdCachePath();
  const pendingTimeoutMs = deps.pendingTimeoutMs ?? 10 * 60 * 1000;
  const debounceMs = deps.debounceMs ?? 5000;
  const loadClientCreds = deps.loadClientCreds ?? loadUpstreamOauthClientCredentials;
  const createGeneratorFn = deps.createGenerator;
  const buildAuthUrl = deps.buildAuthUrl ?? realBuildAuthUrl;
  const exchangeCode = deps.exchangeCode ?? realExchangeCode;
  const fetchAccountId = deps.fetchAccountId ?? fetchGoogleAccountId;
  const writeCreds = deps.writeCreds ?? writeCredentials;
  const deleteCreds = deps.deleteCreds ?? deleteCachedCredentials;
  const writeAccountId = deps.writeAccountId ?? writeGoogleAccountId;
  const probeCreds = deps.probeCreds ?? probeCachedCredentials;
  const randomState = deps.randomState ?? (() => crypto.randomBytes(32).toString('hex'));
  const logger = deps.logger ?? console;

  let state: AuthState = 'idle';
  let callbackServerReady: boolean | undefined = undefined;
  const snapshot: AuthSnapshot = {
    state,
    authType: deps.authType,
    model: deps.modelOverride,
  };

  interface Pending {
    stateToken: string;
    authUrl: string;
    startedAt: number;
    timeoutId: unknown;
  }
  let pending: Pending | null = null;
  let generator: GeneratorHandle | null = null;

  const listeners = new Set<(e: AuthEvent) => void>();

  function emit(e: AuthEvent) {
    for (const l of [...listeners]) {
      try { l(e); } catch (err) { logger.error('AuthController listener threw:', err); }
    }
  }

  function setState(next: AuthState, reason: string) {
    if (state === next) return;
    const prev = state;
    state = next;
    snapshot.state = next;
    emit({ type: 'stateChange', from: prev, to: next, reason });
  }

  async function initialProbeAndStateAssignment(): Promise<void> {
    if (deps.authType !== 'oauth-personal') {
      setState('valid', 'non-oauth auth type');
      return;
    }
    try {
      const clientCreds = await loadClientCreds();
      const res = await probeCreds(credsPath, clientCreds.clientId, clientCreds.clientSecret);
      if (res.ok) {
        snapshot.tokenExpiresAt = res.expiresAt;
        snapshot.hasRefreshToken = res.hasRefreshToken;
        setState('valid', 'cached creds valid');
      } else {
        snapshot.lastFailureReason = res.reason;
        snapshot.lastFailureAt = now();
        setState('broken', res.reason ?? 'no valid cached creds');
      }
    } catch (e: unknown) {
      const msg = (e as Error).message ?? String(e);
      snapshot.lastFailureReason = msg;
      setState('broken', `init probe threw: ${msg}`);
    }
  }

  return {
    getState: () => state,
    getSnapshot: () => ({ ...snapshot, callbackServerReady }),
    setCallbackServerReady(ready: boolean) { callbackServerReady = ready; },
    on(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async init(options?: { autoStartLoginIfBroken?: boolean }) {
      await initialProbeAndStateAssignment();
      if (options?.autoStartLoginIfBroken && state === 'broken' && deps.authType === 'oauth-personal') {
        await this.startLogin('startup').catch((err) =>
          logger.error('auto startLogin failed:', err),
        );
      }
    },
    dispose() {
      if (pending?.timeoutId) clearT(pending.timeoutId as Parameters<typeof clearT>[0]);
      pending = null;
      generator = null;
      listeners.clear();
    },
    async startLogin(trigger) {
      if (deps.authType !== 'oauth-personal') {
        throw new OAuthNotSupportedError(
          'OAuth login is only supported when AUTH_TYPE=oauth-personal',
        );
      }
      if (pending && state === 'pending') {
        const age = now() - pending.startedAt;
        if (age < debounceMs) {
          return { authUrl: pending.authUrl };
        }
        clearT(pending.timeoutId as Parameters<typeof clearT>[0]);
        pending = null;
      }

      const { clientId, clientSecret } = await loadClientCreds();
      const stateToken = randomState();
      const redirectUri = `http://localhost:${deps.callbackPort}/oauth2callback`;
      const authUrl = buildAuthUrl({ clientId, clientSecret, redirectUri, state: stateToken });
      const startedAt = now();
      const timeoutId = setT(() => {
        if (pending?.stateToken === stateToken && state === 'pending') {
          pending = null;
          snapshot.lastFailureReason = 'login expired';
          snapshot.lastFailureAt = now();
          setState('broken', 'pending session expired');
          emit({ type: 'loginFailed', reason: 'login expired (10 min)' });
        }
      }, pendingTimeoutMs);
      pending = { stateToken, authUrl, startedAt, timeoutId };
      setState('pending', `login triggered by ${trigger}`);
      emit({ type: 'loginStarted', authUrl, expiresAt: startedAt + pendingTimeoutMs });
      return { authUrl };
    },
    async completeLoginWithCode(code, stateParam) {
      if (!pending) throw new NoPendingLoginError('no active login session');
      if (pending.stateToken !== stateParam) {
        throw new StateMismatchError('state token mismatch');
      }
      const currentPending = pending; // capture for cleanup on error
      try {
        const { clientId, clientSecret } = await loadClientCreds();
        const redirectUri = `http://localhost:${deps.callbackPort}/oauth2callback`;
        const { credentials, client } = await exchangeCode({ clientId, clientSecret, redirectUri, code });
        await writeCreds(credsPath, credentials);
        try {
          const id = await fetchAccountId(client);
          if (id) await writeAccountId(accountIdPath, id);
        } catch (e) {
          logger.error('fetchAccountId failed:', e);
        }
        clearT(currentPending.timeoutId as Parameters<typeof clearT>[0]);
        pending = null;
        snapshot.tokenExpiresAt = (credentials as { expiry_date?: number })?.expiry_date;
        snapshot.hasRefreshToken = !!(credentials as { refresh_token?: string })?.refresh_token;
        snapshot.lastSuccessAt = now();
        setState('valid', 'login completed');
        emit({ type: 'loginCompleted' });
      } catch (e: unknown) {
        // StateMismatch/NoPendingLogin are thrown above this try; any other
        // error here (including loadClientCreds, writeCreds, exchangeCode)
        // means the login attempt is dead — clear pending, move to broken.
        const msg = (e as Error).message ?? String(e);
        snapshot.lastFailureReason = msg;
        snapshot.lastFailureAt = now();
        if (pending === currentPending) {
          clearT(currentPending.timeoutId as Parameters<typeof clearT>[0]);
          pending = null;
        }
        setState('broken', `code exchange failed: ${msg}`);
        emit({ type: 'loginFailed', reason: msg });
        throw e;
      }
    },
    async submitCallbackUrl(rawUrl) {
      const { code, state: stateParam } = extractOauthCallback(rawUrl);
      await this.completeLoginWithCode(code, stateParam);
    },
    async logout() {
      if (pending) {
        clearT(pending.timeoutId as Parameters<typeof clearT>[0]);
        pending = null;
      }
      generator = null;
      setState('broken', 'logout');
      await deleteCreds(credsPath);
    },
    async probe() {
      if (deps.authType !== 'oauth-personal') return { ok: true };
      try {
        const { clientId, clientSecret } = await loadClientCreds();
        const res = await probeCreds(credsPath, clientId, clientSecret);
        if (!res.ok) {
          emit({ type: 'probeFailed', reason: res.reason ?? 'unknown' });
        }
        return res;
      } catch (e: unknown) {
        const msg = (e as Error).message ?? String(e);
        emit({ type: 'probeFailed', reason: msg });
        return { ok: false, reason: msg };
      }
    },
    reportAuthFailure(err) {
      const msg = (err as Error)?.message ?? String(err);
      snapshot.lastFailureReason = msg;
      snapshot.lastFailureAt = now();
      generator = null;
      if (state === 'valid') {
        setState('broken', `auth failure: ${msg}`);
      }
    },
    async getGenerator() {
      if (state !== 'valid') {
        throw new AuthBrokenError(
          'Gemini auth is not active',
          deps.authType === 'oauth-personal'
            ? `authenticate via Telegram bot or open http://host:${deps.callbackPort}/oauth2callback?...`
            : 'check AUTH_TYPE / GEMINI_API_KEY',
        );
      }
      if (!generator) {
        if (!createGeneratorFn) throw new Error('createGenerator dep not provided');
        generator = await createGeneratorFn(deps.authType, deps.modelOverride);
        snapshot.model = generator.model;
        snapshot.lastSuccessAt = now();
      }
      return generator;
    },
  };
}
