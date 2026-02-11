// OAuthRouter proxy runner for OpenClaw.
//
// Why this exists:
// - The proxy needs explicit runtime options (providers + rate-limit fallback chain).
// - We want a single, auditable entrypoint we can `nohup` / run under launchd.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  startProxy,
  getAnthropicAuthHeader,
  buildDefaultRateLimitFallbackChain,
} from "../dist/index.js";

// Hardening: log unexpected exits so "proxy died" is diagnosable.
process.on("uncaughtException", (err) => {
  console.error("[proxy] uncaughtException", err?.stack || String(err));
});
process.on("unhandledRejection", (reason) => {
  console.error(
    "[proxy] unhandledRejection",
    reason instanceof Error ? reason.stack || reason.message : String(reason),
  );
});
process.on("exit", (code) => {
  console.error(`[proxy] exit code=${code}`);
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    console.error(`[proxy] received ${sig}`);
  });
}

function readOpenClawJson() {
  try {
    const p = path.join(os.homedir(), ".openclaw", "openclaw.json");
    const txt = fs.readFileSync(p, "utf-8");
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

function resolveLocalProxyToken() {
  if (process.env.OAUTHROUTER_LOCAL_TOKEN && process.env.OAUTHROUTER_LOCAL_TOKEN.trim()) {
    return process.env.OAUTHROUTER_LOCAL_TOKEN.trim();
  }
  const cfg = readOpenClawJson();
  const t = cfg?.env?.vars?.OAUTHROUTER_LOCAL_TOKEN;
  return typeof t === "string" && t.trim() ? t.trim() : null;
}

function resolveDeepSeekApiKey() {
  // Prefer process env so operators can override without touching openclaw.json.
  if (process.env.DEEPSEEK_API_KEY && process.env.DEEPSEEK_API_KEY.trim()) {
    return process.env.DEEPSEEK_API_KEY.trim();
  }
  const cfg = readOpenClawJson();
  const t = cfg?.env?.vars?.DEEPSEEK_API_KEY;
  return typeof t === "string" && t.trim() ? t.trim() : "";
}

async function main() {
  const authToken = resolveLocalProxyToken();
  if (!authToken) {
    throw new Error(
      "Missing OAUTHROUTER_LOCAL_TOKEN (set env var or ensure ~/.openclaw/openclaw.json env.vars.OAUTHROUTER_LOCAL_TOKEN is present)",
    );
  }

  const deepseekKey = resolveDeepSeekApiKey();
  const hasDeepSeek = Boolean(deepseekKey);

  const anthropic = getAnthropicAuthHeader();

  // Single-source fallback chain config lives in src/fallback-config.ts (exported via dist/index.js).
  const chain = buildDefaultRateLimitFallbackChain(hasDeepSeek);

  const proxy = await startProxy({
    port: Number(process.env.OAUTHROUTER_PORT || "8402"),
    listenHost: process.env.OAUTHROUTER_LISTEN_HOST || "127.0.0.1",
    authToken,

    // Persist provider cooldowns across restarts so we can pre-route away from providers
    // that are currently rate-limited (avoids paying the initial 429 roundtrip).
    providerHealth: {
      enabled: true,
      // Default cooldown behavior is intentionally conservative; tune as needed.
      baseCooldownMs: 2 * 60_000,
      maxCooldownMs: 30 * 60_000,
      // Background probes (availability + latency). Override via env vars.
      probeIntervalMs: Number(process.env.OAUTHROUTER_PROBE_INTERVAL_MS || "1800000"),
      probeTimeoutMs: Number(process.env.OAUTHROUTER_PROBE_TIMEOUT_MS || "8000"),
    },

    providers: {
      anthropic: {
        apiBase: "https://api.anthropic.com",
        authHeader: { name: "Authorization", value: anthropic.Authorization },
      },
      "openai-codex": {
        apiBase: "https://chatgpt.com",
      },
      ...(hasDeepSeek
        ? {
            deepseek: {
              apiBase: "https://api.deepseek.com",
              authHeader: `Bearer ${deepseekKey}`,
            },
          }
        : {}),
    },

    // Critical fix: handle 429s inside the proxy so OpenClaw doesn't have to re-play the request/stream.
    rateLimitFallback: {
      enabled: true,
      // Keep this conservative; add providers as we gain confidence.
      fromProviders: ["anthropic", "openai-codex"],
      onStatusCodes: [429, 529],
      chain,
    },

    // Retries are only for transient gateway-ish failures; 429 should fail over instead.
    retry: {
      maxRetries: 1,
      baseDelayMs: 250,
      retryableCodes: [502, 503, 504, 520, 529],
    },
  });

  console.log(`OAUTHROUTER_PROXY_READY ${proxy.baseUrl}`);
  console.log(
    `OAUTHROUTER_DEBUG_DASHBOARD ${proxy.baseUrl}/debug/dashboard?token=$OAUTHROUTER_LOCAL_TOKEN`,
  );
  if (!hasDeepSeek) {
    console.log("OAUTHROUTER_NOTE DeepSeek disabled (missing DEEPSEEK_API_KEY)");
  }

  const shutdown = async () => {
    try {
      await proxy.close();
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
