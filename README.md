# OAuthRouter

**Sell-first summary:** OAuthRouter is a drop‑in **OpenAI‑compatible proxy** that lets you **route across Claude + Codex with OAuth**, **auto‑pick the cheapest capable model**, and **see every request live** — without changing your client code.

**Why teams use it:**

- _Cut costs fast_ with tiered auto‑routing (SIMPLE → REASONING)
- _Stay reliable_ with multi‑provider fallbacks
- _Keep OAuth clean_ (Anthropic OAuth, Codex OAuth, Claude Code compatibility)
- _Debug in real time_ with a live dashboard + routing trace
- _Ship safely_ with spend caps and request guards

Built as an [OpenClaw](https://openclaw.ai) plugin but usable standalone.

## Features (At a Glance)

- **Multi‑provider routing** — Anthropic (Claude), OpenAI Codex, and any OpenAI‑compatible endpoint via `/v1/chat/completions`
- **Smart auto‑routing** — Rules‑based classifier (<1ms) chooses the cheapest capable tier
- **OAuth‑native** — Anthropic OAuth tokens (`sk-ant-oat-*`) + OpenAI Codex OAuth with Claude Code compatibility
- **Tool‑call translation** — OpenAI tool calls ↔ Anthropic `tool_use`, including streaming
- **Spend controls** — Per‑request + daily budgets (tokens + requests)
- **Debug dashboard** — Live request feed with tier, model, latency, status
- **Routing trace API** — SSE stream + JSONL persistence for audits/analytics
- **Streaming** — Full SSE support for both Anthropic and Codex upstreams

## Quick Start

### Install

```bash
npm install @marcus-clawdbot/oauthrouter
```

### Programmatic Usage

```ts
import { startProxy, getAnthropicAuthHeader } from "@marcus-clawdbot/oauthrouter";

const authHeader = getAnthropicAuthHeader();

const handle = await startProxy({
  providers: {
    anthropic: {
      apiBase: "https://api.anthropic.com",
      authHeader: { name: "Authorization", value: authHeader.Authorization },
    },
  },
  port: 8402,
  authToken: "my-secret-token",
});

console.log(`Proxy running at ${handle.baseUrl}`);

// Send requests using any OpenAI-compatible client
// curl http://127.0.0.1:8402/v1/chat/completions \
//   -H "Authorization: Bearer my-secret-token" \
//   -d '{"model":"anthropic/claude-haiku-4-5","messages":[...]}'
```

### Multi-Provider Setup

```ts
const handle = await startProxy({
  providers: {
    anthropic: {
      apiBase: "https://api.anthropic.com",
      authHeader: { name: "Authorization", value: "Bearer sk-ant-oat01-..." },
    },
    "openai-codex": {
      apiBase: "https://chatgpt.com",
      // OAuth tokens are auto-loaded from OpenClaw auth-profiles.json
    },
  },
  port: 8402,
  authToken: "my-secret-token",
});
```

## Auto-Routing

Set `model: "auto"` (or any model ID starting with `auto`) and OAuthRouter classifies the prompt into a complexity tier and routes to the cheapest capable model.

```bash
curl http://127.0.0.1:8402/v1/chat/completions \
  -H "Authorization: Bearer my-secret-token" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"hi"}]}'
```

### Default Tier Mapping

| Tier          | Primary Model                 | When                                        |
| ------------- | ----------------------------- | ------------------------------------------- |
| **SIMPLE**    | `anthropic/claude-haiku-4-5`  | Short, simple queries ("hi", "what's 2+2?") |
| **MEDIUM**    | `openai-codex/gpt-5.2-codex`  | Code generation, moderate complexity        |
| **COMPLEX**   | `anthropic/claude-sonnet-4-5` | Multi-step reasoning, system design         |
| **REASONING** | `anthropic/claude-opus-4-6`   | Mathematical proofs, deep analysis          |

### Custom Routing Config

```ts
import { startProxy, DEFAULT_ROUTING_CONFIG } from "@marcus-clawdbot/oauthrouter";

const handle = await startProxy({
  // ...providers
  routingConfig: {
    ...DEFAULT_ROUTING_CONFIG,
    tiers: {
      SIMPLE: { primary: "anthropic/claude-haiku-4-5", fallback: [] },
      MEDIUM: { primary: "anthropic/claude-sonnet-4-5", fallback: [] },
      COMPLEX: { primary: "anthropic/claude-sonnet-4-5", fallback: [] },
      REASONING: { primary: "anthropic/claude-opus-4-6", fallback: [] },
    },
  },
});
```

### Routing Engine (Standalone)

The classification engine can be used independently without starting a proxy:

```ts
import { route, DEFAULT_ROUTING_CONFIG } from "@marcus-clawdbot/oauthrouter";

const decision = route("Prove that sqrt(2) is irrational", undefined, 4096, {
  config: DEFAULT_ROUTING_CONFIG,
  modelPricing: new Map([
    ["anthropic/claude-haiku-4-5", { inputPrice: 0.25, outputPrice: 1.25 }],
    ["anthropic/claude-sonnet-4-5", { inputPrice: 3, outputPrice: 15 }],
  ]),
});

console.log(decision);
// {
//   model: "anthropic/claude-opus-4-6",
//   tier: "REASONING",
//   confidence: 0.97,
//   method: "rules",
//   reasoning: "score=0.18 | reasoning (prove, proof)",
//   costEstimate: ...,
//   savings: ...
// }
```

## API Translation

OAuthRouter accepts standard **OpenAI Chat Completions** requests and translates them to the native API for each provider.

### Anthropic Translation

| OpenAI Format                        | Anthropic Format                                  |
| ------------------------------------ | ------------------------------------------------- |
| `role: "system"` messages            | `system` parameter                                |
| `role: "user"` / `role: "assistant"` | `messages` array                                  |
| `role: "tool"` with `tool_call_id`   | `tool_result` content block inside `user` message |
| `tools` array                        | `tools` array (with `input_schema`)               |
| `tool_choice: "auto"`                | `tool_choice: { type: "auto" }`                   |
| `tool_choice: "required"`            | `tool_choice: { type: "any" }`                    |
| `finish_reason: "tool_calls"`        | `stop_reason: "tool_use"`                         |
| SSE `chat.completion.chunk`          | SSE `content_block_delta` / `message_delta`       |

### Anthropic OAuth Token Compatibility

When using Anthropic OAuth tokens (`sk-ant-oat-*`), OAuthRouter automatically:

1. Sets required `anthropic-beta` flags (`claude-code-20250219`, `oauth-2025-04-20`, `fine-grained-tool-streaming-2025-05-14`, `interleaved-thinking-2025-05-14`)
2. Sets the correct `user-agent` header (`claude-cli/2.1.2 (external, cli)`)
3. Moves custom system prompts into message context (the `system` field must contain only the Claude Code preamble for OAuth validation)
4. Remaps tool names to PascalCase and remaps them back in responses

This is all transparent - you don't need to do anything special.

#### Tool Name Remapping

Anthropic OAuth tokens require tool names to match Claude Code's PascalCase convention. OAuthRouter converts tool names automatically before sending upstream and converts them back in responses:

| Your Tool Name     | Sent to Anthropic |
| ------------------ | ----------------- |
| `read`             | `Read`            |
| `write`            | `Write`           |
| `edit`             | `Edit`            |
| `exec`             | `Exec`            |
| `web_search`       | `WebSearch`       |
| `web_fetch`        | `WebFetch`        |
| `memory_search`    | `MemorySearch`    |
| `memory_get`       | `MemoryGet`       |
| `agents_list`      | `AgentsList`      |
| `sessions_list`    | `SessionsList`    |
| `sessions_history` | `SessionsHistory` |
| `sessions_send`    | `SessionsSend`    |
| `session_status`   | `SessionStatus`   |

The conversion rule is: split on `_`, `-`, or spaces, capitalize each word, and join. Single-word names just get capitalized (e.g., `browser` -> `Browser`). Names already in PascalCase are left unchanged. Response tool calls are remapped back to the original names so your application never sees the PascalCase versions.

### OpenAI Codex Translation

OpenAI Chat Completions requests are translated to the Codex Responses API format (`/backend-api/codex/responses`), including automatic OAuth token refresh.

## Spend Controls

Guard against runaway costs with token and request budgets:

```ts
const handle = await startProxy({
  // ...providers
  spendControls: {
    maxRequestInputTokens: 50000, // Max input tokens per request
    maxRequestOutputTokens: 8192, // Max output tokens per request
    dailyInputTokenBudget: 1000000, // Daily input token cap
    dailyOutputTokenBudget: 200000, // Daily output token cap
    dailyRequestBudget: 500, // Daily request cap
    allowlistModels: ["anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-4-5"],
    // denylistModels: ["anthropic/claude-opus-4-6"],
  },
});
```

## Debug Dashboard

A built-in real-time dashboard shows every routed request:

```
http://127.0.0.1:8402/debug/dashboard?token=<your-auth-token>
```

The dashboard displays:

- Timestamp, provider, resolved model, tier, and confidence
- Upstream URL, HTTP status, and latency
- Live streaming via SSE (auto-updates as requests flow through)

### Routing Trace API

```bash
# Get recent trace events (JSON)
curl "http://127.0.0.1:8402/debug/routing-trace?token=<token>"

# Stream events in real-time (SSE)
curl "http://127.0.0.1:8402/debug/routing-trace/stream?token=<token>"
```

Trace events are also persisted to `~/.openclaw/oauthrouter/logs/routing-trace.jsonl`.

### View Dashboard From Another Laptop (Recommended: SSH Port Forward)

Keep the proxy bound to localhost (default) and forward the port over SSH.

1. On your laptop:

```bash
ssh -L 8402:127.0.0.1:8402 <user>@<mac-mini-host>
```

2. In your laptop browser:

```text
http://127.0.0.1:8402/debug/dashboard?token=<your-auth-token>
```

### Optional: Bind Proxy To LAN (Not Recommended)

If you really want direct LAN access, bind the proxy to all interfaces:

```bash
OAUTHROUTER_LISTEN_HOST=0.0.0.0 OAUTHROUTER_PORT=8402 node scripts/openclaw-proxy.mjs
```

This exposes the port on your network. The proxy is token-gated, but you should still prefer SSH forwarding.

## OpenClaw Integration

OAuthRouter is designed as an OpenClaw plugin. See [docs/openclaw-runbook.md](docs/openclaw-runbook.md) for full setup instructions.

### Quick OpenClaw Setup

1. Configure the provider in `~/.openclaw/openclaw.json`:

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "oauthrouter/auto"
      },
      "models": {
        "oauthrouter/auto": {
          "provider": "oauthrouter",
          "contextWindow": 200000,
          "maxTokens": 128000
        }
      }
    }
  }
}
```

2. Authenticate with Anthropic:

```bash
openclaw models auth login --provider anthropic
```

3. Start the proxy and gateway:

```bash
# Start proxy
node --input-type=module -e '
import { startProxy, getAnthropicAuthHeader } from "./dist/index.js";
const auth = getAnthropicAuthHeader();
await startProxy({
  providers: {
    anthropic: {
      apiBase: "https://api.anthropic.com",
      authHeader: { name: "Authorization", value: auth.Authorization },
    },
  },
  port: 8402,
});
'

# Start OpenClaw gateway
openclaw gateway --force --verbose
```

## Auth Profile Helpers

OAuthRouter includes helpers for reading OpenClaw's auth-profiles.json:

```ts
import {
  getAnthropicAuthHeader,
  getAnthropicApiKeyHeader,
  getOpenAiAuthHeader,
  getOpenAICodexAuthHeader,
} from "@marcus-clawdbot/oauthrouter";

// Returns { Authorization: "Bearer sk-ant-oat01-..." }
const anthropicAuth = getAnthropicAuthHeader();

// Returns { "x-api-key": "sk-ant-api03-..." }
const anthropicApiKey = getAnthropicApiKeyHeader();

// Returns { Authorization: "Bearer sk-..." }
const openaiAuth = getOpenAiAuthHeader();

// Returns { Authorization: "Bearer ...", profileId: "...", refreshed: boolean }
const codexAuth = await getOpenAICodexAuthHeader();
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch mode
npm run dev

# Type check
npm run typecheck

# Run tests
npm test

# Lint
npm run lint
```

## Architecture

```
                    ┌─────────────────────────────┐
                    │     Client (OpenAI SDK)      │
                    │  POST /v1/chat/completions   │
                    └──────────────┬──────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │        OAuthRouter           │
                    │    http://127.0.0.1:8402     │
                    │                              │
                    │  ┌────────────────────────┐  │
                    │  │   Auth & Spend Guard   │  │
                    │  └───────────┬────────────┘  │
                    │              │                │
                    │  ┌───────────▼────────────┐  │
                    │  │   Smart Router (auto)  │  │
                    │  │   14-dim rules <1ms    │  │
                    │  └───────────┬────────────┘  │
                    │              │                │
                    │  ┌───────────▼────────────┐  │
                    │  │   Provider Adapters     │  │
                    │  │  Anthropic │ Codex      │  │
                    │  └─────┬─────┴──────┬─────┘  │
                    └────────┼────────────┼────────┘
                             │            │
              ┌──────────────▼──┐  ┌──────▼───────────┐
              │  Anthropic API  │  │  ChatGPT Codex   │
              │  /v1/messages   │  │  /codex/responses │
              └─────────────────┘  └──────────────────┘
```

## License

MIT
