# OAuthRouter

OpenClaw plugin scaffold for OAuth-based model/provider routing.

This repository was cloned from **ClawRouter** and is being re-scaffolded:

- Rebranded **clawrouter → oauthrouter**
- **x402 / wallet payment flow removed/disabled** (stubs remain temporarily)
- **BlockRun provider wiring disabled**

## Status

This is an _initial scaffold_.

- The plugin loads, but **does not register any providers** yet.
- The legacy proxy/payment APIs exist only as disabled stubs to keep the codebase compiling while OAuth-based wiring is implemented.

## Programmatic routing engine

The local routing engine (from the original codebase) is still exported:

```ts
import { route, DEFAULT_ROUTING_CONFIG } from "@marcus-clawdbot/oauthrouter";

const decision = route("Summarize this article");
console.log(decision);
```

## Development

```bash
npm install
npm run build
npm run typecheck
```
