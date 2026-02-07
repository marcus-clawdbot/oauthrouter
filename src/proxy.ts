/**
 * Local proxy server
 *
 * oauthrouter is being re-scaffolded from ClawRouter. The original x402 / wallet
 * payment flow is disabled, but oauthrouter still needs a secure local proxy
 * surface for future OAuth-based upstream routing.
 *
 * ROUTER-003:
 *  - Enforce an auth token on ALL local proxy requests
 *  - Add spend controls skeleton (per-request max, daily budget, model allowlists)
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

import { BLOCKRUN_MODELS } from "./models.js";
import { constantTimeTokenEquals } from "./proxy-token.js";
import {
  DailyBudgetTracker,
  SpendLimitError,
  type SpendControlsConfig,
  usdToMicros,
  normalizeModelId,
  microsToUsdString,
} from "./spend-controls.js";

const DEFAULT_PORT = 8402;
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;

export type ProxyOptions = {
  /** Upstream base URL (e.g. "https://example.com/api"). */
  apiBase: string;
  /** Port to listen on (default: 8402). */
  port?: number;
  /** Request timeout (ms). */
  requestTimeoutMs?: number;

  /**
   * Auth token required on ALL local proxy requests.
   * If omitted, one is generated for this process.
   */
  authToken?: string;

  /** Optional spend controls (guardrails). */
  spendControls?: SpendControlsConfig;

  onReady?: (port: number) => void;
  onError?: (error: Error) => void;
};

export type ProxyHandle = {
  port: number;
  baseUrl: string;
  authToken: string;
  close: () => Promise<void>;
};

function getHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

function extractClientToken(req: IncomingMessage): string | undefined {
  const auth = getHeaderValue(req.headers["authorization"]);
  if (auth) {
    const m = auth.match(/^\s*Bearer\s+(.+)\s*$/i);
    if (m) return m[1];
    return auth.trim();
  }

  // Common OpenAI-compatible fallbacks
  const xApiKey = getHeaderValue(req.headers["x-api-key"]);
  if (xApiKey) return xApiKey.trim();

  const xOpenAiKey = getHeaderValue(req.headers["x-openai-api-key"]);
  if (xOpenAiKey) return xOpenAiKey.trim();

  return undefined;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

type ParsedBody = {
  model?: string;
  max_tokens?: number;
};

function estimateAmountMicros(
  modelId: string,
  bodyLength: number,
  maxTokens: number,
): bigint | undefined {
  const model = BLOCKRUN_MODELS.find((m) => m.id === modelId);
  if (!model) return undefined;

  const estimatedInputTokens = Math.ceil(bodyLength / 4);
  const estimatedOutputTokens = maxTokens || model.maxOutput || 4096;

  const costUsd =
    (estimatedInputTokens / 1_000_000) * model.inputPrice +
    (estimatedOutputTokens / 1_000_000) * model.outputPrice;

  const amountMicros = Math.max(100, Math.ceil(costUsd * 1.2 * 1_000_000));
  return BigInt(amountMicros);
}

/**
 * Start the local proxy.
 */
export async function startProxy(options: ProxyOptions): Promise<ProxyHandle> {
  const apiBase = options.apiBase;
  if (!apiBase) {
    throw new Error("oauthrouter: startProxy() requires apiBase");
  }

  const authToken = options.authToken ?? randomBytes(32).toString("base64url");
  const budgetTracker = new DailyBudgetTracker();

  const server = createServer(async (req, res) => {
    // --- Auth: required on ALL requests ---
    const token = extractClientToken(req);
    if (!token || !constantTimeTokenEquals(token, authToken)) {
      sendJson(res, 401, { error: { message: "Unauthorized", type: "proxy_auth_error" } });
      return;
    }

    if (req.url === "/health" || req.url?.startsWith("/health?")) {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    if (!req.url?.startsWith("/v1")) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    try {
      await proxyRequest(req, res, apiBase, options, budgetTracker);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      options.onError?.(error);

      if (error instanceof SpendLimitError) {
        sendJson(res, error.status, {
          error: { message: error.message, type: "spend_limit", code: error.code },
        });
        return;
      }

      sendJson(res, 502, { error: { message: error.message, type: "proxy_error" } });
    }
  });

  const listenPort = options.port ?? DEFAULT_PORT;

  return new Promise<ProxyHandle>((resolve, reject) => {
    server.on("error", reject);

    server.listen(listenPort, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      const port = addr.port;
      options.onReady?.(port);
      resolve({
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        authToken,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((e) => (e ? rej(e) : res()));
          }),
      });
    });
  });
}

async function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  apiBase: string,
  options: ProxyOptions,
  budgetTracker: DailyBudgetTracker,
): Promise<void> {
  const upstreamUrl = `${apiBase}${req.url}`;

  // Collect body
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks);

  // Parse model/max_tokens when possible
  let modelId: string | undefined;
  let maxTokens = 4096;
  if (body.length > 0) {
    try {
      const parsed = JSON.parse(body.toString()) as ParsedBody;
      if (typeof parsed.model === "string") modelId = parsed.model;
      if (typeof parsed.max_tokens === "number") maxTokens = parsed.max_tokens;
    } catch {
      // ignore
    }
  }

  const spend = options.spendControls;

  // --- Model allow/deny lists ---
  if (spend && modelId) {
    const norm = normalizeModelId(modelId);

    if (Array.isArray(spend.denylistModels) && spend.denylistModels.length > 0) {
      const deny = new Set(spend.denylistModels.map(normalizeModelId));
      if (deny.has(norm)) {
        throw new SpendLimitError("MODEL_NOT_ALLOWED", `Model blocked by denylist: ${modelId}`, 403);
      }
    }

    if (Array.isArray(spend.allowlistModels) && spend.allowlistModels.length > 0) {
      const allow = new Set(spend.allowlistModels.map(normalizeModelId));
      if (!allow.has(norm)) {
        throw new SpendLimitError("MODEL_NOT_ALLOWED", `Model not in allowlist: ${modelId}`, 403);
      }
    }
  }

  // --- Estimate cost (if we have a model) ---
  let estimatedCostMicros: bigint | undefined;
  if (modelId) {
    estimatedCostMicros = estimateAmountMicros(normalizeModelId(modelId), body.length, maxTokens);
  }

  // --- Per-request cap ---
  if (spend?.maxRequestUsd !== undefined) {
    const maxMicros = usdToMicros(spend.maxRequestUsd);
    if (estimatedCostMicros === undefined) {
      if (!spend.allowUnknownCost) {
        throw new SpendLimitError(
          "COST_ESTIMATE_UNAVAILABLE",
          "Cost estimate unavailable; set allowUnknownCost=true to override.",
          403,
        );
      }
    } else if (estimatedCostMicros > maxMicros) {
      throw new SpendLimitError(
        "REQUEST_COST_TOO_HIGH",
        `Estimated request cost $${microsToUsdString(estimatedCostMicros)} exceeds max $${spend.maxRequestUsd.toFixed(6)}`,
        403,
      );
    }
  }

  // --- Daily budget (reserve/commit) ---
  let reservedBudgetMicros: bigint | undefined;
  if (spend?.dailyBudgetUsd !== undefined) {
    const limitMicros = usdToMicros(spend.dailyBudgetUsd);
    if (estimatedCostMicros === undefined) {
      if (!spend.allowUnknownCost) {
        throw new SpendLimitError(
          "COST_ESTIMATE_UNAVAILABLE",
          "Cost estimate unavailable; set allowUnknownCost=true to override.",
          403,
        );
      }
    } else {
      await budgetTracker.reserve(estimatedCostMicros, limitMicros);
      reservedBudgetMicros = estimatedCostMicros;
    }
  }

  // Forward headers, stripping hop-by-hop + local auth
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (
      key === "host" ||
      key === "connection" ||
      key === "transfer-encoding" ||
      key === "content-length" ||
      key === "authorization" ||
      key === "proxy-authorization" ||
      key === "x-api-key" ||
      key === "x-openai-api-key"
    ) {
      continue;
    }
    if (typeof value === "string") headers[key] = value;
  }

  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const upstream = await fetch(upstreamUrl, {
      method: req.method ?? "POST",
      headers,
      body: body.length > 0 ? body : undefined,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const responseHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, key) => {
      if (key === "transfer-encoding" || key === "connection") return;
      responseHeaders[key] = value;
    });

    res.writeHead(upstream.status, responseHeaders);

    if (upstream.body) {
      const reader = upstream.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } finally {
        reader.releaseLock();
      }
    }

    res.end();

    if (reservedBudgetMicros !== undefined) {
      await budgetTracker.commit(reservedBudgetMicros);
    }
  } catch (err) {
    clearTimeout(timeoutId);

    if (reservedBudgetMicros !== undefined) {
      await budgetTracker.rollback(reservedBudgetMicros);
    }

    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }

    throw err;
  }
}
