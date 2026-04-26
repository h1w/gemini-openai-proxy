# Gemini ↔︎ OpenAI Proxy

This program is a [Gemini CLI](https://github.com/google-gemini/gemini-cli) wrapper that exposes Google Gemini (2.5 Pro / Flash, 3.x preview) through an **OpenAI-compatible API**. Plug-and-play with clients that already speak OpenAI: SillyTavern, llama.cpp, LangChain, Cline (VS Code), OpenClaw, etc.

---

## Features

| ✔ | Feature | Notes |
|---|---------|-------|
| `/v1/chat/completions` | Non-stream & stream (SSE) | curl, ST, LangChain, Cline, OpenClaw… |
| Multi-turn history | `system` / `user` / `assistant` / `tool` roles | system → Gemini `systemInstruction` |
| Vision support | `image_url` → Gemini `inlineData` | |
| Function / Tool calling | OpenAI `tools` + `tool_choice` → Gemini `functionDeclarations` / `toolConfig`; replies emit `tool_calls` | MCP-compatible clients work end-to-end |
| Gemini 3.x `thought_signature` round-trip | Carried via `tool_call.id` prefix + in-memory fallback cache | No HTTP 400 on replay from thinking models |
| Reasoning / chain-of-thought | `thinkingConfig.includeThoughts`, streams `<think>` chunks | ST shows grey bubbles |
| `/v1/embeddings` | Gemini `batchEmbedContents` (default `gemini-embedding-001`) | `gemini-api-key` / `vertex-ai` → native. `oauth-personal` → needs additional `GEMINI_API_KEY` env var (Google's embed endpoint is API-key-only) |
| `/v1/models` + `/v1/models/{id}` | Active model metadata | |
| `GET /` / `GET /health` | Simple JSON `{status:"ok"}` | For Docker/k8s probes |
| CORS | Enabled (`*`) by default | Ready for browser apps |

---

## Quick start — Docker Compose (recommended)

The shipped `docker-compose.yml` reads every setting from a `.env` file next to it, so there is nothing to tweak on the command line.

```sh
git clone https://github.com/h1w/gemini-openai-proxy
cd gemini-openai-proxy
cp .env.example .env
# edit .env — see the "Environment variables" section below
docker compose up -d --build
sudo docker logs -f gemini-openai-proxy
```

Update workflow:

```sh
git pull
docker compose build --no-cache
docker compose up -d
```

### What compose creates

- **Container** `gemini-openai-proxy` with `restart: unless-stopped`.
- **Ports** (driven by `.env`):
  - `${PORT:-11434}` — the OpenAI-compatible HTTP API. Point your client here.
  - `${OAUTH_CALLBACK_PORT:-8085}` — the local OAuth2 callback endpoint. Only needed for `AUTH_TYPE=oauth-personal` if you complete login via a browser. If you use the **Telegram bot paste-URL flow** (see below), comment this port line out in `docker-compose.yml`.
- **Named volume** `gemini-config` mounted at `/root/.gemini` — persists OAuth tokens across `down` / `up` cycles. Swap for a bind mount (`${HOME}/.gemini:/root/.gemini`) if you want the tokens visible on the host.

### First-run OAuth (`AUTH_TYPE=oauth-personal`)

On startup with no cached tokens the proxy prints an authorization URL. Three ways to complete the flow:

1. **Browser on the same host.** Open the URL. Google redirects to `http://localhost:8085/oauth2callback?code=…` which the container receives via the published port.
2. **Telegram bot paste-URL flow.** Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_USER_ID` in `.env`. The bot DMs you the URL; after sign-in copy the final browser URL (the one with `?code=&state=`) and paste it back into the chat. The proxy extracts the code itself — port 8085 does not need to be exposed.
3. **Own OAuth client.** Set `GEMINI_OAUTH_CLIENT_ID` / `GEMINI_OAUTH_CLIENT_SECRET` in `.env` to override the credentials bundled with `@google/gemini-cli`.

Tokens land in the `gemini-config` volume and are reused automatically on subsequent starts.

---

## Environment variables

Copy `.env.example` to `.env` and edit. All values are optional unless noted.

### Core

| Variable | Default | Notes |
|----------|---------|-------|
| `PORT` | `11434` | HTTP port the proxy listens on (host + container). |
| `AUTH_TYPE` | `gemini-api-key` | One of `oauth-personal`, `gemini-api-key`, `vertex-ai`. Current build is tuned for `oauth-personal`. |
| `GEMINI_API_KEY` | — | Required when `AUTH_TYPE=gemini-api-key`. Also required for `/v1/embeddings` under `oauth-personal`. |
| `MODEL` | (full catalog) | Comma-separated whitelist of model ids the proxy will accept on `/v1/chat/completions`. Empty → full Code Assist catalog. The client must pick one per request via OpenAI's `model` field; values outside the whitelist are rejected with HTTP 400. See list below. |
| `CLI_VERSION` | `0.39.1` | Gemini CLI version impersonated in the `User-Agent`. Bump to track upstream. |

### OAuth (`AUTH_TYPE=oauth-personal`)

| Variable | Default | Notes |
|----------|---------|-------|
| `OAUTH_CALLBACK_PORT` | `8085` | Fixed port for the OAuth2 callback HTTP server. Only used during login. Skip exposing it if you rely on the Telegram paste-URL flow. |
| `GEMINI_OAUTH_CLIENT_ID` | — | Override the bundled installed-app client id. Usually leave blank. |
| `GEMINI_OAUTH_CLIENT_SECRET` | — | Paired secret for the override above. |

### Telegram bot (login + health monitoring, optional)

Set **both** values to enable. If either is missing the bot stays off and the proxy runs unchanged. Only messages from `TELEGRAM_USER_ID` are ever answered.

| Variable | Notes |
|----------|-------|
| `TELEGRAM_BOT_TOKEN` | From `@BotFather`. |
| `TELEGRAM_USER_ID` | Your numeric Telegram user id — ask `@userinfobot`. |

When enabled, the bot:

- Posts a Google OAuth login URL when authentication is missing or broken.
- Lets you finish login by pasting the post-redirect URL back into the chat (no open port required).
- Runs a 10-minute token probe and passively watches live Gemini calls; if auth breaks it alerts with a one-tap **Login** button.
- Exposes `/login`, `/logout`, `/status`, `/ping`, `/errors`, `/mute`, `/unmute`.

### Supported `MODEL` values

`MODEL` is a whitelist. All ids in it become selectable per request via
OpenAI's `model` field, and the same list is what `/v1/models` returns. The
proxy never picks a model on the client's behalf — a missing or
non-whitelisted `model` returns HTTP 400.

Separators are flexible: commas, spaces, and newlines all work.

Via `AUTH_TYPE=oauth-personal` (Code Assist):

- `gemini-3.1-pro-preview`
- `gemini-3-flash-preview`
- `gemini-3.1-flash-lite-preview`
- `gemini-2.5-pro`
- `gemini-2.5-flash`
- `gemini-2.5-flash-lite`

Examples (all three behave identically):

```env
# Single value — back-compat with the old setup:
MODEL=gemini-2.5-pro

# Comma-separated:
MODEL=gemini-2.5-pro,gemini-2.5-flash,gemini-3.1-pro-preview

# Multi-line list (quote the value so .env parsers keep newlines):
MODEL="
gemini-2.5-pro
gemini-2.5-flash
gemini-3.1-pro-preview
"

# Empty / unset → full catalog above.
MODEL=
```

`docker compose` reads `.env` via `env_file:` and forwards the value to the
container unchanged — multi-line values work as long as you keep the quotes.

If a preview SKU returns `MODEL_CAPACITY_EXHAUSTED` consistently, the client should switch to a GA model (`gemini-2.5-pro`).

---

## Alternative setups

### npm (local dev)

```sh
git clone https://github.com/h1w/gemini-openai-proxy
cd gemini-openai-proxy
npm install
npm start # port 11434 by default
```

Reads the same environment variables. For OAuth login it uses `~/.gemini` on the host directly.

### Plain Docker (without compose)

```sh
docker build --tag gemini-openai-proxy .
docker run -d --name gemini-openai-proxy \
  -p 11434:11434 \
  -p 8085:8085 \
  -e AUTH_TYPE=oauth-personal \
  -v "$HOME/.gemini:/root/.gemini" \
  gemini-openai-proxy
```

Swap `-e AUTH_TYPE=oauth-personal` for `-e AUTH_TYPE=gemini-api-key -e GEMINI_API_KEY=...` if you prefer API-key auth and you can drop the `-p 8085:8085`.

---

## Smoke test

```sh
curl -X POST http://localhost:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-pro",
    "messages":[{"role":"user","content":"Hello Gemini!"}]
  }'
```

Tail the logs to confirm the request landed:

```
➜ POST /v1/chat/completions
➜ mapped: user[text:Hello Gemini!] | tools=0
✓ response: finish=STOP parts=1
```

### SillyTavern

Chat completion → **API Base URL** `http://127.0.0.1:11434/v1` → leave API key blank (or any string).

---

## Troubleshooting

- **`HTTP 503 Gemini auth is not active`** — finish the OAuth login (browser or Telegram paste-URL flow). Tokens are cached under `/root/.gemini`.
- **`HTTP 400 missing thought_signature`** — should not happen on current builds. If it does, the client is rewriting `tool_call.id` AND the in-memory signature cache is empty; raise an issue with the log line starting with `↳ tool_call replay`.
- **`HTTP 429 MODEL_CAPACITY_EXHAUSTED`** — Google-side quota on a preview SKU. Retry later or switch `MODEL=gemini-2.5-pro`.
- **`⚠ empty response: finish=...`** in the log — Gemini returned 200 with no candidate content. Common `finish` values: `MAX_TOKENS`, `SAFETY`, `RECITATION`, `BLOCKLIST`, `PROHIBITED_CONTENT`. Shorten the history, raise `max_tokens`, or rephrase the prompt.

---

## License

MIT — free for personal & commercial use. Forked from <https://huggingface.co/engineofperplexity/gemini-openai-proxy>.
