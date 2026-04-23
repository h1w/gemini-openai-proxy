# Gemini ↔︎ OpenAI Proxy

This program is a [Gemini CLI](https://github.com/google-gemini/gemini-cli) wrapper that can serve **Google Gemini 2.5 Pro** (or Flash) through an **OpenAI-compatible API**.
Plug-and-play with clients that already speak OpenAI like SillyTavern, llama.cpp, LangChain, the VS Code *Cline* extension, etc.

---

## Features

| ✔ | Feature | Notes |
|---|---------|-------|
| `/v1/chat/completions` | Non-stream & stream (SSE) | Works with curl, ST, LangChain, Cline, OpenClaw… |
| Multi-turn history | `system` / `user` / `assistant` / `tool` roles | system → Gemini `systemInstruction` |
| Vision support | `image_url` → Gemini `inlineData` | |
| Function / Tool calling | OpenAI `tools` + `tool_choice` → Gemini `functionDeclarations` / `toolConfig`; replies emit `tool_calls` | MCP-compatible clients work end-to-end |
| Reasoning / chain-of-thought | `thinkingConfig.includeThoughts`, streams `<think>` chunks | ST shows grey bubbles |
| `/v1/embeddings` | Gemini `batchEmbedContents` (default `gemini-embedding-001`) | `gemini-api-key` / `vertex-ai` → native. `oauth-personal` → needs additional `GEMINI_API_KEY` env var (Google's embed endpoint is API-key-only; user OAuth tokens are rejected on every host: cloudcode-pa, generativelanguage, Vertex AI) |
| `/v1/models` + `/v1/models/{id}` | Active model metadata | |
| `GET /` / `GET /health` | Simple JSON `{status:"ok"}` | For Docker/k8s probes |
| CORS | Enabled (`*`) by default | Ready for browser apps |

---

## Quick start

### With npm

```bash
git clone https://github.com/Brioch/gemini-openai-proxy
cd gemini-openai-proxy
npm i
npm start # launch (runs on port 11434 by default)
```

### With Docker

Alternatively, you can use the provided Dockerfile to build a Docker image.

```sh
docker build --tag "gemini-openai-proxy" .
docker run -p 11434:80 -e GEMINI_API_KEY gemini-openai-proxy
```

#### Docker + `AUTH_TYPE=oauth-personal`

OAuth login needs a callback URL that your browser can reach. The proxy runs
its OAuth flow on a **fixed** port (`OAUTH_CALLBACK_PORT`, default `8085`) so
you can map it out of the container. You should also mount `~/.gemini` so the
resulting tokens survive container restarts:

```sh
docker run \
  -p 11434:80 \
  -p 8085:8085 \
  -e AUTH_TYPE=oauth-personal \
  -v "$HOME/.gemini:/root/.gemini" \
  gemini-openai-proxy
```

On first run, the container logs an authorization URL. Open it in a browser on
the host, complete sign-in, and Google will redirect to
`http://localhost:8085/oauth2callback?code=…`, which the container receives via
the mapped port. Tokens are cached and reused on subsequent runs.

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

### Optional env vars

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

### Minimal curl test

```bash
curl -X POST http://localhost:11434/v1/chat/completions \
     -H "Content-Type: application/json" \
     -d '{
       "model": "gemini-2.5-pro-latest",
       "messages":[{"role":"user","content":"Hello Gemini!"}]
     }'
```

### SillyTavern settings

Chat completion
API Base URL http://127.0.0.1:11434/v1



## License

MIT – free for personal & commercial use. Forked from https://huggingface.co/engineofperplexity/gemini-openai-proxy