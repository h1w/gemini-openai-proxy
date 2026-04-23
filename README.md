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

### Optional env vars

```sh
PORT=11434

# can be any of 'oauth-personal', 'gemini-api-key', 'vertex-ai'. Use oauth-personal for free access to Gemini 2.5 Pro by logging in to a Google account.
AUTH_TYPE='gemini-api-key' 

# API key is only used with AUTH_TYPE='gemini-api-key'
GEMINI_API_KEY=

# Fixed port for the OAuth2 callback server (only used with AUTH_TYPE='oauth-personal').
# Must be reachable from your browser; in Docker, map it with `-p 8085:8085`.
OAUTH_CALLBACK_PORT=8085

# Pick one of the models available via oauth-personal (Code Assist):
#   gemini-3.1-pro-preview
#   gemini-3-flash-preview
#   gemini-3.1-flash-lite-preview
#   gemini-2.5-pro
#   gemini-2.5-flash
#   gemini-2.5-flash-lite
# Leave empty to let CLI choose its default model.
MODEL=
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