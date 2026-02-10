# OpenClaw ↔ OAuthRouter local proxy (runbook)

This doc shows a **fully explicit** setup for running OAuthRouter as a localhost proxy
and pointing OpenClaw at it—no “silent edits”.

## What this enables (today)

- OAuthRouter listens on `127.0.0.1` and requires a **local auth token** on every request.
- OpenClaw talks to OAuthRouter using standard OpenAI-compatible endpoints:
  - `POST /v1/chat/completions`
- OAuthRouter routes upstream based on the _model id prefix_:
  - `openai/*` → OpenAI upstream
  - `anthropic/*` → Anthropic upstream (adapter)
  - `openai-codex/*` → ChatGPT Codex upstream (adapter)

Key point: you do **not** need (or want) OpenClaw’s native `openai-codex` provider here.
OpenClaw should speak OpenAI-compat to OAuthRouter; OAuthRouter will handle the Codex `/backend-api/*` translation internally.

---

## 1) Build

```bash
cd oauthrouter
npm install
npm run build
```

---

## 2) Start the proxy (explicit upstream provider config)

### Required env vars

```bash
export OAUTHROUTER_LOCAL_TOKEN="change-me-long-random"

# Upstream creds (examples)
export OPENAI_API_KEY="sk-..."                  # optional unless you want openai/*
export ANTHROPIC_API_KEY="sk-ant-..."           # can be OAuth (sk-ant-oat...) or API key
export DEEPSEEK_API_KEY="sk-..."                # optional unless you want deepseek/* or rate-limit fallback
```

### Start command (keeps running)

Notes:

- `providers.*.apiBase` must be a host **without** `/v1` (OAuthRouter appends paths).
- Anthropic:
  - If the token starts with `sk-ant-oat...`, OAuthRouter will send it upstream as
    `Authorization: Bearer ...` and add Claude Code-like compatibility headers.
  - Otherwise it will use `x-api-key`.

```bash
node --input-type=module -e '
import { startProxy, getAnthropicAuthHeader } from "./dist/index.js";

// If you want OAuthRouter to load Anthropic token from OpenClaw profiles instead,
// skip getAnthropicAuthHeader() and pass it explicitly via env.

const proxy = await startProxy({
  port: 8402,
  authToken: process.env.OAUTHROUTER_LOCAL_TOKEN,

  providers: {
    openai: {
      apiBase: "https://api.openai.com",
      authHeader: process.env.OPENAI_API_KEY ? `Bearer ${process.env.OPENAI_API_KEY}` : undefined,
    },
    anthropic: {
      apiBase: "https://api.anthropic.com",
      authHeader: { name: "x-api-key", value: process.env.ANTHROPIC_API_KEY },
    },

    // Codex adapter: OAuthRouter will load/refresh via OpenClaw auth-profiles.json
    // (openclaw models auth login --provider openai-codex)
    "openai-codex": {
      apiBase: "https://chatgpt.com",
    },

    // DeepSeek (OpenAI-compatible). Requires an API key.
    // deepseek/* model ids are normalized to upstream ids (e.g. deepseek/deepseek-chat -> deepseek-chat).
    deepseek: {
      apiBase: "https://api.deepseek.com",
      authHeader: process.env.DEEPSEEK_API_KEY ? `Bearer ${process.env.DEEPSEEK_API_KEY}` : undefined,
    },
  },

  // Provider-aware fallback: if Anthropic returns HTTP 429, re-issue the same request to DeepSeek.
  // This avoids relying on OpenClaw model fallbacks (which can't replay the same request/stream).
  rateLimitFallback: {
    enabled: true,
    fromProviders: ["anthropic"],
    onStatusCodes: [429],
    chain: [
      // First fallback: Codex (lots of capacity)
      { provider: "openai-codex", defaultModel: "openai-codex/gpt-5.3-codex" },
      // Third fallback: DeepSeek (API key)
      { provider: "deepseek", defaultModel: "deepseek/deepseek-chat" },
    ],
  },
});

console.log(`oauthrouter proxy listening: ${proxy.baseUrl}`);
console.log(`local auth token required on every request`);
await new Promise(() => {});
'
```

Health endpoint (still requires local token):

- `GET /health`

## View /debug/dashboard from another machine (SSH port forward)

If you SSH into the Mac mini from your laptop, the safest way to view the debug dashboard is SSH local port forwarding (keep OAuthRouter bound to `127.0.0.1`).

1. On your laptop:

```bash
ssh -L 8402:127.0.0.1:8402 <user>@<mac-mini-host>
```

2. In your laptop browser:

```text
http://127.0.0.1:8402/debug/dashboard?token=<OAUTHROUTER_LOCAL_TOKEN>
```

## Optional: bind to LAN (not recommended)

If you want LAN access without SSH forwarding, bind the proxy to all interfaces:

```js
const proxy = await startProxy({
  port: 8402,
  listenHost: "0.0.0.0",
  authToken: process.env.OAUTHROUTER_LOCAL_TOKEN,
  // ...
});
```

This exposes the port on your network. The proxy is token-gated, but SSH forwarding is recommended.

---

## 3) Local auth token: what OpenClaw must send

OAuthRouter requires a local token on **every** request. It accepts any of:

- `Authorization: Bearer <OAUTHROUTER_LOCAL_TOKEN>` (recommended)
- `x-api-key: <OAUTHROUTER_LOCAL_TOKEN>`
- `x-openai-api-key: <OAUTHROUTER_LOCAL_TOKEN>`

OAuthRouter strips these local auth headers and applies upstream auth using the
`providers[provider].authHeader` you configured when starting the proxy.

---

## 4) Point OpenClaw at OAuthRouter (recommended)

Add a dedicated provider that speaks **OpenAI-compatible** HTTP to OAuthRouter.

In `~/.openclaw/openclaw.json`:

```json5
{
  env: {
    OAUTHROUTER_LOCAL_TOKEN: "change-me-long-random",
  },

  models: {
    mode: "merge",
    providers: {
      oauthrouter: {
        // OAuthRouter exposes OpenAI-compatible endpoints under /v1
        baseUrl: "http://127.0.0.1:8402/v1",
        apiKey: "${OAUTHROUTER_LOCAL_TOKEN}",
        api: "openai-completions",

        // Minimal model catalog for OpenClaw UI/model picker
        models: [
          { id: "openai/gpt-4o-mini", name: "GPT-4o mini (via oauthrouter)" },
          { id: "anthropic/claude-sonnet-4", name: "Sonnet 4 (via oauthrouter)" },
          { id: "openai-codex/gpt-5.3-codex", name: "Codex 5.3 (via oauthrouter)" },
        ],
      },
    },
  },
}
```

Then select models like:

- `oauthrouter/openai/gpt-4o-mini`
- `oauthrouter/anthropic/claude-sonnet-4`
- `oauthrouter/openai-codex/gpt-5.3-codex`

---

## 5) Minimal end-to-end checks (curl)

### Health

```bash
curl -sS \
  -H "Authorization: Bearer $OAUTHROUTER_LOCAL_TOKEN" \
  http://127.0.0.1:8402/health
```

Expect: `{"status":"ok"}`

### Anthropic (via OpenAI chat.completions adapter)

```bash
curl -sS http://127.0.0.1:8402/v1/chat/completions \
  -H "Authorization: Bearer $OAUTHROUTER_LOCAL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "anthropic/claude-sonnet-4",
    "messages": [{"role":"user","content":"Say hello in one word."}],
    "max_tokens": 16
  }'
```

Expect: HTTP 200 + OpenAI-shaped response (`choices[0].message.content`).

### Codex (via OpenAI chat.completions → Codex adapter)

Pre-req (one-time): ensure OpenClaw has Codex OAuth tokens stored:

```bash
openclaw models auth login --provider openai-codex --set-default
```

Then:

```bash
curl -sS http://127.0.0.1:8402/v1/chat/completions \
  -H "Authorization: Bearer $OAUTHROUTER_LOCAL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai-codex/gpt-5.3-codex",
    "messages": [{"role":"user","content":"Return just the number: 2+2"}],
    "max_tokens": 16
  }'
```

Expect: HTTP 200 + OpenAI-shaped response.
