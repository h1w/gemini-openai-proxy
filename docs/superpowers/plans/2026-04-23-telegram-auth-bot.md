# Telegram Auth & Health Bot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional Telegram bot that can drive the `oauth-personal` login flow (both via port 8085 and via pasting the callback URL into Telegram), actively monitors Gemini auth and health, and exposes utility commands to a single operator.

**Architecture:** A new `AuthController` owns a state machine (`idle | valid | pending | broken`) and is the single source of truth for authentication. A long-lived HTTP server on `OAUTH_CALLBACK_PORT` (oauth-personal only) and the Telegram bot both feed back into that controller. A `HealthMonitor` subscribes passively to every Gemini call and also runs a 10-minute token probe. `chatwrapper` asks the controller for a live generator and fail-fasts with 503 when auth is broken. The Telegram module is optional — both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_USER_ID` must be set.

**Tech Stack:** Node.js, TypeScript (ES2020 / CommonJS), `grammy` for Telegram long-polling, `google-auth-library` (already transitive) for OAuth, `@google/gemini-cli-core` for the content generator. Tests use Node's built-in `node:test` + `node:assert/strict` with `ts-node/register`.

**Spec:** `docs/superpowers/specs/2026-04-23-telegram-auth-bot-design.md`

---

## File Map

**New files:**
- `src/auth/errors.ts` — shared error classes (`AuthBrokenError`, `InvalidCallbackUrlError`, `NoPendingLoginError`, `StateMismatchError`).
- `src/auth/oauth-flow.ts` — pure helpers: load upstream client id/secret, write creds, fetch account id, check cached creds, build authUrl, exchange code for tokens.
- `src/auth/auth-controller.ts` — the state machine. Injectable deps (clock, fs, OAuth2Client factory, generator factory).
- `src/auth/callback-server.ts` — long-lived HTTP on `OAUTH_CALLBACK_PORT`, routes `/oauth2callback` to the controller.
- `src/auth/health-monitor.ts` — passive counters, 10-min active probe, `pingGemini()`.
- `src/telegram/url-extractor.ts` — pure function: parse `code`/`state` out of arbitrary user text.
- `src/telegram/formatters.ts` — pure message/keyboard renderers.
- `src/telegram/access-control.ts` — grammy middleware restricting to one user.
- `src/telegram/bot.ts` — grammy bot setup, command handlers, event wiring.

**Modified files:**
- `src/chatwrapper.ts` — drop module-level `generatorPromise`; fetch generator from `AuthController`; instrument calls with `HealthMonitor`.
- `src/server.ts` — wire everything together at startup; map `AuthBrokenError → 503`; make `/health` and `/v1/models` work pre-login.
- `package.json` — add `grammy` dep; add test script.
- `README.md` — document new env vars and the paste-URL flow.
- `Dockerfile` — comment about optional 8085 exposure.
- `.gitignore` — nothing new expected; verify.

**Deleted files:**
- `src/oauth-preflight.ts` — superseded by `src/auth/*`.

**Test files:**
- `tests/auth/oauth-flow.test.ts`
- `tests/auth/auth-controller.test.ts`
- `tests/auth/callback-server.test.ts`
- `tests/auth/health-monitor.test.ts`
- `tests/telegram/url-extractor.test.ts`

---

## Task 0: Project setup — test infrastructure and dependencies

**Files:**
- Modify: `package.json`
- Create: `tests/.gitkeep` (placeholder, optional)

- [ ] **Step 0.1: Add grammy dependency and test script**

Open `package.json`. The current contents are:

```json
{
  "name": "gcli_oai_proxy",
  "version": "1.0.0",
  "main": "index.js",
  "scripts": {
    "start": "ts-node src/server.ts",
    "test": "echo \"Error: no test specified\" && exit 1"
  },
  "keywords": [],
  "author": "",
  "license": "ISC",
  "description": "",
  "dependencies": {
    "@google/gemini-cli": "^0.1.5"
  },
  "devDependencies": {
    "@eslint/js": "^9.30.1",
    "@stylistic/eslint-plugin": "^5.1.0",
    "@types/node": "^24.0.4",
    "@typescript-eslint/eslint-plugin": "^8.35.1",
    "@typescript-eslint/parser": "^8.35.1",
    "eslint": "^9.30.1",
    "ts-node": "^10.9.2",
    "typescript": "^5.8.3",
    "typescript-eslint": "^8.35.1"
  }
}
```

Replace with:

```json
{
  "name": "gcli_oai_proxy",
  "version": "1.0.0",
  "main": "index.js",
  "scripts": {
    "start": "ts-node src/server.ts",
    "test": "node --require ts-node/register --test tests/**/*.test.ts",
    "lint": "eslint src tests"
  },
  "keywords": [],
  "author": "",
  "license": "ISC",
  "description": "",
  "dependencies": {
    "@google/gemini-cli": "^0.1.5",
    "google-auth-library": "^9.0.0",
    "grammy": "^1.24.0"
  },
  "devDependencies": {
    "@eslint/js": "^9.30.1",
    "@stylistic/eslint-plugin": "^5.1.0",
    "@types/node": "^24.0.4",
    "@typescript-eslint/eslint-plugin": "^8.35.1",
    "@typescript-eslint/parser": "^8.35.1",
    "eslint": "^9.30.1",
    "ts-node": "^10.9.2",
    "typescript": "^5.8.3",
    "typescript-eslint": "^8.35.1"
  }
}
```

(`google-auth-library` is listed explicitly because we import it directly; it was previously only transitive through `@google/gemini-cli-core`.)

- [ ] **Step 0.2: Install deps**

Run: `npm install`

Expected: both `grammy` and `google-auth-library` end up in `node_modules`.

- [ ] **Step 0.3: Smoke-check test runner**

Create `tests/smoke.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

test('test runner works', () => {
  assert.equal(1 + 1, 2);
});
```

Run: `npm test`
Expected: one passing test.

Delete the smoke test after it passes — it exists only to verify the runner:

```bash
rm tests/smoke.test.ts
```

- [ ] **Step 0.4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add grammy, explicit google-auth-library, node:test runner"
```

---

## Task 1: Shared error classes

**Files:**
- Create: `src/auth/errors.ts`
- Test: covered by usage in later tasks (too trivial for a dedicated test file).

- [ ] **Step 1.1: Create `src/auth/errors.ts`**

```ts
// Errors shared across auth and telegram modules.
//
// These are plain Error subclasses with stable `.name` values so callers
// can switch on them without instanceof coupling through barrels.

export class AuthBrokenError extends Error {
  readonly name = 'AuthBrokenError';
  readonly httpStatus = 503;
  readonly hint: string;

  constructor(message: string, hint: string) {
    super(message);
    this.hint = hint;
  }
}

export class NoPendingLoginError extends Error {
  readonly name = 'NoPendingLoginError';
}

export class StateMismatchError extends Error {
  readonly name = 'StateMismatchError';
}

export class InvalidCallbackUrlError extends Error {
  readonly name = 'InvalidCallbackUrlError';
}

export class OAuthNotSupportedError extends Error {
  readonly name = 'OAuthNotSupportedError';
}
```

- [ ] **Step 1.2: Commit**

```bash
git add src/auth/errors.ts
git commit -m "feat(auth): add shared error classes for auth module"
```

---

## Task 2: `url-extractor.ts` (pure — test-first)

**Files:**
- Create: `src/telegram/url-extractor.ts`
- Test: `tests/telegram/url-extractor.test.ts`

- [ ] **Step 2.1: Write the failing test**

Create `tests/telegram/url-extractor.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractOauthCallback } from '../../src/telegram/url-extractor';
import { InvalidCallbackUrlError } from '../../src/auth/errors';

test('extracts code and state from a full callback URL', () => {
  const url = 'http://localhost:8085/oauth2callback?code=abc123&state=xyz789';
  assert.deepEqual(extractOauthCallback(url), { code: 'abc123', state: 'xyz789' });
});

test('extracts from https host', () => {
  const url = 'https://example.com/oauth2callback?code=c&state=s';
  assert.deepEqual(extractOauthCallback(url), { code: 'c', state: 's' });
});

test('extracts when URL is surrounded by other text', () => {
  const text = 'here is the url: http://localhost:8085/oauth2callback?code=abc&state=xyz trailing';
  assert.deepEqual(extractOauthCallback(text), { code: 'abc', state: 'xyz' });
});

test('extracts from a bare query string (no host)', () => {
  assert.deepEqual(
    extractOauthCallback('code=abc&state=xyz'),
    { code: 'abc', state: 'xyz' },
  );
});

test('extracts even when params are url-encoded', () => {
  const url = 'http://localhost:8085/oauth2callback?code=a%2Fb%3Dc&state=d%26e';
  assert.deepEqual(extractOauthCallback(url), { code: 'a/b=c', state: 'd&e' });
});

test('accepts params in any order', () => {
  assert.deepEqual(
    extractOauthCallback('http://x/oauth2callback?state=xyz&code=abc'),
    { code: 'abc', state: 'xyz' },
  );
});

test('throws when code is missing', () => {
  assert.throws(
    () => extractOauthCallback('http://x/oauth2callback?state=xyz'),
    (err: Error) => err.name === 'InvalidCallbackUrlError',
  );
});

test('throws when state is missing', () => {
  assert.throws(
    () => extractOauthCallback('http://x/oauth2callback?code=abc'),
    InvalidCallbackUrlError,
  );
});

test('throws on completely unrelated text', () => {
  assert.throws(
    () => extractOauthCallback('hello world'),
    InvalidCallbackUrlError,
  );
});

test('throws on empty string', () => {
  assert.throws(() => extractOauthCallback(''), InvalidCallbackUrlError);
});

test('ignores duplicate code params by taking the first', () => {
  // URLSearchParams.get() returns the first — document that behavior.
  assert.deepEqual(
    extractOauthCallback('code=first&code=second&state=s'),
    { code: 'first', state: 's' },
  );
});
```

- [ ] **Step 2.2: Run test — expect failure**

Run: `npm test`
Expected: fails with "Cannot find module '../../src/telegram/url-extractor'".

- [ ] **Step 2.3: Minimal implementation**

Create `src/telegram/url-extractor.ts`:

```ts
import { InvalidCallbackUrlError } from '../auth/errors';

export interface OauthCallback {
  code: string;
  state: string;
}

// Accept three shapes:
//   1) a full http(s) URL with /oauth2callback and ?code=&state=
//   2) a bare query string "code=...&state=..."
//   3) either of the above embedded in arbitrary text
//
// Strategy: scan for the first occurrence of code=... and state=... in the
// input, build a URLSearchParams from that span, then read both values.
export function extractOauthCallback(text: string): OauthCallback {
  if (!text || typeof text !== 'string') {
    throw new InvalidCallbackUrlError('empty or non-string input');
  }

  // Try: full URL with a query string.
  const urlMatch = text.match(/https?:\/\/\S+/i);
  const queryTail = urlMatch ? urlMatch[0].split('?')[1] : undefined;

  // Fallback: any substring that looks like key=value&... containing code and state.
  const fallback = text.match(/[?&]?(?:code|state)=[^\s&]+(?:&[^\s&]+=[^\s&]+)*/i)?.[0]
    ?.replace(/^[?&]/, '');

  const candidate = queryTail ?? fallback ?? text;

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(candidate);
  } catch {
    throw new InvalidCallbackUrlError('could not parse URL params');
  }

  const code = params.get('code');
  const state = params.get('state');

  if (!code) throw new InvalidCallbackUrlError('missing `code` param');
  if (!state) throw new InvalidCallbackUrlError('missing `state` param');

  return { code, state };
}
```

- [ ] **Step 2.4: Run test — expect pass**

Run: `npm test`
Expected: all 11 tests pass.

- [ ] **Step 2.5: Commit**

```bash
git add src/telegram/url-extractor.ts tests/telegram/url-extractor.test.ts
git commit -m "feat(telegram): add lenient parser for pasted OAuth callback URLs"
```

---

## Task 3: `oauth-flow.ts` — extract pure helpers from existing preflight

**Files:**
- Create: `src/auth/oauth-flow.ts`
- Test: `tests/auth/oauth-flow.test.ts`

- [ ] **Step 3.1: Write the failing test**

Create `tests/auth/oauth-flow.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';
import {
  getCachedCredentialPath,
  getGoogleAccountIdCachePath,
  writeCredentials,
  writeGoogleAccountId,
  buildAuthUrl,
  OAUTH_SCOPE,
  SIGN_IN_SUCCESS_URL,
  SIGN_IN_FAILURE_URL,
} from '../../src/auth/oauth-flow';

test('getCachedCredentialPath returns ~/.gemini/oauth_creds.json', () => {
  assert.equal(
    getCachedCredentialPath(),
    path.join(os.homedir(), '.gemini', 'oauth_creds.json'),
  );
});

test('getGoogleAccountIdCachePath returns ~/.gemini/google_account_id', () => {
  assert.equal(
    getGoogleAccountIdCachePath(),
    path.join(os.homedir(), '.gemini', 'google_account_id'),
  );
});

test('OAUTH_SCOPE has the three required scopes', () => {
  assert.deepEqual(OAUTH_SCOPE, [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
  ]);
});

test('sign-in URLs are the Google developer doc URLs', () => {
  assert.ok(SIGN_IN_SUCCESS_URL.includes('auth_success_gemini'));
  assert.ok(SIGN_IN_FAILURE_URL.includes('auth_failure_gemini'));
});

test('writeCredentials creates parent dir and writes JSON', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'oauthflow-'));
  const target = path.join(tmp, 'sub', 'creds.json');
  await writeCredentials(target, { access_token: 'a', refresh_token: 'b' });
  const on_disk = JSON.parse(await fs.readFile(target, 'utf-8'));
  assert.equal(on_disk.access_token, 'a');
  assert.equal(on_disk.refresh_token, 'b');
  await fs.rm(tmp, { recursive: true });
});

test('writeGoogleAccountId creates parent dir and writes plain text', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'oauthflow-'));
  const target = path.join(tmp, 'sub', 'id');
  await writeGoogleAccountId(target, '1234567890');
  const on_disk = await fs.readFile(target, 'utf-8');
  assert.equal(on_disk, '1234567890');
  await fs.rm(tmp, { recursive: true });
});

test('buildAuthUrl produces a URL with expected params', () => {
  const url = buildAuthUrl({
    clientId: 'CID.apps.googleusercontent.com',
    clientSecret: 'SECRET',
    redirectUri: 'http://localhost:8085/oauth2callback',
    state: 'deadbeef',
  });
  const parsed = new URL(url);
  assert.equal(parsed.hostname, 'accounts.google.com');
  assert.equal(parsed.searchParams.get('state'), 'deadbeef');
  assert.equal(parsed.searchParams.get('redirect_uri'), 'http://localhost:8085/oauth2callback');
  assert.equal(parsed.searchParams.get('client_id'), 'CID.apps.googleusercontent.com');
  assert.equal(parsed.searchParams.get('access_type'), 'offline');
  // scope is a space-separated string containing all three scopes
  const scope = parsed.searchParams.get('scope') ?? '';
  for (const s of OAUTH_SCOPE) assert.ok(scope.includes(s));
});
```

- [ ] **Step 3.2: Run test — expect failure**

Run: `npm test`
Expected: fails with "Cannot find module '../../src/auth/oauth-flow'".

- [ ] **Step 3.3: Implement `oauth-flow.ts`**

Create `src/auth/oauth-flow.ts`:

```ts
// Pure-ish helpers for the OAuth dance. No HTTP server here — that lives in
// callback-server.ts. No state — AuthController owns state.

import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';
import { OAuth2Client, Credentials } from 'google-auth-library';

export const OAUTH_SCOPE = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

export const SIGN_IN_SUCCESS_URL =
  'https://developers.google.com/gemini-code-assist/auth_success_gemini';
export const SIGN_IN_FAILURE_URL =
  'https://developers.google.com/gemini-code-assist/auth_failure_gemini';

const GEMINI_DIR = '.gemini';
const CREDENTIAL_FILENAME = 'oauth_creds.json';
const GOOGLE_ACCOUNT_ID_FILENAME = 'google_account_id';

export function getCachedCredentialPath(): string {
  return path.join(os.homedir(), GEMINI_DIR, CREDENTIAL_FILENAME);
}

export function getGoogleAccountIdCachePath(): string {
  return path.join(os.homedir(), GEMINI_DIR, GOOGLE_ACCOUNT_ID_FILENAME);
}

export async function loadUpstreamOauthClientCredentials(): Promise<{
  clientId: string;
  clientSecret: string;
}> {
  const envId = process.env.GEMINI_OAUTH_CLIENT_ID;
  const envSecret = process.env.GEMINI_OAUTH_CLIENT_SECRET;
  if (envId && envSecret) {
    return { clientId: envId, clientSecret: envSecret };
  }

  const upstreamPath = require.resolve(
    '@google/gemini-cli-core/dist/src/code_assist/oauth2.js',
  );
  const source = await fs.readFile(upstreamPath, 'utf-8');
  const idMatch = source.match(/OAUTH_CLIENT_ID\s*=\s*['"]([^'"]+)['"]/);
  const secretMatch = source.match(/OAUTH_CLIENT_SECRET\s*=\s*['"]([^'"]+)['"]/);
  if (!idMatch || !secretMatch) {
    throw new Error(
      'OAuth: could not extract installed-app credentials from ' +
        '@google/gemini-cli-core. Set GEMINI_OAUTH_CLIENT_ID and ' +
        'GEMINI_OAUTH_CLIENT_SECRET explicitly.',
    );
  }
  return { clientId: idMatch[1], clientSecret: secretMatch[1] };
}

export async function writeCredentials(
  filePath: string,
  credentials: Credentials | unknown,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(credentials, null, 2));
}

export async function writeGoogleAccountId(filePath: string, id: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, id, 'utf-8');
}

export async function readCachedCredentials(filePath: string): Promise<Credentials | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as Credentials;
  } catch {
    return null;
  }
}

export async function deleteCachedCredentials(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (e: unknown) {
    const code = (e as { code?: string }).code;
    if (code !== 'ENOENT') throw e;
  }
}

export function buildAuthUrl(args: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  state: string;
}): string {
  const client = new OAuth2Client({
    clientId: args.clientId,
    clientSecret: args.clientSecret,
  });
  return client.generateAuthUrl({
    redirect_uri: args.redirectUri,
    access_type: 'offline',
    scope: OAUTH_SCOPE,
    state: args.state,
  });
}

export async function exchangeCode(args: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<{ credentials: Credentials; client: OAuth2Client }> {
  const client = new OAuth2Client({
    clientId: args.clientId,
    clientSecret: args.clientSecret,
  });
  const { tokens } = await client.getToken({
    code: args.code,
    redirect_uri: args.redirectUri,
  });
  client.setCredentials(tokens);
  return { credentials: tokens, client };
}

export async function fetchGoogleAccountId(client: OAuth2Client): Promise<string | null> {
  try {
    const { token } = await client.getAccessToken();
    if (!token) return null;
    const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return null;
    const userInfo = (await response.json()) as { id?: string };
    return userInfo.id || null;
  } catch {
    return null;
  }
}

// Probe — no Gemini quota cost. Returns { ok, reason? }.
export async function probeCachedCredentials(
  credsFilePath: string,
  clientId: string,
  clientSecret: string,
): Promise<{ ok: boolean; reason?: string; expiresAt?: number; hasRefreshToken?: boolean }> {
  const creds = await readCachedCredentials(credsFilePath);
  if (!creds) return { ok: false, reason: 'no cached credentials' };

  try {
    const client = new OAuth2Client({ clientId, clientSecret });
    client.setCredentials(creds);
    const { token } = await client.getAccessToken();
    if (!token) return { ok: false, reason: 'no access token returned' };
    await client.getTokenInfo(token);
    return {
      ok: true,
      expiresAt: (creds as Credentials).expiry_date ?? undefined,
      hasRefreshToken: !!(creds as Credentials).refresh_token,
    };
  } catch (e: unknown) {
    const msg = (e as { message?: string })?.message ?? String(e);
    return { ok: false, reason: msg };
  }
}
```

- [ ] **Step 3.4: Run test — expect pass**

Run: `npm test`
Expected: all new tests pass (url-extractor tests still pass).

- [ ] **Step 3.5: Commit**

```bash
git add src/auth/oauth-flow.ts tests/auth/oauth-flow.test.ts
git commit -m "feat(auth): extract OAuth helpers into oauth-flow module"
```

---

## Task 4: `AuthController` — state machine (core)

**Files:**
- Create: `src/auth/auth-controller.ts`
- Test: `tests/auth/auth-controller.test.ts`

This task is larger — the controller has the bulk of the state logic. Keep steps small.

- [ ] **Step 4.1: Define types file — part of auth-controller.ts header**

We will build the controller test-first. Before any test, sketch the type surface we want. Create `src/auth/auth-controller.ts` with ONLY the types (no implementation yet):

```ts
// src/auth/auth-controller.ts
// Single source of truth for auth state. See docs/superpowers/specs/
// 2026-04-23-telegram-auth-bot-design.md §4.

import type { OAuth2Client } from 'google-auth-library';

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
  pendingTimeoutMs?: number; // default 10 * 60 * 1000
  debounceMs?: number;       // default 5000
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
  // Initialise: probe cached creds, transition to valid/broken, optionally auto-startLogin.
  init(options?: { autoStartLoginIfBroken?: boolean }): Promise<void>;
  dispose(): void;
}

export function createAuthController(_deps: AuthControllerDeps): AuthController {
  throw new Error('not implemented');
}
```

- [ ] **Step 4.2: Write the first test — constructor + init with valid cached creds**

Create `tests/auth/auth-controller.test.ts`:

```ts
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
  // For non-oauth auth types, controller treats auth as valid (chatwrapper
  // decides based on its own knowledge; the controller is only meaningful
  // for OAuth-personal).
  assert.equal(ctl.getState(), 'valid');
  assert.equal(probed, 0);
});
```

- [ ] **Step 4.3: Run — expect failure**

Run: `npm test`
Expected: test file compiles but tests throw "not implemented".

- [ ] **Step 4.4: Implement `init()` plus minimal shell**

Replace the body of `src/auth/auth-controller.ts`'s `createAuthController` with a real implementation:

```ts
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

  // pending session
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
      // For non-OAuth auth types the controller is essentially a no-op;
      // mark valid and let chatwrapper decide based on its own config.
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
      listeners.clear();
    },
    async startLogin(trigger) {
      if (deps.authType !== 'oauth-personal') {
        throw new OAuthNotSupportedError(
          'OAuth login is only supported when AUTH_TYPE=oauth-personal',
        );
      }
      // Debounce: second call within debounceMs while pending returns the
      // same authUrl with no new event.
      if (pending && state === 'pending') {
        const age = now() - pending.startedAt;
        if (age < debounceMs) {
          return { authUrl: pending.authUrl };
        }
        // else: expire the old one and regenerate
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
      const { clientId, clientSecret } = await loadClientCreds();
      const redirectUri = `http://localhost:${deps.callbackPort}/oauth2callback`;
      try {
        const { credentials, client } = await exchangeCode({ clientId, clientSecret, redirectUri, code });
        await writeCreds(credsPath, credentials);
        try {
          const id = await fetchAccountId(client);
          if (id) await writeAccountId(accountIdPath, id);
        } catch (e) {
          logger.error('fetchAccountId failed:', e);
        }
        clearT(pending.timeoutId as Parameters<typeof clearT>[0]);
        pending = null;
        snapshot.tokenExpiresAt = (credentials as { expiry_date?: number })?.expiry_date;
        snapshot.hasRefreshToken = !!(credentials as { refresh_token?: string })?.refresh_token;
        snapshot.lastSuccessAt = now();
        setState('valid', 'login completed');
        emit({ type: 'loginCompleted' });
      } catch (e: unknown) {
        const msg = (e as Error).message ?? String(e);
        snapshot.lastFailureReason = msg;
        snapshot.lastFailureAt = now();
        clearT(pending.timeoutId as Parameters<typeof clearT>[0]);
        pending = null;
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
      await deleteCreds(credsPath);
      setState('broken', 'logout');
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
```

- [ ] **Step 4.5: Run — expect pass for the three init tests**

Run: `npm test`
Expected: init tests pass. Other tests unaffected.

- [ ] **Step 4.6: Commit**

```bash
git add src/auth/auth-controller.ts tests/auth/auth-controller.test.ts
git commit -m "feat(auth): AuthController skeleton with init state decision"
```

- [ ] **Step 4.7: Add tests for `startLogin` (happy path + debounce + non-oauth rejection)**

Append to `tests/auth/auth-controller.test.ts`:

```ts
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
```

- [ ] **Step 4.8: Run — expect pass**

Run: `npm test`
Expected: all new tests pass.

- [ ] **Step 4.9: Add tests for completeLoginWithCode / state mismatch / no pending**

Append:

```ts
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
```

- [ ] **Step 4.10: Run — expect pass**

Run: `npm test`

- [ ] **Step 4.11: Add tests for timeout, logout, reportAuthFailure, getGenerator**

Append:

```ts
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
  // Start valid, then flip probe to failure.
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
  // probe by itself does NOT drive state — health-monitor is responsible for escalation.
  assert.equal(ctl.getState(), 'valid');
});
```

- [ ] **Step 4.12: Run — expect all AuthController tests pass**

Run: `npm test`
Expected: all tests pass (including url-extractor and oauth-flow).

- [ ] **Step 4.13: Commit**

```bash
git add tests/auth/auth-controller.test.ts src/auth/auth-controller.ts
git commit -m "feat(auth): complete AuthController state machine with tests"
```

---

## Task 5: `callback-server.ts`

**Files:**
- Create: `src/auth/callback-server.ts`
- Test: `tests/auth/callback-server.test.ts`

- [ ] **Step 5.1: Write the failing test**

Create `tests/auth/callback-server.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { startCallbackServer } from '../../src/auth/callback-server';

// Helper: do a GET, return { statusCode, headers, body }.
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
  const srv = await startCallbackServer({ port: 0, controller });
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
```

- [ ] **Step 5.2: Run — expect failure (module not found)**

Run: `npm test`

- [ ] **Step 5.3: Implement `callback-server.ts`**

Create `src/auth/callback-server.ts`:

```ts
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
```

- [ ] **Step 5.4: Run — expect pass**

Run: `npm test`
Expected: all callback-server tests pass.

- [ ] **Step 5.5: Commit**

```bash
git add src/auth/callback-server.ts tests/auth/callback-server.test.ts
git commit -m "feat(auth): long-lived OAuth callback HTTP server"
```

---

## Task 6: `HealthMonitor`

**Files:**
- Create: `src/auth/health-monitor.ts`
- Test: `tests/auth/health-monitor.test.ts`

- [ ] **Step 6.1: Write failing tests**

Create `tests/auth/health-monitor.test.ts`:

```ts
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
  // setInterval callback fires immediately; probe() is async, give it a tick.
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
  // Transport-y reason (no auth signals) to ensure it's not caught by looksLikeAuthError.
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
  await new Promise((r) => setImmediate(r)); // probe #1
  assert.equal(reportCount, 0);
  advance(10 * 60 * 1000);
  await new Promise((r) => setImmediate(r)); // probe #2
  assert.equal(reportCount, 0);
  advance(10 * 60 * 1000);
  await new Promise((r) => setImmediate(r)); // probe #3 — escalates
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
```

- [ ] **Step 6.2: Run — expect failure**

Run: `npm test`

- [ ] **Step 6.3: Implement `health-monitor.ts`**

Create `src/auth/health-monitor.ts`:

```ts
import type { AuthController, AuthEvent } from './auth-controller';

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

interface ControllerPort extends Pick<AuthController, 'getState' | 'probe' | 'reportAuthFailure' | 'getGenerator' | 'on'> {}

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

  // ring of timestamped events within the sliding window
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
    },
  };
}
```

- [ ] **Step 6.4: Run — expect pass**

Run: `npm test`

- [ ] **Step 6.5: Commit**

```bash
git add src/auth/health-monitor.ts tests/auth/health-monitor.test.ts
git commit -m "feat(auth): HealthMonitor with passive stats and active 10-min probe"
```

---

## Task 7: Telegram formatters (pure)

**Files:**
- Create: `src/telegram/formatters.ts`
- Test: covered by `bot.ts` integration + manual smoke; no unit tests (tiny pure string rendering).

- [ ] **Step 7.1: Implement formatters**

Create `src/telegram/formatters.ts`:

```ts
import { InlineKeyboard } from 'grammy';
import type { AuthSnapshot } from '../auth/auth-controller';
import type { HealthSnapshot } from '../auth/health-monitor';

export const CB = {
  LOGIN: 'auth:login',
  REGENERATE: 'auth:regen',
  LOGOUT: 'auth:logout',
  AUTH_STATUS: 'auth:status',
  PING: 'health:ping',
  STATUS: 'health:status',
  ERRORS: 'health:errors',
  INFO: 'meta:info',
  MUTE: 'meta:mute',
  UNMUTE: 'meta:unmute',
  CANCEL: 'auth:cancel',
} as const;

export function mainKeyboard(opts: { authValid: boolean; muted: boolean }): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (opts.authValid) {
    kb.text('🔄 Regenerate login', CB.REGENERATE).text('❌ Logout', CB.LOGOUT).row();
  } else {
    kb.text('🔐 Login', CB.LOGIN).text('🔄 Regenerate', CB.REGENERATE).row();
  }
  kb.text('📋 Auth status', CB.AUTH_STATUS).text('🩺 Ping Gemini', CB.PING).row();
  kb.text('📊 Status', CB.STATUS).text('📜 Recent errors', CB.ERRORS).row();
  kb.text('ℹ️ Info', CB.INFO);
  if (opts.muted) kb.text('🔔 Unmute', CB.UNMUTE);
  else kb.text('🔇 Mute 1h', CB.MUTE);
  kb.row();
  return kb;
}

export function loginPrompt(
  authUrl: string,
  opts: { callbackServerReady: boolean; port: number },
): string {
  if (opts.callbackServerReady) {
    return (
      '🔐 Open this URL in your browser and sign in:\n\n' +
      `${authUrl}\n\n` +
      `Google will redirect to http://localhost:${opts.port}/oauth2callback. ` +
      'If you cannot reach that port, paste the resulting URL here in chat — I will finish login automatically.'
    );
  }
  return (
    '🔐 Open this URL in your browser and sign in:\n\n' +
    `${authUrl}\n\n` +
    'After sign-in Google will redirect to a localhost URL. ' +
    'Copy that URL from the address bar and paste it here — I will finish login from it.'
  );
}

export function renderAuthStatus(snap: AuthSnapshot): string {
  const parts: string[] = [];
  parts.push(`State: ${snap.state}`);
  parts.push(`Auth type: ${snap.authType}`);
  if (snap.model) parts.push(`Model: ${snap.model}`);
  if (snap.tokenExpiresAt) {
    const delta = Math.round((snap.tokenExpiresAt - Date.now()) / 60000);
    parts.push(`Token expires in: ${delta} min`);
  }
  if (snap.hasRefreshToken !== undefined) parts.push(`Refresh token: ${snap.hasRefreshToken ? 'yes' : 'no'}`);
  if (snap.callbackServerReady !== undefined) {
    parts.push(`Callback server (port): ${snap.callbackServerReady ? 'ready' : 'not bound'}`);
  }
  if (snap.lastSuccessAt) parts.push(`Last success: ${new Date(snap.lastSuccessAt).toISOString()}`);
  if (snap.lastFailureAt) parts.push(`Last failure: ${new Date(snap.lastFailureAt).toISOString()}`);
  if (snap.lastFailureReason) parts.push(`Reason: ${snap.lastFailureReason}`);
  return parts.join('\n');
}

export function renderHealthStatus(auth: AuthSnapshot, health: HealthSnapshot): string {
  const winMin = Math.round(health.window.windowMs / 60000);
  const parts = [
    `Auth state: ${auth.state}`,
    `Window (${winMin}m): ok=${health.window.ok}, fail=${health.window.fail}`,
    health.lastSuccessAt ? `Last success: ${new Date(health.lastSuccessAt).toISOString()}` : 'Last success: —',
    health.lastFailureAt ? `Last failure: ${new Date(health.lastFailureAt).toISOString()} (${health.lastFailureReason ?? ''})` : 'Last failure: —',
    health.probeLastOkAt ? `Probe last ok: ${new Date(health.probeLastOkAt).toISOString()}` : 'Probe: —',
    health.probeLastFailAt ? `Probe last fail: ${new Date(health.probeLastFailAt).toISOString()} (${health.probeLastFailReason ?? ''})` : '',
  ].filter(Boolean);
  return parts.join('\n');
}

export function renderRecentErrors(h: HealthSnapshot): string {
  if (h.recentErrors.length === 0) return 'No errors in the buffer.';
  return h.recentErrors
    .map((e, i) => `${i + 1}. [${new Date(e.at).toISOString()}] ${e.label} ${e.status ?? ''} — ${e.message}`)
    .join('\n');
}

export function renderInfo(auth: AuthSnapshot, extras: { proxyPort: number; callbackPort: number; cliVersion?: string }): string {
  return [
    `CLI impersonation: ${extras.cliVersion ?? 'unknown'}`,
    `AUTH_TYPE: ${auth.authType}`,
    `Model: ${auth.model ?? '(not initialised)'}`,
    `Proxy port: ${extras.proxyPort}`,
    `Callback port: ${extras.callbackPort}`,
    `Callback server: ${auth.callbackServerReady === undefined ? 'n/a' : auth.callbackServerReady ? 'ready' : 'not bound'}`,
  ].join('\n');
}
```

- [ ] **Step 7.2: Commit**

```bash
git add src/telegram/formatters.ts
git commit -m "feat(telegram): inline keyboard and message formatters"
```

---

## Task 8: Telegram access control

**Files:**
- Create: `src/telegram/access-control.ts`

- [ ] **Step 8.1: Implement middleware**

Create `src/telegram/access-control.ts`:

```ts
import type { MiddlewareFn, Context } from 'grammy';

export function createAccessControl(allowedUserId: number): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const fromId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    const chatType = ctx.chat?.type;
    if (chatType !== 'private') return; // silently ignore
    if (fromId !== allowedUserId || chatId !== allowedUserId) return;
    await next();
  };
}
```

- [ ] **Step 8.2: Commit**

```bash
git add src/telegram/access-control.ts
git commit -m "feat(telegram): single-user access control middleware"
```

---

## Task 9: Telegram bot (integration)

**Files:**
- Create: `src/telegram/bot.ts`

No automated tests for this file — it's glue over grammy. Smoke-tested manually.

- [ ] **Step 9.1: Implement the bot**

Create `src/telegram/bot.ts`:

```ts
import { Bot, Context } from 'grammy';
import type { AuthController, AuthEvent } from '../auth/auth-controller';
import type { HealthMonitor } from '../auth/health-monitor';
import {
  CB,
  mainKeyboard,
  loginPrompt,
  renderAuthStatus,
  renderHealthStatus,
  renderRecentErrors,
  renderInfo,
} from './formatters';
import { createAccessControl } from './access-control';
import { extractOauthCallback } from './url-extractor';

export interface TelegramBotDeps {
  token: string;
  userId: number;
  controller: AuthController;
  health: HealthMonitor;
  proxyPort: number;
  callbackPort: number;
  cliVersion?: string;
  logger?: { log: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}

export interface TelegramBotHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createTelegramBot(deps: TelegramBotDeps): TelegramBotHandle {
  const logger = deps.logger ?? console;
  const bot = new Bot(deps.token);
  bot.use(createAccessControl(deps.userId));

  // ---- state local to the bot -------------------------------------------
  let mutedUntil = 0;
  const recentOutbound = new Map<string, number>(); // body → lastSentAt
  const DEDUP_MS = 60_000;

  async function say(body: string, extra?: Parameters<Context['reply']>[1]) {
    const last = recentOutbound.get(body) ?? 0;
    const nowMs = Date.now();
    if (nowMs - last < DEDUP_MS) return;
    recentOutbound.set(body, nowMs);
    try {
      await bot.api.sendMessage(deps.userId, body, extra);
    } catch (e) {
      logger.error('telegram send failed:', e);
    }
  }

  async function sayKeyboard() {
    await bot.api.sendMessage(deps.userId, 'Choose an action:', {
      reply_markup: mainKeyboard({
        authValid: deps.controller.getState() === 'valid',
        muted: Date.now() < mutedUntil,
      }),
    });
  }

  // ---- event subscriptions -----------------------------------------------
  const unsubscribe = deps.controller.on((e: AuthEvent) => {
    const muted = Date.now() < mutedUntil;
    switch (e.type) {
      case 'stateChange':
        if (e.to === 'broken') {
          void say(`⚠️ Gemini auth broken: ${e.reason}\nPress Login to re-authenticate.`, {
            reply_markup: mainKeyboard({ authValid: false, muted }),
          });
        }
        break;
      case 'loginStarted':
        void say(
          loginPrompt(e.authUrl, {
            callbackServerReady: deps.controller.getSnapshot().callbackServerReady ?? false,
            port: deps.callbackPort,
          }),
          { reply_markup: mainKeyboard({ authValid: false, muted }) },
        );
        break;
      case 'loginCompleted':
        void say('✅ Authenticated.');
        break;
      case 'loginFailed':
        void say(`❌ Login failed: ${e.reason}\nPress Regenerate to try again.`);
        break;
      case 'probeFailed':
        if (!muted) void say(`⚠️ Probe failed: ${e.reason}`);
        break;
    }
  });

  // ---- commands -----------------------------------------------------------
  bot.command('start', async (ctx) => { await ctx.reply('Gemini proxy bot ready.', { reply_markup: mainKeyboard({ authValid: deps.controller.getState() === 'valid', muted: Date.now() < mutedUntil }) }); });
  bot.command('help', async (ctx) => { await ctx.reply([
    'Commands:',
    '/login — start or regenerate OAuth login',
    '/logout — delete cached credentials',
    '/status — auth + health status',
    '/ping — live countTokens call to Gemini',
    '/errors — last 10 errors',
    '/mute — silence probe alerts for 1h',
    '/unmute — re-enable alerts',
  ].join('\n'), { reply_markup: mainKeyboard({ authValid: deps.controller.getState() === 'valid', muted: Date.now() < mutedUntil }) }); });

  const onLogin = async (ctx: Context) => {
    try {
      const { authUrl } = await deps.controller.startLogin('telegram');
      await ctx.reply(loginPrompt(authUrl, {
        callbackServerReady: deps.controller.getSnapshot().callbackServerReady ?? false,
        port: deps.callbackPort,
      }));
    } catch (e: unknown) {
      await ctx.reply(`❌ Cannot start login: ${(e as Error).message}`);
    }
  };
  bot.command('login', onLogin);
  bot.callbackQuery(CB.LOGIN, async (ctx) => { await ctx.answerCallbackQuery(); await onLogin(ctx); });
  bot.callbackQuery(CB.REGENERATE, async (ctx) => { await ctx.answerCallbackQuery(); await onLogin(ctx); });

  const onLogout = async (ctx: Context) => {
    await deps.controller.logout();
    await ctx.reply('🔓 Logged out. Cached credentials deleted.');
  };
  bot.command('logout', onLogout);
  bot.callbackQuery(CB.LOGOUT, async (ctx) => { await ctx.answerCallbackQuery(); await onLogout(ctx); });

  const onStatus = async (ctx: Context) => {
    await ctx.reply(renderHealthStatus(deps.controller.getSnapshot(), deps.health.getSnapshot()));
  };
  bot.command('status', onStatus);
  bot.callbackQuery(CB.STATUS, async (ctx) => { await ctx.answerCallbackQuery(); await onStatus(ctx); });

  const onAuthStatus = async (ctx: Context) => {
    await ctx.reply(renderAuthStatus(deps.controller.getSnapshot()));
  };
  bot.callbackQuery(CB.AUTH_STATUS, async (ctx) => { await ctx.answerCallbackQuery(); await onAuthStatus(ctx); });

  const onPing = async (ctx: Context) => {
    await ctx.reply('🩺 Pinging Gemini…');
    const r = await deps.health.pingGemini();
    if (r.ok) await ctx.reply(`✅ Ping ok (${r.latencyMs} ms)`);
    else await ctx.reply(`❌ Ping failed: ${r.error}`);
  };
  bot.command('ping', onPing);
  bot.callbackQuery(CB.PING, async (ctx) => { await ctx.answerCallbackQuery(); await onPing(ctx); });

  const onErrors = async (ctx: Context) => {
    await ctx.reply(renderRecentErrors(deps.health.getSnapshot()));
  };
  bot.command('errors', onErrors);
  bot.callbackQuery(CB.ERRORS, async (ctx) => { await ctx.answerCallbackQuery(); await onErrors(ctx); });

  const onInfo = async (ctx: Context) => {
    await ctx.reply(renderInfo(deps.controller.getSnapshot(), {
      proxyPort: deps.proxyPort,
      callbackPort: deps.callbackPort,
      cliVersion: deps.cliVersion,
    }));
  };
  bot.callbackQuery(CB.INFO, async (ctx) => { await ctx.answerCallbackQuery(); await onInfo(ctx); });

  const onMute = async (ctx: Context) => {
    mutedUntil = Date.now() + 60 * 60 * 1000;
    await ctx.reply('🔇 Probe alerts muted for 1h.');
  };
  bot.command('mute', onMute);
  bot.callbackQuery(CB.MUTE, async (ctx) => { await ctx.answerCallbackQuery(); await onMute(ctx); });

  const onUnmute = async (ctx: Context) => {
    mutedUntil = 0;
    await ctx.reply('🔔 Alerts unmuted.');
  };
  bot.command('unmute', onUnmute);
  bot.callbackQuery(CB.UNMUTE, async (ctx) => { await ctx.answerCallbackQuery(); await onUnmute(ctx); });

  // ---- URL pasting --------------------------------------------------------
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text ?? '';
    // Ignore slash commands; command handlers already handle them.
    if (text.startsWith('/')) return;
    try {
      const parsed = extractOauthCallback(text);
      await deps.controller.completeLoginWithCode(parsed.code, parsed.state);
      // success — loginCompleted handler already sent the confirmation
    } catch (e: unknown) {
      const name = (e as { name?: string }).name;
      if (name === 'InvalidCallbackUrlError') {
        // Only react if the text looks like it was meant to be a URL.
        if (/oauth2callback|code=/.test(text)) {
          await ctx.reply(`⚠️ Could not parse callback URL: ${(e as Error).message}`);
        }
        return;
      }
      if (name === 'NoPendingLoginError') {
        await ctx.reply('No pending login. Press Login or /login first.');
        return;
      }
      if (name === 'StateMismatchError') {
        await ctx.reply('State mismatch — this URL is from a previous login attempt. Press Regenerate.');
        return;
      }
      await ctx.reply(`❌ Login failed: ${(e as Error).message}`);
    }
  });

  bot.catch((err) => {
    logger.error('telegram bot error:', err);
  });

  let started = false;
  return {
    async start() {
      if (started) return;
      started = true;
      // Verify token and start long-polling.
      try {
        await bot.api.getMe();
      } catch (e) {
        logger.error('telegram: getMe failed — disabling bot:', e);
        return;
      }
      // bot.start() resolves only when stop() is called — fire and forget.
      void bot.start();
      await sayKeyboard();
    },
    async stop() {
      unsubscribe();
      await bot.stop();
    },
  };
}
```

- [ ] **Step 9.2: Commit**

```bash
git add src/telegram/bot.ts
git commit -m "feat(telegram): grammy bot wiring with events, commands, URL paste"
```

---

## Task 10: Refactor `chatwrapper.ts`

**Files:**
- Modify: `src/chatwrapper.ts`

- [ ] **Step 10.1: Replace `chatwrapper.ts` with the controller-backed version**

Open `src/chatwrapper.ts`. Replace the entire file contents with:

```ts
// src/chatwrapper.ts
import { randomUUID } from 'node:crypto';
import {
  AuthType,
  createContentGeneratorConfig,
  createContentGenerator,
} from '@google/gemini-cli-core/dist/src/core/contentGenerator.js';
import type { AuthController, GeneratorHandle } from './auth/auth-controller';
import type { HealthMonitor } from './auth/health-monitor';

if (!process.env.CLI_VERSION) {
  process.env.CLI_VERSION = '0.39.0';
}

const sessionId = randomUUID();
console.log(`Session ID: ${sessionId}`);
console.log(
  `Impersonating Gemini CLI as: GeminiCLI/${process.env.CLI_VERSION} (${process.platform}; ${process.arch})`,
);

export const authType = (process.env.AUTH_TYPE ?? 'gemini-api-key') as AuthType;
export const modelOverride = process.env.MODEL ?? undefined;

if (modelOverride) console.log(`Model override: ${modelOverride}`);
console.log(`Auth type: ${authType}`);

// Injected at bootstrap from server.ts.
let _controller: AuthController | null = null;
let _health: HealthMonitor | null = null;

export function bindChatwrapper(controller: AuthController, health: HealthMonitor) {
  _controller = controller;
  _health = health;
}

function ctl(): AuthController {
  if (!_controller) throw new Error('chatwrapper not bound: call bindChatwrapper first');
  return _controller;
}
function hm(): HealthMonitor {
  if (!_health) throw new Error('chatwrapper not bound: call bindChatwrapper first');
  return _health;
}

// Factory passed INTO the controller so it owns generator lifecycle.
export async function defaultCreateGenerator(at: string, model?: string): Promise<GeneratorHandle> {
  const cfg = await createContentGeneratorConfig(model, at as AuthType);
  const generator = await createContentGenerator(cfg, sessionId);
  return { generator: generator as unknown, model: cfg.model };
}

type GeminiReq = {
  contents: unknown[];
  config?: Record<string, unknown>;
};

const RETRY_DELAYS_MS = [1000, 3000, 9000];
function isRetryable(err: unknown): boolean {
  const e = err as { status?: number; code?: number };
  const status = e?.status ?? e?.code;
  if (typeof status !== 'number') return false;
  return status === 429 || (status >= 500 && status < 600);
}

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
    try {
      return await fn();
    } catch (err: unknown) {
      if (i === RETRY_DELAYS_MS.length || !isRetryable(err)) throw err;
      const delay = RETRY_DELAYS_MS[i];
      const status = (err as { status?: number; code?: number }).status ?? (err as { code?: number }).code;
      console.log(`[retry] ${label} got ${status}; waiting ${delay}ms (attempt ${i + 1}/${RETRY_DELAYS_MS.length})`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error('retry loop exhausted');
}

async function instrumented<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const r = await fn();
    hm().onSuccess(label, Date.now() - started);
    return r;
  } catch (e) {
    hm().onFailure(label, e);
    throw e;
  }
}

export async function sendChat({ contents, config = {} }: GeminiReq) {
  const { generator, model } = await ctl().getGenerator();
  return instrumented('chat', () =>
    withRetry('sendChat', () =>
      (generator as { generateContent: (r: unknown) => Promise<unknown> })
        .generateContent({ model, contents, config }),
    ),
  );
}

export async function* sendChatStream({ contents, config = {} }: GeminiReq) {
  const { generator, model } = await ctl().getGenerator();
  const started = Date.now();
  let failed = false;
  try {
    const stream = await withRetry('sendChatStream', () =>
      (generator as { generateContentStream: (r: unknown) => Promise<AsyncIterable<unknown>> })
        .generateContentStream({ model, contents, config }),
    );
    for await (const chunk of stream) yield chunk;
  } catch (e) {
    failed = true;
    hm().onFailure('chat_stream', e);
    throw e;
  } finally {
    if (!failed) hm().onSuccess('chat_stream', Date.now() - started);
  }
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
export const embeddingsAvailable = authType !== 'oauth-personal' || !!GEMINI_API_KEY;

export async function embedContent({
  model,
  contents,
  config,
}: {
  model: string;
  contents: Array<{ role: string; parts: Array<{ text?: string }> }>;
  config?: Record<string, unknown>;
}) {
  if (authType !== 'oauth-personal') {
    const { generator } = await ctl().getGenerator();
    return instrumented('embed', () =>
      (generator as { embedContent: (r: unknown) => Promise<unknown> })
        .embedContent({ model, contents, config }),
    );
  }

  if (!GEMINI_API_KEY) {
    const err = new Error(
      'Embeddings are not available through AUTH_TYPE=oauth-personal — set GEMINI_API_KEY',
    );
    (err as { statusCode?: number }).statusCode = 501;
    throw err;
  }

  const modelId = model.startsWith('models/') ? model.slice(7) : model;
  const outputDim = (config as { outputDimensionality?: number } | undefined)?.outputDimensionality;
  const taskType = (config as { taskType?: string } | undefined)?.taskType;
  const title = (config as { title?: string } | undefined)?.title;

  const requests = contents.map((c) => {
    const r: Record<string, unknown> = {
      model: `models/${modelId}`,
      content: { parts: c.parts, role: 'user' },
    };
    if (outputDim !== undefined) r.outputDimensionality = outputDim;
    if (taskType) r.taskType = taskType;
    if (title) r.title = title;
    return r;
  });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    modelId,
  )}:batchEmbedContents?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  return instrumented('embed_apikey', async () => {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests }),
    });
    if (!resp.ok) {
      throw new Error(`Gemini embed API ${resp.status}: ${await resp.text()}`);
    }
    const data = (await resp.json()) as { embeddings?: Array<{ values?: number[] }> };
    return {
      embeddings: (data.embeddings ?? []).map((e) => ({ values: e.values ?? [] })),
    };
  });
}

export function listModels() {
  const snap = _controller?.getSnapshot();
  const id = snap?.model ?? modelOverride ?? 'gemini-2.5-pro';
  return [{ id, object: 'model', owned_by: 'google' }];
}

export function getModel() {
  return _controller?.getSnapshot().model ?? modelOverride ?? 'gemini-2.5-pro';
}
```

- [ ] **Step 10.2: Run lint + `tsc --noEmit`**

Run: `npx tsc --noEmit`
Expected: no errors. (Chatwrapper won't run standalone without server.ts wiring, that's the next task.)

- [ ] **Step 10.3: Commit**

```bash
git add src/chatwrapper.ts
git commit -m "refactor(chatwrapper): read generator from AuthController, instrument with HealthMonitor"
```

---

## Task 11: Wire everything in `server.ts`

**Files:**
- Modify: `src/server.ts`
- Delete: `src/oauth-preflight.ts`

- [ ] **Step 11.1: Replace `server.ts`**

Open `src/server.ts`. Replace entire contents with:

```ts
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

// ---- Callback server (oauth-personal only) ----------------------------------
if (authType === 'oauth-personal') {
  startCallbackServer({ port: CALLBACK_PORT, controller })
    .then((srv) => {
      controller.setCallbackServerReady(true);
      console.log(`OAuth callback server on http://localhost:${CALLBACK_PORT}`);
      const close = () => srv.close();
      process.once('SIGINT', close);
      process.once('SIGTERM', close);
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
    const shutdown = () => { void bot.stop(); };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
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
```

- [ ] **Step 11.2: Delete `src/oauth-preflight.ts`**

```bash
rm src/oauth-preflight.ts
```

- [ ] **Step 11.3: `tsc --noEmit`**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 11.4: Run full test suite**

Run: `npm test`
Expected: all tests still pass.

- [ ] **Step 11.5: Commit**

```bash
git add src/server.ts
git rm src/oauth-preflight.ts
git commit -m "feat: wire AuthController, CallbackServer, HealthMonitor, Telegram bot into server.ts"
```

---

## Task 12: Docs and Dockerfile

**Files:**
- Modify: `README.md`
- Modify: `Dockerfile`

- [ ] **Step 12.1: Update README**

Open `README.md`. Find the `### Optional env vars` section and replace the code block with:

```sh
PORT=11434

# can be any of 'oauth-personal', 'gemini-api-key', 'vertex-ai'.
AUTH_TYPE='gemini-api-key'

# API key is only used with AUTH_TYPE='gemini-api-key' (and optionally for
# embeddings under oauth-personal).
GEMINI_API_KEY=

# Fixed port for the OAuth2 callback server (only used with AUTH_TYPE='oauth-personal').
# If you only use the Telegram bot for login (see below), you do NOT have to
# expose this port outside the container.
OAUTH_CALLBACK_PORT=8085

# Pick one of the models available via oauth-personal (Code Assist):
#   gemini-3.1-pro-preview
#   gemini-3-flash-preview
#   gemini-3.1-flash-lite-preview
#   gemini-2.5-pro
#   gemini-2.5-flash
#   gemini-2.5-flash-lite
MODEL=

# --- Optional: Telegram bot (login + health monitoring) --------------------
# Set BOTH of these to enable the bot. If either is missing the bot does not run.
# Only messages from TELEGRAM_USER_ID are ever responded to.
TELEGRAM_BOT_TOKEN=
TELEGRAM_USER_ID=
```

Insert a new section after the `#### Docker + AUTH_TYPE=oauth-personal` block:

```markdown
### Telegram bot for login and health monitoring

Set `TELEGRAM_BOT_TOKEN` (from @BotFather) and `TELEGRAM_USER_ID` (your
numeric Telegram user id — ask @userinfobot). If either is missing the bot
stays disabled and the proxy behaves as before.

When enabled, the bot:

* Posts a Google OAuth login URL when authentication is missing or broken.
* Lets you finish login in two ways: open the URL in a browser and let it
  redirect to `localhost:8085`, **or** copy the URL from your browser's
  address bar after sign-in and paste it back into the chat. In the second
  case port 8085 does not need to be exposed at all — the proxy reads `code`
  and `state` from the pasted URL and completes OAuth itself.
* Runs a light 10-minute token probe and passively watches live Gemini
  calls; if authentication breaks it posts an alert and offers a one-tap
  Login button.
* Exposes utility commands and inline buttons: `/login`, `/logout`,
  `/status`, `/ping`, `/errors`, `/mute`, `/unmute`.

If you use the bot you can run the container without mapping 8085:

```sh
docker run \
  -p 11434:80 \
  -e AUTH_TYPE=oauth-personal \
  -e TELEGRAM_BOT_TOKEN=xxx \
  -e TELEGRAM_USER_ID=123456789 \
  -v "$HOME/.gemini:/root/.gemini" \
  gemini-openai-proxy
```
```

- [ ] **Step 12.2: Update Dockerfile comment**

Open `Dockerfile`. Replace:

```dockerfile
EXPOSE ${PORT}
EXPOSE ${OAUTH_CALLBACK_PORT}
```

with:

```dockerfile
EXPOSE ${PORT}
# OAUTH_CALLBACK_PORT (8085) is only needed when completing OAuth via a
# browser. If you use the Telegram bot paste-URL flow, you do not have to
# publish this port.
EXPOSE ${OAUTH_CALLBACK_PORT}
```

- [ ] **Step 12.3: Commit**

```bash
git add README.md Dockerfile
git commit -m "docs: document Telegram bot login flow and optional 8085 exposure"
```

---

## Task 13: End-to-end smoke test (manual)

Automated end-to-end with a live Google account is out of scope; this task
documents the manual verification. The implementing agent runs these steps
and records results.

- [ ] **Step 13.1: Fresh start without creds, with bot**

1. Ensure `~/.gemini/oauth_creds.json` does not exist (or rename it temporarily).
2. Start: `TELEGRAM_BOT_TOKEN=... TELEGRAM_USER_ID=... AUTH_TYPE=oauth-personal npm start`
3. Expected in Telegram: bot posts "Gemini auth broken" (or similar) plus a
   login URL and inline keyboard.
4. Expected at `GET http://localhost:11434/health`: 200
   `{status:"ok", authState:"broken" | "pending", callbackServerReady:true}`.
5. Expected at `POST http://localhost:11434/v1/chat/completions`: 503 with
   the AuthBrokenError hint.

- [ ] **Step 13.2: Complete login via browser**

1. Open the login URL in a browser, sign in.
2. Expected: Google redirects to `http://localhost:8085/oauth2callback?...`,
   you see the success page.
3. Expected in Telegram: "✅ Authenticated".
4. Expected `/health`: `authState:"valid"`.
5. `/v1/chat/completions` now works.

- [ ] **Step 13.3: Complete login via paste**

1. Stop the proxy. Delete creds.
2. Start the proxy again (Telegram posts fresh login URL).
3. Open the login URL, sign in, then **copy the callback URL from the browser's
   address bar before pressing anything** — paste it into the Telegram chat.
4. Expected: bot responds "✅ Authenticated".

- [ ] **Step 13.4: `/ping` and `/status`**

1. Press "🩺 Ping Gemini". Expected: `✅ Ping ok (xxx ms)`.
2. Press "📊 Status". Expected: JSON-ish report with window counters populated.

- [ ] **Step 13.5: Force a broken state**

1. Move `~/.gemini/oauth_creds.json` aside (simulate token loss).
2. Wait up to 10 minutes for the probe, or immediately run `/ping` — expect
   an auth-ish error.
3. Expected: state flips to `broken`, Telegram posts a new login URL.

- [ ] **Step 13.6: Other-user isolation**

1. With the bot running, have a DIFFERENT Telegram account send `/start` to
   the bot.
2. Expected: bot does not respond.

- [ ] **Step 13.7: Bot disabled when env var missing**

1. Start proxy with only `TELEGRAM_BOT_TOKEN` set (no user id).
2. Expected log: `Telegram bot disabled (TELEGRAM_BOT_TOKEN and TELEGRAM_USER_ID must both be set)`.
3. Proxy and 8085 callback still work as before.

- [ ] **Step 13.8: Commit any docs updates discovered during smoke test**

If any corner case turned up rough edges, update docs and commit.

---

## Self-Review Checklist (to be run by the implementing agent after Task 13)

1. **Spec coverage** — skim `docs/superpowers/specs/2026-04-23-telegram-auth-bot-design.md`. Every §3–§10 requirement must map to a task above.
2. **Placeholder scan** — no "TBD"/"TODO"/"add appropriate…" left in code or plan.
3. **Type consistency** — `AuthState`, `AuthEvent`, `HealthSnapshot`, callback-data constants (`CB.*`) match across controller, bot, and formatters.
4. **Lint** — `npm run lint`.
5. **Type check** — `npx tsc --noEmit`.
6. **Test suite** — `npm test` passes.
7. **Manual smoke** — Task 13 subtasks recorded (pass / needs follow-up).
