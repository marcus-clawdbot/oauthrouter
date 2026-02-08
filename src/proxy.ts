/**
 * Local proxy server (OAuthRouter)
 *
 * ROUTER-003:
 *  - Enforce an auth token on ALL local proxy requests
 *  - Add spend controls skeleton (token/quota based)
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

import { constantTimeTokenEquals } from "./proxy-token.js";
import {
  DailyBudgetTracker,
  SpendLimitError,
  type SpendControlsConfig,
  normalizeModelId,
} from "./spend-controls.js";
import {
  buildAnthropicMessagesRequestFromOpenAI,
  anthropicMessagesResponseToOpenAIChatCompletion,
  type OpenAIChatCompletionsRequest,
  type AnthropicMessagesResponse,
} from "./adapters/anthropic.js";
import { normalizeOpenAiChatCompletionsRequest } from "./adapters/openai.js";
import {
  buildCodexResponsesRequestFromOpenAIChatCompletions,
  extractChatGptAccountIdFromJwt,
} from "./adapters/openai-codex.js";
import { resolveProviderForModelId, isAutoModelId, type ProviderId } from "./model-registry.js";
import { route, DEFAULT_ROUTING_CONFIG } from "./router/index.js";
import type { RoutingConfig } from "./router/types.js";
import type { ModelPricing } from "./router/selector.js";
import { BLOCKRUN_MODELS } from "./models.js";
import { VERSION } from "./version.js";
import { getOpenAICodexAuthHeader } from "./openclaw-auth-profiles.js";

const DEFAULT_PORT = 8402;
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;

const DEFAULT_AUTO_ROUTING_CONFIG: RoutingConfig = {
  ...DEFAULT_ROUTING_CONFIG,
  version: "oauthrouter-auto-1",
  tiers: {
    SIMPLE: {
      primary: "openai/gpt-4o-mini",
      fallback: ["anthropic/claude-haiku-4-5"],
    },
    MEDIUM: {
      primary: "openai/gpt-4o",
      fallback: ["anthropic/claude-sonnet-4"],
    },
    COMPLEX: {
      primary: "anthropic/claude-opus-4",
      fallback: ["openai/gpt-4o"],
    },
    REASONING: {
      primary: "openai/o3",
      fallback: ["anthropic/claude-sonnet-4"],
    },
  },
};

function buildModelPricingForAuto(): Map<string, ModelPricing> {
  const map = new Map<string, ModelPricing>();
  for (const m of BLOCKRUN_MODELS) {
    const id = m.id;
    if (!id.startsWith("openai/") && !id.startsWith("anthropic/")) continue;
    map.set(id, { inputPrice: m.inputPrice, outputPrice: m.outputPrice });
  }
  return map;
}

type SseDataFrame = { data: string };

async function* readSseDataFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<SseDataFrame> {
  const decoder = new TextDecoder();
  let buf = "";

  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      while (true) {
        const sep = buf.indexOf("\n\n");
        if (sep === -1) break;
        const frameRaw = buf.slice(0, sep);
        buf = buf.slice(sep + 2);

        for (const line of frameRaw.split(/\n/)) {
          const m = line.match(/^data:\s?(.*)$/);
          if (!m) continue;
          const data = (m[1] ?? "").trimEnd();
          if (!data) continue;
          yield { data };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const tail = buf.trim();
  if (tail) {
    for (const line of tail.split(/\n/)) {
      const m = line.match(/^data:\s?(.*)$/);
      if (!m) continue;
      const data = (m[1] ?? "").trimEnd();
      if (!data) continue;
      yield { data };
    }
  }
}

function tryParseJson<T>(s: string): T | undefined {
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
}

function extractOutputTextFromCodexResponsesPayload(payload: any): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;

  const rsp = (payload as any).response;
  if (rsp && typeof rsp === "object") {
    if (typeof (rsp as any).output_text === "string") return (rsp as any).output_text;

    const out = (rsp as any).output;
    if (Array.isArray(out)) {
      const texts: string[] = [];
      for (const item of out) {
        const content = item?.content;
        if (!Array.isArray(content)) continue;
        for (const part of content) {
          if (part?.type === "output_text" && typeof part?.text === "string") {
            texts.push(part.text);
          }
        }
      }
      if (texts.length) return texts.join("");
    }
  }

  if (typeof (payload as any).output_text === "string") return (payload as any).output_text;
  return undefined;
}

export type UpstreamProviderConfig = {
  /** Provider base URL, e.g. "https://api.openai.com" or "https://api.anthropic.com". */
  apiBase: string;
  /** Optional provider-specific headers added to upstream requests. */
  headers?: Record<string, string>;
  /** Optional provider-specific auth header. */
  authHeader?: { name: string; value: string } | string;
};

export type ProxyOptions = {
  /** Optional override for OpenClaw per-agent auth-profiles.json path (used by openai-codex OAuth refresh). */
  authStorePath?: string;

  /**
   * Legacy single-upstream mode.
   *
   * If `providers` is set, this is ignored.
   */
  apiBase?: string;

  /** Multi-upstream mode (ROUTER-007). */
  providers?: Partial<Record<ProviderId, UpstreamProviderConfig>>;

  /** Port to listen on (default: 8402). */
  port?: number;
  /** Request timeout (ms). */
  requestTimeoutMs?: number;

  /** Auth token required on ALL local proxy requests. If omitted, one is generated. */
  authToken?: string;

  /** Optional spend controls (guardrails). */
  spendControls?: SpendControlsConfig;

  /** Optional static headers added to upstream requests (applies to all providers). */
  upstreamHeaders?: Record<string, string>;

  /**
   * Legacy upstream auth header to apply when forwarding requests (applies to all providers).
   *
   * Prefer `providers[provider].authHeader`.
   */
  upstreamAuthHeader?: { name: string; value: string } | string;

  /** Optional routing config when using oauthrouter/auto. */
  routingConfig?: RoutingConfig;

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

  // OpenAI-compatible fallbacks
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

function isAnthropicApiBase(apiBase: string): boolean {
  try {
    const host = new URL(apiBase).hostname.toLowerCase();
    return (
      host === "api.anthropic.com" || host.endsWith(".anthropic.com") || host.includes("anthropic")
    );
  } catch {
    return apiBase.toLowerCase().includes("anthropic");
  }
}

function applyUpstreamAuthHeader(
  headers: Record<string, string>,
  auth: ProxyOptions["upstreamAuthHeader"],
): void {
  if (!auth) return;

  if (typeof auth === "string") {
    headers["authorization"] = auth;
    return;
  }

  const name = auth.name?.trim();
  if (!name) return;
  headers[name.toLowerCase()] = auth.value;
}

function applyUpstreamHeaderOverrides(
  headers: Record<string, string>,
  options: ProxyOptions,
): void {
  if (options.upstreamHeaders) {
    for (const [k, v] of Object.entries(options.upstreamHeaders)) {
      if (typeof v === "string") headers[k.toLowerCase()] = v;
    }
  }
  applyUpstreamAuthHeader(headers, options.upstreamAuthHeader);
}

function applyProviderHeaderOverrides(
  headers: Record<string, string>,
  providerConfig: UpstreamProviderConfig | undefined,
): void {
  if (!providerConfig) return;

  if (providerConfig.headers) {
    for (const [k, v] of Object.entries(providerConfig.headers)) {
      if (typeof v === "string") headers[k.toLowerCase()] = v;
    }
  }

  applyUpstreamAuthHeader(headers, providerConfig.authHeader);
}

function parseBearerToken(value: string | undefined): string | null {
  if (!value) return null;
  const m = value.match(/^\s*Bearer\s+(.+?)\s*$/i);
  if (m) return m[1].trim();
  const t = value.trim();
  return t ? t : null;
}

function ensureCommaSeparatedIncludes(current: string | undefined, required: string[]): string {
  const have = new Set(
    (current ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const r of required) have.add(r);
  return Array.from(have).join(",");
}

/**
 * ROUTER-012: Anthropic OAuth header mode.
 *
 * If the upstream auth token looks like an Anthropic OAuth token (sk-ant-oat...),
 * send it via Authorization: Bearer and add Claude Code-like headers.
 * Otherwise, prefer x-api-key.
 */
function normalizeAnthropicUpstreamAuthHeaders(headers: Record<string, string>): void {
  const xApiKey = headers["x-api-key"]?.trim();
  const authToken = parseBearerToken(headers["authorization"]);

  const token = xApiKey || authToken;
  const isOauthToken = typeof token === "string" && token.startsWith("sk-ant-oat");

  if (isOauthToken) {
    // OAuth mode uses Authorization, not x-api-key.
    headers["authorization"] = `Bearer ${token}`;
    delete headers["x-api-key"];

    // Claude Code / pi-ai compatibility headers.
    headers["anthropic-beta"] = ensureCommaSeparatedIncludes(headers["anthropic-beta"], [
      "claude-code-20250219",
      "oauth-2025-04-20",
    ]);

    if (!headers["x-app"]) headers["x-app"] = "cli";

    // Many HTTP clients set a default user-agent (e.g. undici). For OAuth-mode
    // compatibility we explicitly stamp a Claude CLI-like UA unless one is already.
    if (
      !String(headers["user-agent"] ?? "")
        .toLowerCase()
        .startsWith("claude-cli/")
    ) {
      headers["user-agent"] = "claude-cli/1.0";
    }

    if (!headers["anthropic-dangerous-direct-browser-access"]) {
      headers["anthropic-dangerous-direct-browser-access"] = "true";
    }

    return;
  }

  // Non-OAuth: Anthropic expects x-api-key.
  if (!xApiKey && authToken) {
    headers["x-api-key"] = authToken;
    delete headers["authorization"];
  }
}

type ParsedBody = {
  model?: string;
  max_tokens?: number;
  messages?: Array<{ role?: string; content?: unknown }>;
};

function estimateInputTokensFromBody(body: Buffer, parsed?: ParsedBody): number {
  // Best-effort: concatenate message contents if present; otherwise use raw bytes.
  try {
    const msgs = parsed?.messages;
    if (Array.isArray(msgs) && msgs.length > 0) {
      const text = msgs.map((m) => (typeof m?.content === "string" ? m.content : "")).join(" ");
      return Math.ceil(text.length / 4);
    }
  } catch {
    // ignore
  }
  return Math.ceil(body.length / 4);
}

/**
 * Start the local proxy.
 */
export async function startProxy(options: ProxyOptions): Promise<ProxyHandle> {
  const apiBase = options.providers ? null : (options.apiBase ?? null);
  if (!options.providers && !apiBase) {
    throw new Error("oauthrouter: startProxy() requires apiBase (or options.providers)");
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
      await proxyRequest(req, res, options, budgetTracker);
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
  options: ProxyOptions,
  budgetTracker: DailyBudgetTracker,
): Promise<void> {
  const originalPath = req.url ?? "";

  // Collect body
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks);

  // Parse model/max_tokens when possible
  let parsed: ParsedBody | undefined;
  let modelId: string | undefined;
  let maxTokens = 4096;
  if (body.length > 0) {
    try {
      parsed = JSON.parse(body.toString()) as ParsedBody;
      if (typeof parsed.model === "string") modelId = parsed.model;
      if (typeof parsed.max_tokens === "number") maxTokens = parsed.max_tokens;
    } catch {
      // ignore
    }
  }

  const isChatCompletions =
    originalPath === "/v1/chat/completions" || originalPath.startsWith("/v1/chat/completions?");

  // --- oauthrouter/auto ---
  if (isChatCompletions && modelId && isAutoModelId(modelId)) {
    const messages = Array.isArray(parsed?.messages) ? parsed?.messages : [];
    const systemPrompt = messages
      .filter((m) => m?.role === "system")
      .map((m) => (typeof m?.content === "string" ? m.content : ""))
      .join("\n\n");

    const prompt = messages
      .filter((m) => m?.role === "user")
      .map((m) => (typeof m?.content === "string" ? m.content : ""))
      .join("\n\n");

    const modelPricing = buildModelPricingForAuto();
    const decision = route(prompt, systemPrompt || undefined, maxTokens, {
      config: options.routingConfig ?? DEFAULT_AUTO_ROUTING_CONFIG,
      modelPricing,
    });

    modelId = decision.model;
    if (parsed) {
      parsed.model = decision.model;
    }
  }

  // Determine upstream provider/base
  const providerFromModel = modelId ? resolveProviderForModelId(modelId) : null;
  const provider: ProviderId | null = options.providers
    ? providerFromModel
    : options.apiBase
      ? isAnthropicApiBase(options.apiBase)
        ? "anthropic"
        : "openai"
      : providerFromModel;

  const upstreamConfig = provider && options.providers ? options.providers[provider] : undefined;
  const upstreamApiBase = upstreamConfig?.apiBase ?? options.apiBase;
  if (!upstreamApiBase) {
    throw new Error("No upstream apiBase configured");
  }

  // Upstream defaults (passthrough)
  let upstreamPath = originalPath;
  let upstreamBody = body;
  let responseMapper:
    | ((
        upstream: Response,
      ) => Promise<{ status: number; headers: Record<string, string>; body: Buffer }>)
    | undefined;
  let responseStreamMapper:
    | ((upstream: Response, res: ServerResponse) => Promise<void>)
    | undefined;

  // Provider adapters
  if (provider === "anthropic" && isChatCompletions) {
    if (body.length === 0) throw new Error("Empty request body");

    const openAiReq = JSON.parse(body.toString()) as OpenAIChatCompletionsRequest;
    // If auto rewrote the model in `parsed`, keep the raw request consistent.
    if (typeof modelId === "string" && modelId.trim()) openAiReq.model = modelId;

    const anthropicReq = buildAnthropicMessagesRequestFromOpenAI(openAiReq);
    upstreamPath = "/v1/messages";
    upstreamBody = Buffer.from(JSON.stringify(anthropicReq));

    responseMapper = async (upstream) => {
      const raw = await upstream.text();
      const upstreamCt = upstream.headers.get("content-type") ?? "application/json";

      if (!upstream.ok) {
        return {
          status: upstream.status,
          headers: { "content-type": upstreamCt },
          body: Buffer.from(raw),
        };
      }

      let parsedRsp: AnthropicMessagesResponse;
      try {
        parsedRsp = JSON.parse(raw) as AnthropicMessagesResponse;
      } catch {
        return {
          status: 502,
          headers: { "content-type": "application/json" },
          body: Buffer.from(
            JSON.stringify({
              error: { message: "Anthropic upstream returned non-JSON", type: "upstream_error" },
            }),
          ),
        };
      }

      const mapped = anthropicMessagesResponseToOpenAIChatCompletion(parsedRsp, {
        requestedModel: typeof openAiReq.model === "string" ? openAiReq.model : undefined,
      });

      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify(mapped)),
      };
    };
  }

  if (provider === "openai" && isChatCompletions && body.length > 0) {
    const openAiReq = JSON.parse(body.toString()) as OpenAIChatCompletionsRequest;
    if (typeof modelId === "string" && modelId.trim()) openAiReq.model = modelId;
    const normalized = normalizeOpenAiChatCompletionsRequest(openAiReq);
    upstreamBody = Buffer.from(JSON.stringify(normalized));
  }

  // openai-codex (chatgpt.com) adapter: OpenAI chat.completions -> Codex responses
  if (provider === "openai-codex" && isChatCompletions) {
    if (body.length === 0) throw new Error("Empty request body");

    const openAiReq = JSON.parse(body.toString()) as OpenAIChatCompletionsRequest;
    if (typeof modelId === "string" && modelId.trim()) openAiReq.model = modelId;

    const clientStream = Boolean((openAiReq as any).stream);
    const requestedModel = typeof openAiReq.model === "string" ? openAiReq.model : undefined;

    const codexReq = buildCodexResponsesRequestFromOpenAIChatCompletions(openAiReq);
    upstreamPath = "/backend-api/codex/responses";
    upstreamBody = Buffer.from(JSON.stringify(codexReq));

    if (clientStream) {
      responseStreamMapper = async (upstream, nodeRes) => {
        const upstreamCt = upstream.headers.get("content-type") ?? "";

        if (!upstream.ok) {
          const raw = await upstream.text();
          nodeRes.writeHead(upstream.status, {
            "content-type": upstreamCt || "application/json",
          });
          nodeRes.end(raw);
          return;
        }

        nodeRes.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
        });

        if (!upstream.body) {
          nodeRes.write("data: [DONE]\n\n");
          nodeRes.end();
          return;
        }

        const created = Math.floor(Date.now() / 1000);
        const idFallback = `chatcmpl_${randomBytes(12).toString("hex")}`;
        let id = idFallback;

        for await (const frame of readSseDataFrames(upstream.body)) {
          if (frame.data === "[DONE]") break;

          const payload = tryParseJson<any>(frame.data);
          if (!payload) continue;

          const rsp = payload.response;
          if (rsp && typeof rsp === "object" && typeof rsp.id === "string" && rsp.id.trim()) {
            id = rsp.id.trim();
          }

          const type = typeof payload.type === "string" ? payload.type : "";
          if (type === "response.output_text.delta" && typeof payload.delta === "string") {
            const chunk = {
              id,
              object: "chat.completion.chunk",
              created,
              model: requestedModel,
              choices: [{ index: 0, delta: { content: payload.delta } }],
            };
            nodeRes.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }

          // Ignore tool/reasoning/metadata events.
        }

        nodeRes.write("data: [DONE]\n\n");
        nodeRes.end();
      };
    } else {
      responseMapper = async (upstream) => {
        const upstreamCt = upstream.headers.get("content-type") ?? "application/json";
        const raw = await upstream.text();

        if (!upstream.ok) {
          return {
            status: upstream.status,
            headers: { "content-type": upstreamCt },
            body: Buffer.from(raw),
          };
        }

        let content = "";
        let upstreamId: string | undefined;

        if (upstreamCt.includes("text/event-stream")) {
          let completedText: string | undefined;

          const re = /^data:\s?(.*)$/gm;
          let match: RegExpExecArray | null;
          while ((match = re.exec(raw))) {
            const data = (match[1] ?? "").trim();
            if (!data || data === "[DONE]") continue;

            const payload = tryParseJson<any>(data);
            if (!payload) continue;

            const rsp = payload.response;
            if (rsp && typeof rsp === "object" && typeof rsp.id === "string") upstreamId = rsp.id;

            const type = typeof payload.type === "string" ? payload.type : "";
            if (type === "response.output_text.delta" && typeof payload.delta === "string") {
              content += payload.delta;
            }

            const extracted = extractOutputTextFromCodexResponsesPayload(payload);
            if (typeof extracted === "string") completedText = extracted;
          }

          if (typeof completedText === "string") content = completedText;
        } else {
          const json = tryParseJson<any>(raw);
          if (!json) {
            return {
              status: 502,
              headers: { "content-type": "application/json" },
              body: Buffer.from(
                JSON.stringify({
                  error: {
                    message: "openai-codex upstream returned non-JSON",
                    type: "upstream_error",
                  },
                }),
              ),
            };
          }

          upstreamId = typeof json.id === "string" ? json.id : upstreamId;
          content =
            (typeof json.output_text === "string" && json.output_text) ||
            extractOutputTextFromCodexResponsesPayload({ response: json }) ||
            "";
        }

        const created = Math.floor(Date.now() / 1000);
        const id = upstreamId || `chatcmpl_${randomBytes(12).toString("hex")}`;

        const mapped = {
          id,
          object: "chat.completion",
          created,
          model: requestedModel,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content },
              finish_reason: "stop",
            },
          ],
        };

        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify(mapped)),
        };
      };
    }
  }

  const upstreamUrl = `${upstreamApiBase}${upstreamPath}`;

  const spend = options.spendControls;

  // --- Model allow/deny lists ---
  if (spend && modelId) {
    const norm = normalizeModelId(modelId);

    if (Array.isArray(spend.denylistModels) && spend.denylistModels.length > 0) {
      const deny = new Set(spend.denylistModels.map(normalizeModelId));
      if (deny.has(norm)) {
        throw new SpendLimitError(
          "MODEL_NOT_ALLOWED",
          `Model blocked by denylist: ${modelId}`,
          403,
        );
      }
    }

    if (Array.isArray(spend.allowlistModels) && spend.allowlistModels.length > 0) {
      const allow = new Set(spend.allowlistModels.map(normalizeModelId));
      if (!allow.has(norm)) {
        throw new SpendLimitError("MODEL_NOT_ALLOWED", `Model not in allowlist: ${modelId}`, 403);
      }
    }
  }

  // --- Token estimates + per-request limits ---
  const estimatedInputTokens = estimateInputTokensFromBody(body, parsed);
  const estimatedOutputTokens = maxTokens;

  if (
    spend?.maxRequestInputTokens !== undefined &&
    estimatedInputTokens > spend.maxRequestInputTokens
  ) {
    throw new SpendLimitError(
      "REQUEST_TOKENS_TOO_HIGH",
      `Estimated input tokens ${estimatedInputTokens} exceeds max ${spend.maxRequestInputTokens}`,
      403,
    );
  }

  if (
    spend?.maxRequestOutputTokens !== undefined &&
    estimatedOutputTokens > spend.maxRequestOutputTokens
  ) {
    throw new SpendLimitError(
      "REQUEST_TOKENS_TOO_HIGH",
      `Requested max_tokens ${estimatedOutputTokens} exceeds max ${spend.maxRequestOutputTokens}`,
      403,
    );
  }

  // --- Daily budgets (reserve/commit) ---
  let reserved = false;
  if (
    spend?.dailyInputTokenBudget !== undefined ||
    spend?.dailyOutputTokenBudget !== undefined ||
    spend?.dailyRequestBudget !== undefined
  ) {
    await budgetTracker.reserve({
      inputTokens: estimatedInputTokens,
      outputTokens: estimatedOutputTokens,
      inputLimit: spend.dailyInputTokenBudget,
      outputLimit: spend.dailyOutputTokenBudget,
      requestLimit: spend.dailyRequestBudget,
    });
    reserved = true;
  }

  // Forward headers, stripping hop-by-hop + local auth
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const k = key.toLowerCase();
    if (
      k === "host" ||
      k === "connection" ||
      k === "transfer-encoding" ||
      k === "content-length" ||
      k === "authorization" ||
      k === "proxy-authorization" ||
      k === "x-api-key" ||
      k === "x-openai-api-key"
    ) {
      continue;
    }
    if (typeof value === "string") headers[k] = value;
  }

  applyUpstreamHeaderOverrides(headers, options);
  applyProviderHeaderOverrides(headers, upstreamConfig);

  if (!headers["content-type"]) headers["content-type"] = "application/json";

  if (provider === "openai-codex") {
    // Required Codex/ChatGPT backend headers (pi-ai compatible)
    if (!headers["openai-beta"]) headers["openai-beta"] = "responses=experimental";
    if (!headers["originator"]) headers["originator"] = "pi";
    // Force SSE accept for Codex backend.
    headers["accept"] = "text/event-stream";
    headers["user-agent"] = `pi(oauthrouter/${VERSION})`;

    if (!headers["authorization"]) {
      const auth = await getOpenAICodexAuthHeader({ authStorePath: options.authStorePath });
      headers["authorization"] = auth.Authorization;
    }

    // Derive chatgpt-account-id from the JWT access token.
    const bearer = headers["authorization"];
    const m = typeof bearer === "string" ? bearer.match(/^\s*Bearer\s+(.+)\s*$/i) : null;
    const jwt = m ? m[1] : typeof bearer === "string" ? bearer.trim() : "";
    const accountId = jwt ? extractChatGptAccountIdFromJwt(jwt) : undefined;
    if (accountId && !headers["chatgpt-account-id"]) headers["chatgpt-account-id"] = accountId;
  }

  const anthropicMode = provider === "anthropic";

  if (anthropicMode && !headers["anthropic-version"]) {
    headers["anthropic-version"] = "2023-06-01";
  }

  if (anthropicMode) {
    normalizeAnthropicUpstreamAuthHeaders(headers);

    if (!headers["x-api-key"] && !headers["authorization"]) {
      throw new Error(
        "Anthropic adapter requires auth via x-api-key (api key) or Authorization (OAuth: sk-ant-oat...) (set options.providers.anthropic.authHeader or options.upstreamAuthHeader)",
      );
    }
  }

  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const upstream = await fetch(upstreamUrl, {
      method: req.method ?? "POST",
      headers,
      body: upstreamBody.length > 0 ? upstreamBody : undefined,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (responseStreamMapper) {
      await responseStreamMapper(upstream, res);
    } else if (responseMapper) {
      const mapped = await responseMapper(upstream);
      res.writeHead(mapped.status, mapped.headers);
      res.end(mapped.body);
    } else {
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
    }

    if (reserved) {
      await budgetTracker.commit(estimatedInputTokens, estimatedOutputTokens);
    }
  } catch (err) {
    clearTimeout(timeoutId);

    if (reserved) {
      await budgetTracker.rollback(estimatedInputTokens, estimatedOutputTokens);
    }

    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }

    throw err;
  }
}
