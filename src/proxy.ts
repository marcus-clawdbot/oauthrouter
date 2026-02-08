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
import { routingTrace, type TraceEvent } from "./routing-trace.js";
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
  toOpenAICodexModelId,
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

// Single-file debug dashboard (auth-gated by the proxy token).
const ROUTING_TRACE_DASHBOARD_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OAuthRouter • Routing Trace</title>
    <style>
      :root { --bg:#0b0d10; --panel:#11151a; --text:#e7eef6; --muted:#9fb2c7; --border:#263140; --good:#1f8a4c; --warn:#c7902d; --bad:#d34b4b; --rowHover:#16202c; --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; --sans: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; }
      html,body{height:100%} body{margin:0;font-family:var(--sans);background:var(--bg);color:var(--text)}
      header{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--border);background:linear-gradient(180deg,#0f1318 0%,#0b0d10 100%);position:sticky;top:0;z-index:1}
      header h1{font-size:14px;margin:0;letter-spacing:.2px;font-weight:650} header .meta{font-family:var(--mono);font-size:12px;color:var(--muted)}
      .controls{display:flex;flex-wrap:wrap;gap:10px;align-items:center} .controls label{font-size:12px;color:var(--muted)}
      .controls input{background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:7px 10px;font-family:var(--mono);font-size:12px;outline:none;min-width:280px}
      .controls button{background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:7px 10px;font-family:var(--mono);font-size:12px;cursor:pointer} .controls button:hover{border-color:#3b4a5d}
      main{padding:10px 12px 30px} table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:12px}
      thead th{text-align:left;color:var(--muted);font-weight:600;padding:10px 8px;border-bottom:1px solid var(--border);font-family:var(--mono)}
      tbody td{padding:9px 8px;border-bottom:1px solid rgba(38,49,64,.65);vertical-align:top;font-family:var(--mono);word-wrap:break-word} tbody tr:hover{background:var(--rowHover)}
      .col-ts{width:165px}.col-provider{width:130px}.col-model{width:280px}.col-upstream{width:auto}.col-status{width:90px}.col-lat{width:100px;text-align:right}
      .pill{display:inline-block;padding:2px 8px;border-radius:999px;border:1px solid var(--border)}
      .good{color:#d4ffe6;background:rgba(31,138,76,.25);border-color:rgba(31,138,76,.55)}
      .warn{color:#fff3d6;background:rgba(199,144,45,.22);border-color:rgba(199,144,45,.55)}
      .bad{color:#ffd7d7;background:rgba(211,75,75,.18);border-color:rgba(211,75,75,.55)}
      .muted{color:var(--muted)}.right{text-align:right}.mono{font-family:var(--mono)}.small{font-size:11px}
    </style>
  </head>
  <body>
    <header>
      <div>
        <h1>OAuthRouter • Routing Trace</h1>
        <div class="meta">Live SSE: <span id="conn">connecting…</span> • Events: <span id="count">0</span></div>
      </div>
      <div class="controls">
        <label>Filter (session/provider/model/upstream)
          <input id="filter" type="text" placeholder="e.g. sessionKey / claude / gpt-5.2 / chatgpt.com" />
        </label>
        <button id="pause">pause</button>
        <button id="clear">clear</button>
      </div>
    </header>
    <main>
      <table>
        <thead>
          <tr>
            <th class="col-ts">time</th>
            <th class="col-session">session</th>
            <th class="col-provider">provider</th>
            <th class="col-model">model</th>
            <th class="col-upstream">upstream</th>
            <th class="col-status">status</th>
            <th class="col-lat right">latency</th>
          </tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
    </main>
    <script>
      const rowsEl=document.getElementById('rows');
      const filterEl=document.getElementById('filter');
      const connEl=document.getElementById('conn');
      const countEl=document.getElementById('count');
      const pauseBtn=document.getElementById('pause');
      const clearBtn=document.getElementById('clear');
      const MAX_RENDER=200, MAX_STORE=500;
      const events=[]; let paused=false;
      function clsForStatus(s){ if(s==null) return 'warn'; if(s>=200&&s<300) return 'good'; if(s>=400&&s<500) return 'warn'; return 'bad'; }
      function clsForLatency(ms){ if(ms<500) return 'good'; if(ms<1500) return 'warn'; return 'bad'; }
      function fmtTs(ts){ if(!Number.isFinite(ts)) return ''; const d=new Date(ts); const pad=(n,w=2)=>String(n).padStart(w,'0');
        return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+' '+pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds())+'.'+pad(d.getMilliseconds(),3);
      }
      function upstreamHostPath(u){ if(!u) return ''; try{ const x=new URL(u); return String(x.host)+String(x.pathname); }catch{ return String(u);} }
      function esc(s){ return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;'); }
      function render(){ const q=(filterEl.value||'').trim().toLowerCase(); let html=''; let shown=0; for(const e of events){ const session=e?.sessionKey?String(e.sessionKey):''; const provider=e?.providerId?String(e.providerId):''; const requested=e?.modelIdRequested?String(e.modelIdRequested):''; const resolved=e?.modelIdResolved?String(e.modelIdResolved):''; const tier=e?.routingTier||''; const conf=e?.routingConfidence; const model=resolved?(requested==='auto'?resolved+' <span class="muted small">['+tier+(conf!=null?' '+Math.round(conf*100)+'%':'')+']</span>':resolved):requested; const upstream=upstreamHostPath(e?.upstreamUrl);
        const hay=(session+' '+provider+' '+requested+' '+resolved+' '+tier+' '+upstream).toLowerCase(); if(q && !hay.includes(q)) continue; const statusText=(e?.status!=null)?String(e.status):'—'; const stCls=clsForStatus(e?.status); const latCls=clsForLatency(e?.latencyMs||0);
        html += '<tr>'
          + '<td class="col-ts muted">'+esc(fmtTs(e?.ts))+'</td>'
          + '<td class="col-session mono small">'+esc(session)+'</td>'
          + '<td class="col-provider">'+esc(provider)+'</td>'
          + '<td class="col-model">'+model+'</td>'
          + '<td class="col-upstream small">'+esc(upstream)+'</td>'
          + '<td class="col-status"><span class="pill '+stCls+'">'+esc(statusText)+'</span></td>'
          + '<td class="col-lat right"><span class="pill '+latCls+'">'+esc(String(Math.round(e?.latencyMs||0)))+'ms</span></td>'
          + '</tr>';
        shown++; if(shown>=MAX_RENDER) break; } rowsEl.innerHTML=html; countEl.textContent=String(events.length); }
      function addEvent(e){ events.unshift(e); if(events.length>MAX_STORE) events.length=MAX_STORE; if(!paused) render(); }
      pauseBtn.addEventListener('click',()=>{ paused=!paused; pauseBtn.textContent=paused?'resume':'pause'; if(!paused) render(); });
      clearBtn.addEventListener('click',()=>{ events.length=0; render(); });
      filterEl.addEventListener('input',()=>{ if(!paused) render(); });
      const es=new EventSource('/debug/routing-trace/stream');
      es.onopen=()=>{ connEl.textContent='connected'; connEl.className='mono'; };
      es.onerror=()=>{ connEl.textContent='disconnected (retrying…)'; connEl.className='mono'; };
      es.onmessage=(m)=>{ try{ const e=JSON.parse(m.data); if(e && typeof e==='object' && e.ok===true) return; addEvent(e);}catch{} };
      render();
    </script>
  </body>
</html>`;

const DEFAULT_AUTO_ROUTING_CONFIG: RoutingConfig = {
  ...DEFAULT_ROUTING_CONFIG,
  version: "oauthrouter-auto-2",
  // IMPORTANT: we currently do NOT run an OpenAI upstream provider (api.openai.com).
  // Auto-routing must only select models that we can actually serve via configured providers.
  tiers: {
    SIMPLE: {
      primary: "anthropic/claude-haiku-4-5",
      fallback: ["openai-codex/gpt-5.2", "openai-codex/gpt-5.2-codex"],
    },
    MEDIUM: {
      primary: "openai-codex/gpt-5.2-codex",
      fallback: ["anthropic/claude-sonnet-4-5", "openai-codex/gpt-5.2"],
    },
    COMPLEX: {
      primary: "anthropic/claude-sonnet-4-5",
      fallback: ["anthropic/claude-opus-4-5", "openai-codex/gpt-5.3-codex"],
    },
    REASONING: {
      primary: "anthropic/claude-opus-4-6",
      fallback: ["anthropic/claude-opus-4-5", "openai-codex/gpt-5.3-codex"],
    },
  },
};

function buildModelPricingForAuto(): Map<string, ModelPricing> {
  const map = new Map<string, ModelPricing>();
  for (const m of BLOCKRUN_MODELS) {
    const id = m.id;
    if (
      !id.startsWith("openai/") &&
      !id.startsWith("openai-codex/") &&
      !id.startsWith("anthropic/")
    ) {
      continue;
    }
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

function extractCookieToken(req: IncomingMessage, name = "oauthrouter_token"): string | undefined {
  const raw = getHeaderValue(req.headers["cookie"]);
  if (!raw) return undefined;
  for (const part of raw.split(/;\s*/g)) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k !== name) continue;
    return decodeURIComponent(part.slice(idx + 1));
  }
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
    // Must include ALL beta flags that Claude Code sends, otherwise Anthropic
    // rejects OAuth tokens with "credential is only authorized for Claude Code".
    headers["anthropic-beta"] = ensureCommaSeparatedIncludes(headers["anthropic-beta"], [
      "claude-code-20250219",
      "oauth-2025-04-20",
      "fine-grained-tool-streaming-2025-05-14",
      "interleaved-thinking-2025-05-14",
    ]);

    if (!headers["x-app"]) headers["x-app"] = "cli";

    // Must match Claude CLI user-agent exactly for OAuth token validation.
    headers["user-agent"] = "claude-cli/2.1.2 (external, cli)";

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
  user?: string; // OpenAI-compatible field; we can use it as a session correlation id.
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
    const urlPath = req.url ?? "";
    const isDebug = urlPath.startsWith("/debug/");

    let token = extractClientToken(req);

    // Browsers can't easily set custom headers for navigation/EventSource.
    // For /debug/* only, allow token via cookie or ?token= query.
    if (!token && isDebug) {
      token = extractCookieToken(req);

      if (!token) {
        try {
          const u = new URL(urlPath, "http://127.0.0.1");
          const t = u.searchParams.get("token");
          if (t && t.trim()) token = t.trim();
        } catch {
          // ignore
        }
      }
    }

    if (!token || !constantTimeTokenEquals(token, authToken)) {
      sendJson(res, 401, { error: { message: "Unauthorized", type: "proxy_auth_error" } });
      return;
    }

    if (req.url === "/health" || req.url?.startsWith("/health?")) {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    if (req.url?.startsWith("/debug/dashboard")) {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "set-cookie": `oauthrouter_token=${encodeURIComponent(token)}; Path=/; SameSite=Strict`,
      });
      res.end(ROUTING_TRACE_DASHBOARD_HTML);
      return;
    }

    // --- Debug: routing trace (explicit allowlist; still fail-closed) ---
    if (req.url === "/debug/routing-trace" || req.url?.startsWith("/debug/routing-trace?")) {
      const u = new URL(req.url, "http://127.0.0.1");
      const nRaw = u.searchParams.get("n");
      const n = nRaw ? Math.max(1, Math.min(5000, Number(nRaw))) : 200;
      sendJson(res, 200, { events: routingTrace.last(Number.isFinite(n) ? n : 200) });
      return;
    }

    if (
      req.url === "/debug/routing-trace/stream" ||
      req.url?.startsWith("/debug/routing-trace/stream?")
    ) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });

      // Send a small hello + last few events for context.
      res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
      for (const evt of routingTrace.last(25)) {
        res.write(`data: ${JSON.stringify(evt)}\n\n`);
      }

      const unsubscribe = routingTrace.subscribe((evt) => {
        try {
          res.write(`data: ${JSON.stringify(evt)}\n\n`);
        } catch {
          // ignore
        }
      });

      const keepaliveId = setInterval(() => {
        try {
          res.write(`: keepalive ${Date.now()}\n\n`);
        } catch {
          // ignore
        }
      }, 15_000);

      res.on("close", () => {
        clearInterval(keepaliveId);
        unsubscribe();
      });

      return;
    }

    if (!req.url?.startsWith("/v1")) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    const requestId = randomBytes(12).toString("hex");
    const startedAt = Date.now();
    const trace: TraceEvent = {
      ts: startedAt,
      requestId,
      path: req.url ?? "",
      method: req.method ?? "",
      spend: { decision: "allowed" },
    };

    try {
      await proxyRequest(req, res, options, budgetTracker, trace);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      options.onError?.(error);

      trace.errorMessage = error.message;

      if (error instanceof SpendLimitError) {
        trace.spend = { decision: "blocked", code: error.code };
        trace.status = error.status;
        sendJson(res, error.status, {
          error: { message: error.message, type: "spend_limit", code: error.code },
        });
        return;
      }

      trace.status = 502;
      sendJson(res, 502, { error: { message: error.message, type: "proxy_error" } });
    } finally {
      trace.latencyMs = Date.now() - startedAt;
      routingTrace.append(trace);
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
  trace: TraceEvent,
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

  trace.modelIdRequested = modelId;
  if (typeof parsed?.user === "string" && parsed.user.trim()) {
    trace.sessionKey = parsed.user.trim();
  }

  const isChatCompletions =
    originalPath === "/v1/chat/completions" || originalPath.startsWith("/v1/chat/completions?");

  const isResponses = originalPath === "/v1/responses" || originalPath.startsWith("/v1/responses?");

  trace.stream = Boolean((parsed as any)?.stream);

  // --- oauthrouter/auto ---
  if ((isChatCompletions || isResponses) && modelId && isAutoModelId(modelId)) {
    const messages = Array.isArray(parsed?.messages) ? parsed?.messages : [];

    // Coerce content to string (handles both string and array content blocks)
    const _coerce = (c: unknown): string => {
      if (typeof c === "string") return c;
      if (Array.isArray(c)) {
        return c
          .filter(
            (p: any) =>
              p &&
              typeof p === "object" &&
              (p.type === "text" || p.type === "input_text") &&
              typeof p.text === "string",
          )
          .map((p: any) => p.text)
          .join("");
      }
      return "";
    };

    const systemPrompt = messages
      .filter((m) => m?.role === "system")
      .map((m) => _coerce(m?.content))
      .join("\n\n");

    // Only classify the LAST user message, not the entire conversation history
    const userMessages = messages.filter((m) => m?.role === "user");
    const lastUserMsg = userMessages.length > 0 ? userMessages[userMessages.length - 1] : undefined;
    const prompt = lastUserMsg ? _coerce(lastUserMsg.content) : "";

    const modelPricing = buildModelPricingForAuto();
    // Don't pass system prompt to router - it's the agent identity, not the user's request
    const decision = route(prompt, undefined, maxTokens, {
      config: options.routingConfig ?? DEFAULT_AUTO_ROUTING_CONFIG,
      modelPricing,
    });

    modelId = decision.model;
    if (parsed) {
      parsed.model = decision.model;
    }

    // Log and trace the routing decision
    trace.modelIdResolved = decision.model;
    trace.routingTier = decision.tier;
    trace.routingConfidence = decision.confidence;
    trace.routingReasoning = decision.reasoning;
    console.error(
      `[auto-route] tier=${decision.tier} model=${decision.model} confidence=${decision.confidence.toFixed(2)} reason="${decision.reasoning}"`,
    );
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

    const clientStream = Boolean((openAiReq as any).stream);
    const requestedModel = typeof openAiReq.model === "string" ? openAiReq.model : undefined;

    const anthropicReq = buildAnthropicMessagesRequestFromOpenAI(openAiReq);

    // ROUTER-016: Claude Code OAuth tokens require the system prompt to include
    // the Claude Code identity preamble, otherwise Anthropic rejects the request.
    const providerAuthHeader = upstreamConfig?.authHeader;
    const providerAuthToken =
      typeof providerAuthHeader === "string"
        ? providerAuthHeader.replace(/^Bearer\s+/i, "")
        : typeof providerAuthHeader === "object" && providerAuthHeader?.value
          ? providerAuthHeader.value.replace(/^Bearer\s+/i, "")
          : null;
    // Track original tool names for remapping responses back
    const toolNameMap = new Map<string, string>(); // claudeCodeName → originalName
    if (providerAuthToken && providerAuthToken.startsWith("sk-ant-oat")) {
      const CLAUDE_CODE_PREAMBLE = "You are Claude Code, Anthropic's official CLI for Claude.";
      const existingSystem = anthropicReq.system ?? "";
      // ROUTER-016: OAuth tokens validate the system prompt. Keep only the Claude Code
      // preamble in the system field; move the original prompt into the first user message.
      if (existingSystem && !existingSystem.startsWith(CLAUDE_CODE_PREAMBLE)) {
        anthropicReq.system = CLAUDE_CODE_PREAMBLE;
        // Prepend original system prompt as context in first user message
        const systemCtx: any = {
          type: "text",
          text: `<system-context>\n${existingSystem}\n</system-context>`,
        };
        if (anthropicReq.messages.length > 0 && anthropicReq.messages[0].role === "user") {
          const first = anthropicReq.messages[0];
          if (Array.isArray(first.content)) {
            first.content = [systemCtx, ...first.content];
          } else {
            first.content = [systemCtx, { type: "text", text: String(first.content) }];
          }
        } else {
          anthropicReq.messages.unshift({ role: "user", content: [systemCtx] });
        }
      } else if (!existingSystem) {
        anthropicReq.system = CLAUDE_CODE_PREAMBLE;
      }

      // ROUTER-017: Anthropic OAuth tokens require tool names to match Claude Code
      // canonical PascalCase names. Remap OpenClaw tool names and track the mapping
      // so responses can be translated back.
      if (anthropicReq.tools && anthropicReq.tools.length > 0) {
        for (const tool of anthropicReq.tools) {
          const original = tool.name;
          // Convert snake_case/lowercase to PascalCase
          const pascal = original
            .split(/[_\s-]+/)
            .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
            .join("");
          if (pascal !== original) {
            toolNameMap.set(pascal, original);
            tool.name = pascal;
          }
        }
        // Also remap tool names in message history (tool_use and tool_result blocks)
        for (const msg of anthropicReq.messages) {
          if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === "tool_use" && typeof (block as any).name === "string") {
                const orig = (block as any).name as string;
                const pascal = orig
                  .split(/[_\s-]+/)
                  .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
                  .join("");
                if (pascal !== orig) (block as any).name = pascal;
              }
            }
          }
        }
      }
    }

    if (clientStream) {
      // Stream from Anthropic and convert SSE events to OpenAI chat.completion.chunk format
      (anthropicReq as any).stream = true;
      upstreamPath = "/v1/messages";
      upstreamBody = Buffer.from(JSON.stringify(anthropicReq));

      // Debug: dump request details
      const toolNames = anthropicReq.tools?.map((t: any) => t.name) ?? [];
      const sysPreamble = (anthropicReq.system ?? "").substring(0, 80);
      console.error(
        `[anthropic-req] model=${anthropicReq.model} tools=[${toolNames.join(",")}] system="${sysPreamble}..." msgs=${anthropicReq.messages?.length}`,
      );

      responseStreamMapper = async (upstream, nodeRes) => {
        if (!upstream.ok) {
          const raw = await upstream.text();
          console.error(`[anthropic-err] status=${upstream.status} body=${raw.substring(0, 300)}`);
          // Dump failing request body for debugging
          try {
            const { writeFileSync } = await import("node:fs");
            writeFileSync("/tmp/anthropic-failed-req.json", JSON.stringify(anthropicReq, null, 2));
            console.error(`[anthropic-err] request body dumped to /tmp/anthropic-failed-req.json`);
          } catch {}
          nodeRes.writeHead(upstream.status, { "content-type": "application/json" });
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
        let toolCallIndex = -1;

        for await (const frame of readSseDataFrames(upstream.body)) {
          if (frame.data === "[DONE]") break;
          const payload = tryParseJson<any>(frame.data);
          if (!payload) continue;

          const type = typeof payload.type === "string" ? payload.type : "";

          if (
            type === "content_block_delta" &&
            payload.delta?.type === "text_delta" &&
            typeof payload.delta.text === "string"
          ) {
            const chunk = {
              id: idFallback,
              object: "chat.completion.chunk",
              created,
              model: requestedModel,
              choices: [{ index: 0, delta: { content: payload.delta.text }, finish_reason: null }],
            };
            nodeRes.write(`data: ${JSON.stringify(chunk)}\n\n`);
          } else if (type === "content_block_start" && payload.content_block?.type === "tool_use") {
            // Start of a tool call — emit first chunk with id, name, and empty arguments
            toolCallIndex++;
            const block = payload.content_block;
            // Remap PascalCase tool name back to original OpenClaw name
            const toolName = toolNameMap.get(block.name) ?? block.name;
            const chunk = {
              id: idFallback,
              object: "chat.completion.chunk",
              created,
              model: requestedModel,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: toolCallIndex,
                        id: block.id,
                        type: "function",
                        function: { name: toolName, arguments: "" },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            };
            nodeRes.write(`data: ${JSON.stringify(chunk)}\n\n`);
          } else if (
            type === "content_block_delta" &&
            payload.delta?.type === "input_json_delta" &&
            typeof payload.delta.partial_json === "string"
          ) {
            // Streaming tool call arguments
            const chunk = {
              id: idFallback,
              object: "chat.completion.chunk",
              created,
              model: requestedModel,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: toolCallIndex,
                        function: { arguments: payload.delta.partial_json },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            };
            nodeRes.write(`data: ${JSON.stringify(chunk)}\n\n`);
          } else if (type === "message_delta") {
            // Final message delta with stop_reason
            const stopReason = payload.delta?.stop_reason;
            const finishReason =
              stopReason === "tool_use"
                ? "tool_calls"
                : stopReason === "end_turn" || stopReason === "stop_sequence"
                  ? "stop"
                  : stopReason === "max_tokens"
                    ? "length"
                    : null;
            if (finishReason) {
              const chunk = {
                id: idFallback,
                object: "chat.completion.chunk",
                created,
                model: requestedModel,
                choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
              };
              nodeRes.write(`data: ${JSON.stringify(chunk)}\n\n`);
            }
          }
        }

        nodeRes.write("data: [DONE]\n\n");
        nodeRes.end();
      };
    } else {
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
          requestedModel,
        });

        // Remap PascalCase tool names back to original OpenClaw names
        if (toolNameMap.size > 0) {
          const choices = (mapped as any).choices;
          if (Array.isArray(choices)) {
            for (const choice of choices) {
              const tcs = choice?.message?.tool_calls;
              if (Array.isArray(tcs)) {
                for (const tc of tcs) {
                  if (tc?.function?.name && toolNameMap.has(tc.function.name)) {
                    tc.function.name = toolNameMap.get(tc.function.name);
                  }
                }
              }
            }
          }
        }

        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify(mapped)),
        };
      };
    }
  }

  if (provider === "openai" && isChatCompletions && body.length > 0) {
    const openAiReq = JSON.parse(body.toString()) as OpenAIChatCompletionsRequest;
    if (typeof modelId === "string" && modelId.trim()) openAiReq.model = modelId;
    const normalized = normalizeOpenAiChatCompletionsRequest(openAiReq);
    upstreamBody = Buffer.from(JSON.stringify(normalized));
  }

  // openai-codex (chatgpt.com) adapter: OpenAI /v1/responses passthrough -> Codex responses
  if (provider === "openai-codex" && isResponses) {
    if (body.length === 0) throw new Error("Empty request body");

    // OpenClaw may call /v1/responses directly. The chatgpt.com Codex backend already speaks a
    // Responses-like protocol, so we can largely pass-through and just normalize the model id.
    const rspReq = JSON.parse(body.toString()) as any;
    if (typeof modelId === "string" && modelId.trim()) {
      // If OpenClaw calls /v1/responses with model=auto, resolve it to a concrete model.
      // We currently only support Codex + Anthropic upstreams; for Responses we route to Codex.
      const m = modelId.trim();
      const resolved = isAutoModelId(m) ? "openai-codex/gpt-5.2" : m;
      rspReq.model = toOpenAICodexModelId(resolved);
    }

    // Ensure required Codex fields.
    if (rspReq && typeof rspReq === "object") {
      if (rspReq.store === undefined) rspReq.store = false;
      if (!rspReq.instructions) rspReq.instructions = "You are a helpful assistant.";
      // Codex backend requires stream=true; if the caller didn't ask, we still stream upstream.
      rspReq.stream = true;
    }

    upstreamPath = "/backend-api/codex/responses";
    upstreamBody = Buffer.from(JSON.stringify(rspReq));

    // Stream passthrough (no mapping): OpenClaw expects Responses SSE.
    responseStreamMapper = async (upstream, nodeRes) => {
      const upstreamCt = upstream.headers.get("content-type") ?? "text/event-stream";
      nodeRes.writeHead(upstream.status, {
        "content-type": upstreamCt || "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
      });

      if (!upstream.body) {
        nodeRes.end();
        return;
      }

      const reader = upstream.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) nodeRes.write(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }

      nodeRes.end();
    };
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

        const looksLikeSse =
          upstreamCt.includes("text/event-stream") ||
          raw.startsWith("data:") ||
          raw.includes("\n\ndata:") ||
          raw.includes("\nevent:");

        if (looksLikeSse) {
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
  trace.providerId = provider ?? undefined;
  trace.upstreamUrl = upstreamUrl;

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
      trace.status = upstream.ok ? 200 : upstream.status;
      await responseStreamMapper(upstream, res);
    } else if (responseMapper) {
      const mapped = await responseMapper(upstream);
      trace.status = mapped.status;
      res.writeHead(mapped.status, mapped.headers);
      res.end(mapped.body);
    } else {
      const responseHeaders: Record<string, string> = {};
      upstream.headers.forEach((value, key) => {
        if (key === "transfer-encoding" || key === "connection") return;
        responseHeaders[key] = value;
      });

      trace.status = upstream.status;
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
