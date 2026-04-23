# Telegram auth & health bot — design

Date: 2026-04-23
Status: approved (ready for implementation planning)

## 1. Goal

Add an optional Telegram bot to `gemini-openai-proxy` that:

1. Drives the `oauth-personal` login flow from Telegram. The bot posts the
   Google consent URL to the operator, and the operator can finish the flow
   either by opening it in a browser (the existing `OAUTH_CALLBACK_PORT=8085`
   path) OR by pasting the resulting callback URL back into the bot. In the
   second case the bot extracts `code`/`state`, hands them to the proxy, and
   the proxy completes the token exchange itself — no HTTP callback server
   has to be reachable from the browser.
2. Actively monitors the health of the Gemini connection (passive + a light
   10-minute probe + a user-triggered end-to-end ping) and proactively
   notifies the operator when something breaks.
3. Re-triggers a login flow as soon as authentication is lost.
4. Exposes utility commands/buttons for status, info, recent errors, mute,
   and logout.

The bot is optional. It is enabled only when BOTH `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_USER_ID` are set. If either is missing, the bot module does not
load and the proxy behaves exactly as today. The existing `8085` callback
flow keeps working in parallel regardless of whether the bot is enabled.

## 2. Out of scope

- Multi-user access (only one `TELEGRAM_USER_ID` ever responded to).
- Group chats.
- Persisting any bot state across restarts (auth state derives from the
  on-disk `~/.gemini/oauth_creds.json`; everything else is in-memory).
- Non-Russian localisation (bot text can be English; not a requirement).
- Support for `AUTH_TYPE=gemini-api-key` / `vertex-ai` login flows (no OAuth
  there; bot still works for health/status but Login/Regenerate return an
  informative error).

## 3. High-level architecture

```
src/
  auth/
    auth-controller.ts   # state machine + events, single source of truth for auth
    oauth-flow.ts        # helpers: authUrl, code→tokens exchange, cred file I/O
    callback-server.ts   # long-lived HTTP on OAUTH_CALLBACK_PORT (oauth-personal only)
    health-monitor.ts    # passive counters + 10-min active token probe + pingGemini()
  telegram/
    bot.ts               # grammy bot init, keyboard, commands, event wiring
    access-control.ts    # middleware: respond only to TELEGRAM_USER_ID, private chats only
    url-extractor.ts     # parser for pasted callback URLs
    formatters.ts        # message / keyboard rendering
  chatwrapper.ts         # asks AuthController for a live generator, fail-fast on broken
  server.ts              # wires modules, /v1/* return 503 on AuthBrokenError, /health always 200
```

`src/oauth-preflight.ts` is removed. Its helpers move to `src/auth/oauth-flow.ts`;
its HTTP server becomes `src/auth/callback-server.ts`.

### Data flow

`AuthController` is the only source of truth for authentication state. It
emits events; consumers subscribe:

- `chatwrapper` — invalidates/recreates its `generator` on state changes.
- `telegram/bot` — posts messages to the operator.
- `health-monitor` — reads state to decide whether to run the active probe.

Inputs to the controller:

- Startup initialisation (reads `~/.gemini/oauth_creds.json`, probes).
- HTTP callback on `OAUTH_CALLBACK_PORT/oauth2callback`.
- Telegram URL paste.
- Telegram commands (`/login`, `/logout`, `/ping`, etc.).
- Passive observer reports from `chatwrapper` (`reportAuthFailure`).
- Active probe results.

## 4. AuthController

### States and transitions

States: `idle | valid | pending | broken`.

- `idle → valid` — startup, cached creds are valid.
- `idle → broken` — startup, no creds or creds invalid.
- `valid → broken` — passive observer caught auth error, or active probe
  failed with an auth cause.
- `valid → pending` — operator invoked `/login` (or Regenerate).
- `valid → broken` (via `/logout`) — `/logout` goes straight to `broken`
  rather than `pending`: we delete creds and wait for the operator to press
  Login. No implicit `startLogin`.
- `broken → pending` — only via an explicit `startLogin()` call (operator
  pressed Login/Regenerate, or startup in `broken` decided to auto-start).
  A stray HTTP callback to `/oauth2callback` with no pending session does
  NOT cause this transition — it returns 400 (see corner case #6).
- `pending → valid` — `completeLoginWithCode` exchanged code for tokens.
- `pending → broken` — pending session timed out (10 min) or code exchange
  failed.
- `pending → pending` — `startLogin()` re-invoked; new state token; old
  authUrl invalidated.

### External API

```ts
type AuthState = 'idle' | 'valid' | 'pending' | 'broken';

type AuthEvent =
  | { type: 'stateChange'; from: AuthState; to: AuthState; reason: string }
  | { type: 'loginStarted'; authUrl: string; expiresAt: number }
  | { type: 'loginCompleted' }
  | { type: 'loginFailed'; reason: string }
  | { type: 'probeFailed'; reason: string };

interface AuthController {
  getState(): AuthState;
  getSnapshot(): AuthSnapshot;          // used by /status button
  startLogin(trigger: 'startup' | 'telegram' | 'probe' | 'passive'):
    Promise<{ authUrl: string }>;
  completeLoginWithCode(code: string, state: string): Promise<void>;
  submitCallbackUrl(rawUrl: string): Promise<void>;
  logout(): Promise<void>;
  probe(): Promise<{ ok: boolean; reason?: string }>;
  reportAuthFailure(err: unknown): void;
  getGenerator(): Promise<ContentGenerator>; // throws AuthBrokenError if not valid
  on(listener: (e: AuthEvent) => void): () => void;
}

interface AuthSnapshot {
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
```

### Invariants

- At most one active `pending` session at a time. A second `startLogin()`
  replaces the state token; any late HTTP callback for the old token is
  rejected with state-mismatch 400.
- `startLogin()` is idempotent inside a 5-second debounce window while in
  `pending` — same `authUrl` returned, no duplicate Telegram message fires.
- `getGenerator()` throws `AuthBrokenError` with a hint string when state is
  not `valid`. `chatwrapper` translates it to HTTP 503.
- All writes to `~/.gemini/oauth_creds.json` and `google_account_id` happen
  only inside the controller.
- Pending sessions expire 10 minutes after `startLogin()`. On expiry,
  `pending → broken` with a `loginFailed` event.

### Generator lifecycle

On `valid`, the controller holds a `ContentGenerator` instance built via
`createContentGeneratorConfig` + `createContentGenerator` (same as today's
`chatwrapper`). On transition `valid → broken` or `valid → pending`, the
generator is dropped. On `pending → valid`, it is recreated lazily on the
first `getGenerator()` call.

## 5. callback-server.ts

Long-lived `http.Server`, started once at process startup if and only if
`AUTH_TYPE === 'oauth-personal'`. Binds `OAUTH_CALLBACK_PORT` (default 8085).

Routes:

- `GET /oauth2callback?code=…&state=…` — call
  `authController.completeLoginWithCode(code, state)`. Outcomes:
  - Success → 301 to `SIGN_IN_SUCCESS_URL`.
  - No pending session or state mismatch → 400 text `"No pending login or
    state mismatch — request a new login via Telegram or restart proxy."`.
    This is an operator-facing error; a 301-redirect would hide it.
  - Token exchange failed (Google returned error) → 301 to
    `SIGN_IN_FAILURE_URL`, and the controller emits `loginFailed(reason)`
    so the bot explains what went wrong in chat.
- Anything else: 404.

On `EADDRINUSE`: `console.error`, set `callbackServerReady = false` in the
controller snapshot, DO NOT exit. The bot uses this flag to tailor its
login message (skip the "open in browser" branch).

## 6. Telegram bot

### Enablement

```ts
const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const userIdRaw = process.env.TELEGRAM_USER_ID?.trim();
const userId = userIdRaw ? Number(userIdRaw) : NaN;

if (!token || !userIdRaw) {
  console.log('Telegram bot disabled (TELEGRAM_BOT_TOKEN and TELEGRAM_USER_ID must both be set)');
  return;
}
if (!Number.isInteger(userId) || userId <= 0) {
  console.error(`TELEGRAM_USER_ID must be a positive integer, got "${userIdRaw}" — bot disabled`);
  return;
}
```

### Access control

A grammy middleware drops any update where `chat.type !== 'private'` or
`chat.id !== userId` or `from.id !== userId`. No reply is sent — the bot
stays silent for anyone else.

### Long polling and shutdown

`bot.start()` in grammy. On `SIGINT` / `SIGTERM` the entrypoint calls
`bot.stop()` before exiting. grammy's default transport already retries
polling with exponential backoff; we add `bot.catch(err => log)` and do NOT
crash the process on polling errors.

If `getMe()` fails at startup (invalid token, 401 from Telegram), we log
once and disable the bot module. The proxy and the 8085 callback keep
working.

### Commands and inline keyboard

Slash commands: `/start`, `/login`, `/logout`, `/status`, `/ping`,
`/errors`, `/mute`, `/unmute`, `/help`.

Main inline keyboard (shown by `/start` and `/help`):

Auth:
- `🔐 Login` / `🔄 Regenerate OAuth link` — calls `startLogin('telegram')`.
  Old authUrl is invalidated.
- `❌ Logout` — deletes `~/.gemini/oauth_creds.json`, transitions to `broken`.
- `📋 Auth status` — renders `AuthSnapshot`.

Health:
- `🩺 Ping Gemini` — runs `healthMonitor.pingGemini()` (live `countTokens`).
  The ONLY path that spends Gemini quota, and only on explicit button press.
- `📊 Status` — full snapshot (auth + health windowed counters + uptime).
- `📜 Recent errors` — last 10 errors from the ring buffer.

Meta:
- `ℹ️ Info` — version, `AUTH_TYPE`, active `MODEL`, proxy port, callback port,
  `callbackServerReady`.
- `🔇 Mute alerts 1h` / `🔔 Unmute` — temporary mute of proactive alerts.

### Event subscriptions

- `stateChange: * → broken` → post: `"Gemini auth broken: {reason}. Press
  Login."` + Login button.
- `loginStarted(authUrl)` → post: `"Open this URL in a browser OR paste the
  resulting callback URL back here:\n\n{authUrl}"` + Regenerate / Cancel
  buttons. If `callbackServerReady === false`, message text shortens to the
  paste-only instruction.
- `loginCompleted` → post: `"✅ Authenticated"`.
- `loginFailed(reason)` → post: `"❌ Login failed: {reason}"` + Regenerate.
- `probeFailed(reason)` → post (if not muted): `"⚠️ Probe failed: {reason}"`.
  Does NOT imply state change — the controller posts a separate message
  only if state actually moves to `broken`.

### Deduplication and mute

In-memory 60-second dedup: the bot does not re-send an identical message
body within that window. This is independent of mute — it applies to all
messages.

Mute (`/mute` or the `🔇` button) sets `mutedUntil = now + 1h`. While muted,
`probeFailed` events produce no message. All other events still fire:
`stateChange: * → broken`, `loginStarted`, `loginCompleted`, and
`loginFailed` always go through — these are operator-critical and muting
them would defeat the bot's purpose.

### Callback URL pasting

A text-message handler pipes the message text through `url-extractor.ts`.
The extractor recognises:

- A full URL matching `^https?://[^/]+/oauth2callback\?…`.
- A bare query string containing `code=…&state=…` (operator copied just the
  tail).
- A string with those params embedded anywhere (lenient).

If extraction succeeds, the handler calls
`authController.submitCallbackUrl(extracted)`. On success, no extra message
(the `loginCompleted` event handler already posts `"✅ Authenticated"`). On
failure, a short error message is posted.

## 7. health-monitor.ts

### Passive observer

`chatwrapper` calls `healthMonitor.onSuccess(label, latencyMs)` or
`onFailure(label, err)` around every Gemini call (chat, stream, embed,
listModels). The monitor keeps a 15-minute sliding window:

- `{ok, fail}` counters.
- `lastSuccessAt`, `lastFailureAt`.
- Ring buffer of the last 10 errors (`{at, label, status?, message}`).

Any failure that looks like an auth problem — `status === 401`,
`invalid_grant`, `invalid_token`, `PERMISSION_DENIED` while validating the
token — is forwarded to `authController.reportAuthFailure(err)`. The
controller decides whether to move to `broken`. Non-auth errors (429, 5xx,
network) stay in the stats and do NOT affect auth state.

### Active probe

`setInterval(10 * 60 * 1000)`. Runs only while state is `valid`. Skipped
during `pending`/`broken`/`idle`.

Implementation: call `authController.probe()`, which wraps
`OAuth2Client.getAccessToken()` + `getTokenInfo(token)`. Zero Gemini quota.

- Auth failure → `reportAuthFailure` (may drive `valid → broken`).
- Transport/network failure → `probeFailed` event. After 3 consecutive
  transport failures, escalate to `reportAuthFailure`.

### pingGemini

Live end-to-end check triggered by the `🩺 Ping Gemini` button. Runs
`generator.countTokens({contents: [{role: 'user', parts: [{text: 'ping'}]}]})`
on the current model. Returns `{ok, latencyMs, error?}`. This is the only
code path that deliberately spends Gemini quota.

### API

```ts
interface HealthMonitor {
  onSuccess(label: string, latencyMs: number): void;
  onFailure(label: string, err: unknown): void;
  getSnapshot(): HealthSnapshot;
  pingGemini(): Promise<{ ok: boolean; latencyMs: number; error?: string }>;
  start(): void;
  stop(): void;
}
```

## 8. Corner cases

| # | Situation | Behavior |
|---|-----------|----------|
| 1 | Only one of `TELEGRAM_BOT_TOKEN` / `TELEGRAM_USER_ID` set | Bot disabled, warn log, proxy and 8085 work unchanged. |
| 2 | `TELEGRAM_BOT_TOKEN` invalid (401 on `getMe`) | Log once, disable bot module, proxy keeps running. |
| 3 | `TELEGRAM_USER_ID` not an integer | Warn, bot disabled. |
| 4 | `AUTH_TYPE !== 'oauth-personal'` | Controller still initialises; `startLogin`/`submitCallbackUrl` return an error "OAuth login supported only with AUTH_TYPE=oauth-personal". Bot still useful for status/ping. Callback server is NOT started. |
| 5 | Port 8085 already bound | Log `EADDRINUSE`, `callbackServerReady = false`. Bot `loginStarted` message drops the "open in browser" branch. |
| 6 | Callback URL pasted with no pending session | `submitCallbackUrl` finds no pending state → "No pending login. Press Login/Regenerate." |
| 7 | Pasted URL with valid `code` but stale `state` | "State mismatch — link from a previous attempt. Press Regenerate." |
| 8 | Same URL pasted twice | First call: `valid`. Second call: no pending → same hint as #6. |
| 9 | Two `startLogin()` calls within 5 s in `pending` | Debounced: same authUrl returned, no second message. |
| 10 | Pending session idle >10 minutes | Timeout: `pending → broken`, post "Login expired, press Regenerate." |
| 11 | Token dies mid-stream | Stream fails on next chunk → passive observer catches → `broken`. Current stream terminates with SSE `{error: ...}`; subsequent requests return 503. |
| 12 | `refresh_token` revoked (user removed access in Google account) | Probe fails with `invalid_grant` → `broken` → bot posts new Login. |
| 13 | No internet / Telegram API unreachable | grammy retries polling itself; `bot.catch` logs; process does not crash. |
| 14 | Process restarts while `pending` | Pending state is not persisted; on restart the on-disk creds are still missing → `broken` → bot posts fresh Login. |
| 15 | Garbage input to `submitCallbackUrl` | Extractor throws `InvalidCallbackUrlError`; bot replies "Could not parse URL — expected something like `http://…/oauth2callback?code=…&state=…`." |
| 16 | Docker without `~/.gemini` mounted | Tokens persist for container lifetime only — same as today. README note. |
| 17 | `/logout` while a stream is active | Stream is NOT interrupted; new requests return 503; bot posts Login. |
| 18 | Many concurrent `/v1/chat/completions` during `broken` | Each gets 503 independently; bot sends only one message thanks to 60 s dedup. |
| 19 | Telegram revokes bot token mid-run (401) | grammy throws fatally; catch, log, stop bot module; proxy keeps running; no more alerts until restart. |
| 20 | Probe transport failure | `probeFailed` only. 3 consecutive transport failures escalate to `reportAuthFailure`. |

## 9. Changes to existing files

- `src/chatwrapper.ts` — drop module-level `generatorPromise`. Call
  `authController.getGenerator()` inside `sendChat` / `sendChatStream` /
  `embedContent`. Instrument success and failure with
  `healthMonitor.onSuccess/onFailure`. `AuthBrokenError` propagates
  unchanged so `server.ts` can map it to 503.
- `src/server.ts` — on startup: construct `AuthController`, start
  `CallbackServer` (if oauth-personal), start `HealthMonitor`, start
  `TelegramBot` (if both env vars). Map `AuthBrokenError` to HTTP 503 with
  hint `"Gemini auth is not active — authenticate via Telegram bot or open
  http://host:{OAUTH_CALLBACK_PORT}/oauth2callback?…"`. Other errors keep
  today's status mapping. `/health` always returns 200 and includes
  `authState` and `callbackServerReady`. `/v1/models` does NOT require
  auth: it returns `[{ id: authController.getSnapshot().model ?? (process.env.MODEL || 'gemini-2.5-pro'), object: 'model', owned_by: 'google' }]`. Once the
  generator has been created at least once, `snapshot.model` is populated
  from `cfg.model`; before that we fall back to `MODEL` env or a sensible
  default so `/v1/models` stays responsive for clients that probe it
  pre-login.
- `package.json` — add `grammy` dependency. `google-auth-library` is already
  a transitive dependency of `@google/gemini-cli-core`; add it explicitly if
  needed to avoid fragility.
- `README.md` — new section documenting `TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_USER_ID`, the paste-URL flow, and the ability to run without
  exposing port 8085.
- `Dockerfile` — comment clarifying 8085 can be omitted when the bot is
  used for auth.
- `src/oauth-preflight.ts` — deleted. Helpers moved to `src/auth/oauth-flow.ts`.

## 10. Environment variables (summary)

Unchanged: `PORT`, `AUTH_TYPE`, `GEMINI_API_KEY`, `OAUTH_CALLBACK_PORT`,
`MODEL`, `GEMINI_OAUTH_CLIENT_ID`, `GEMINI_OAUTH_CLIENT_SECRET`.

New:

- `TELEGRAM_BOT_TOKEN` — Bot API token from BotFather. Required to enable
  the bot.
- `TELEGRAM_USER_ID` — numeric Telegram user id of the only allowed
  operator. Required to enable the bot.

## 11. Testing

- Unit tests for `url-extractor.ts` (full URL, bare query, embedded,
  garbage, duplicated params).
- Unit tests for `AuthController` state transitions using a fake
  `OAuth2Client` and a fake clock (debounce, timeout, state mismatch,
  concurrent `startLogin`).
- Unit tests for `health-monitor`'s sliding window and escalation rules.
- Integration test: `callback-server` + `auth-controller` — drive a full
  OAuth exchange with a fake token endpoint.
- Manual smoke: run locally with a real BotFather token and
  `AUTH_TYPE=oauth-personal`; verify the paste-URL path, probe alert,
  mute/unmute, and 503 responses.

The repo currently has no test infrastructure; the implementation plan
will decide whether to add `vitest` or `node --test`.
