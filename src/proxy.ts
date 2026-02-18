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
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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
import { normalizeDeepSeekChatCompletionsRequest } from "./adapters/deepseek.js";
import { ProviderHealthManager, type ProviderTier, tierFromModelId } from "./provider-health.js";
import { resolveProviderForModelId, isAutoModelId, type ProviderId } from "./model-registry.js";
import { route, DEFAULT_ROUTING_CONFIG } from "./router/index.js";
import type { RoutingConfig } from "./router/types.js";
import type { ModelPricing } from "./router/selector.js";
import { BLOCKRUN_MODELS } from "./models.js";
import { VERSION } from "./version.js";
import { getOpenAICodexAuthHeader } from "./openclaw-auth-profiles.js";
import { FALLBACK_MODELS, canonicalModelForProviderTier } from "./fallback-config.js";
import type { RetryConfig } from "./retry.js";
import { fetchWithRetry } from "./retry.js";
import { createCodexSseToChatCompletionsMapper } from "./codex-sse-mapper.js";

const DEFAULT_PORT = 8402;
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;

// Debug: best-effort upstream request capture (prompt/messages) for short troubleshooting windows.
// Disabled by default; enable with env:
// - OAUTHROUTER_DEBUG_UPSTREAM_LOG=1
// - OAUTHROUTER_DEBUG_UPSTREAM_LOG_SECONDS=300   (optional auto-disable window)
// - OAUTHROUTER_DEBUG_UPSTREAM_LOG_MAX_CHARS=200000 (optional truncation)
// - OAUTHROUTER_DEBUG_UPSTREAM_LOG_PATH=...      (optional file path)
const UPSTREAM_DEBUG_START_MS = Date.now();
const UPSTREAM_DEBUG_ENABLED =
  process.env.OAUTHROUTER_DEBUG_UPSTREAM_LOG === "1" ||
  process.env.OAUTHROUTER_DEBUG_UPSTREAM_LOG === "true";
const UPSTREAM_DEBUG_SECONDS = Number(process.env.OAUTHROUTER_DEBUG_UPSTREAM_LOG_SECONDS || "0");
const UPSTREAM_DEBUG_MAX_CHARS = Math.max(
  1_000,
  Number(process.env.OAUTHROUTER_DEBUG_UPSTREAM_LOG_MAX_CHARS || "200000"),
);
const UPSTREAM_DEBUG_LOG_PATH =
  process.env.OAUTHROUTER_DEBUG_UPSTREAM_LOG_PATH ||
  join(homedir(), ".openclaw", "oauthrouter", "logs", "upstream-requests.jsonl");
let upstreamDebugDirReady = false;

function shouldLogUpstreamNow(): boolean {
  if (!UPSTREAM_DEBUG_ENABLED) return false;
  if (!Number.isFinite(UPSTREAM_DEBUG_SECONDS) || UPSTREAM_DEBUG_SECONDS <= 0) return true;
  return Date.now() - UPSTREAM_DEBUG_START_MS <= UPSTREAM_DEBUG_SECONDS * 1000;
}

function redactHeadersForLog(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const redact = new Set([
    "authorization",
    "proxy-authorization",
    "x-api-key",
    "x-openai-api-key",
    "cookie",
    "set-cookie",
  ]);
  for (const [k0, v] of Object.entries(headers)) {
    const k = k0.toLowerCase();
    out[k] = redact.has(k) ? "<redacted>" : v;
  }
  return out;
}

function truncateForLog(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const extra = text.length - maxChars;
  return text.slice(0, maxChars) + `\n\n<truncated ${extra} chars>`;
}

async function logUpstreamRequestDebug(entry: {
  requestId: string;
  provider: string;
  url: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array;
}): Promise<void> {
  if (!shouldLogUpstreamNow()) return;
  try {
    if (!upstreamDebugDirReady) {
      await mkdir(join(homedir(), ".openclaw", "oauthrouter", "logs"), { recursive: true });
      upstreamDebugDirReady = true;
    }
    const bodyText = truncateForLog(
      Buffer.from(entry.body).toString("utf8"),
      UPSTREAM_DEBUG_MAX_CHARS,
    );
    const line = JSON.stringify({
      ts: Date.now(),
      requestId: entry.requestId,
      provider: entry.provider,
      method: entry.method,
      path: entry.path,
      url: entry.url,
      headers: redactHeadersForLog(entry.headers),
      body: bodyText,
    });
    await appendFile(UPSTREAM_DEBUG_LOG_PATH, line + "\n");
  } catch {
    // Never break request flow.
  }
}

function canonicalModelForTier(provider: ProviderId, tier: ProviderTier): string | null {
  return canonicalModelForProviderTier(provider, tier);
}

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
	      .col-ts{width:165px}.col-provider{width:130px}.col-model{width:420px}.col-upstream{width:auto}.col-status{width:90px}.col-lat{width:100px;text-align:right}
      .pill{display:inline-block;padding:2px 8px;border-radius:999px;border:1px solid var(--border)}
      .good{color:#d4ffe6;background:rgba(31,138,76,.25);border-color:rgba(31,138,76,.55)}
      .warn{color:#fff3d6;background:rgba(199,144,45,.22);border-color:rgba(199,144,45,.55)}
      .bad{color:#ffd7d7;background:rgba(211,75,75,.18);border-color:rgba(211,75,75,.55)}
	      .muted{color:var(--muted)}.right{text-align:right}.mono{font-family:var(--mono)}.small{font-size:11px}
	      .kv{display:inline-block;min-width:64px;color:var(--muted)}
	      .stack{display:flex;flex-direction:column;gap:3px}
	      .tag{display:inline-block;padding:1px 6px;border-radius:7px;border:1px solid var(--border);font-size:11px;color:var(--muted);background:rgba(38,49,64,.22)}
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
	            <th class="col-model">model (requested -&gt; routed)</th>
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
	      function routedModelForEvent(e){
	        const mr=e?.modelIdRouted?String(e.modelIdRouted):'';
	        if(mr) return mr;
	        const pr=e?.preRoute?.routedModel?String(e.preRoute.routedModel):'';
	        if(pr) return pr;
	        const fb=e?.fallback?.fallbackModel?String(e.fallback.fallbackModel):'';
	        if(fb) return fb;
	        const res=e?.modelIdResolved?String(e.modelIdResolved):'';
	        if(res) return res;
	        const req=e?.modelIdRequested?String(e.modelIdRequested):'';
	        return req;
	      }
	      function render(){ const q=(filterEl.value||'').trim().toLowerCase(); let html=''; let shown=0; for(const e of events){ const session=e?.sessionKey?String(e.sessionKey):''; const provider=e?.providerId?String(e.providerId):''; const requested=e?.modelIdRequested?String(e.modelIdRequested):''; const resolved=e?.modelIdResolved?String(e.modelIdResolved):''; const routed=routedModelForEvent(e); const tier=e?.routingTier||''; const conf=e?.routingConfidence; const upstream=upstreamHostPath(e?.upstreamUrl);
	        const prOn=Boolean(e?.preRoute?.triggered); const fbOn=Boolean(e?.fallback?.triggered);
	        let tags=''; if(prOn){ const rp=e?.preRoute?.reason?String(e.preRoute.reason):'pre_route'; tags += '<span class="tag">pre-route</span>'; if(rp) tags += ' <span class="tag">'+esc(rp)+'</span>'; }
	        if(fbOn){ tags += (tags?' ':'') + '<span class="tag">fallback</span>'; const st=e?.fallback?.attempts?.length? e.fallback.attempts[e.fallback.attempts.length-1] : null; if(st && (st.fromStatus!=null || st.toStatus!=null)){ tags += ' <span class="tag">'+esc(String(st.fromStatus??'—'))+'→'+esc(String(st.toStatus??'—'))+'</span>'; } }
	        if(requested==='auto' && resolved){ tags += (tags?' ':'') + '<span class="tag">auto '+esc(String(tier||''))+(conf!=null?(' '+esc(String(Math.round(conf*100)))+'%'):'')+'</span>'; }
	        const modelCell =
	          '<div class="stack">'
	          + '<div><span class="kv">req</span>'+esc(requested||'')+'</div>'
	          + '<div><span class="kv">routed</span>'+esc(routed||'')+'</div>'
	          + (tags?('<div>'+tags+'</div>'):'')
	          + '</div>';
	        const hay=(session+' '+provider+' '+requested+' '+resolved+' '+routed+' '+tier+' '+upstream+' '+(prOn?'pre-route ':'')+(fbOn?'fallback ':'')).toLowerCase(); if(q && !hay.includes(q)) continue; const statusText=(e?.status!=null)?String(e.status):'—'; const stCls=clsForStatus(e?.status); const latCls=clsForLatency(e?.latencyMs||0);
	        html += '<tr>'
	          + '<td class="col-ts muted">'+esc(fmtTs(e?.ts))+'</td>'
	          + '<td class="col-session mono small">'+esc(session)+'</td>'
	          + '<td class="col-provider">'+esc(provider)+'</td>'
	          + '<td class="col-model">'+modelCell+'</td>'
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
      fallback: [FALLBACK_MODELS["openai-codex"].SIMPLE, "openai-codex/gpt-5.2-codex"],
    },
    MEDIUM: {
      primary: "openai-codex/gpt-5.2-codex",
      fallback: ["anthropic/claude-sonnet-4-5", FALLBACK_MODELS["openai-codex"].MEDIUM],
    },
    COMPLEX: {
      primary: "anthropic/claude-sonnet-4-5",
      fallback: ["anthropic/claude-opus-4-5", FALLBACK_MODELS["openai-codex"].COMPLEX],
    },
    REASONING: {
      primary: "anthropic/claude-opus-4-6",
      fallback: ["anthropic/claude-opus-4-5", FALLBACK_MODELS["openai-codex"].REASONING],
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

export type RateLimitFallbackConfig = {
  /**
   * If true, when an upstream returns a rate-limit style response (default: [429]),
   * retry the request against another provider/model and return that response to the client.
   *
   * This is the fix for: OpenClaw model fallbacks don't help when the proxy itself returns 429,
   * because OpenClaw can't re-play the same request/stream in a provider-aware way.
   */
  enabled?: boolean;
  /** HTTP status codes that should trigger fallback (default: [429]). */
  onStatusCodes?: number[];
  /** Only apply fallback when the initial attempt used one of these providers (default: ["anthropic"]). */
  fromProviders?: ProviderId[];

  /**
   * Ordered fallback chain. The proxy tries each entry in order when the upstream
   * returns a retryable rate-limit response (default: 429).
   *
   * Example: Anthropic 429 -> openai-codex -> deepseek.
   */
  chain?: Array<{
    provider: ProviderId;
    /**
     * Optional map from requested model -> fallback model for this hop.
     * Keys are normalized via `normalizeModelId()` (so "oauthrouter/anthropic/..." works).
     */
    modelMap?: Record<string, string>;
    /**
     * Default model if `modelMap` doesn't match (optional).
     * Should be a router model id (e.g. "openai-codex/gpt-5.3-codex", "deepseek/deepseek-chat").
     */
    defaultModel?: string;
  }>;

  // Back-compat (single-hop).
  toProvider?: ProviderId;
  modelMap?: Record<string, string>;
  defaultModel?: string;
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
  /**
   * Host/interface to bind the local proxy to (default: "127.0.0.1").
   *
   * Recommended for remote viewing of `/debug/*`: keep this at "127.0.0.1" and
   * use SSH local port forwarding (`ssh -L ...`) rather than exposing the port
   * on your LAN.
   */
  listenHost?: string;
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

  /** Optional provider-aware 429 fallback (recommended). */
  rateLimitFallback?: RateLimitFallbackConfig;

  /**
   * Optional provider health/cooldown tracking.
   *
   * If enabled, oauthrouter will persist a small health state file and may pre-route
   * away from providers that are currently in cooldown (e.g. after 429s), avoiding
   * the extra upstream roundtrip and preserving streaming context.
   */
  providerHealth?: {
    enabled?: boolean;
    persistPath?: string;
    baseCooldownMs?: number;
    maxCooldownMs?: number;
    /** Optional background probes to detect recovery and measure baseline latency. */
    probeIntervalMs?: number;
    probeTimeoutMs?: number;
  };

  /**
   * Optional upstream retry config for transient errors.
   *
   * Note: We intentionally do NOT retry on 429 by default; instead we rely on the
   * provider-aware `rateLimitFallback` chain (Anthropic -> Codex -> DeepSeek).
   */
  retry?: Partial<RetryConfig>;

  onReady?: (port: number) => void;
  onError?: (error: Error) => void;
};

export type ProxyHandle = {
  port: number;
  listenHost: string;
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

async function buildUpstreamHeadersForProvider(
  req: IncomingMessage,
  options: ProxyOptions,
  provider: ProviderId,
  upstreamConfig: UpstreamProviderConfig | undefined,
): Promise<Record<string, string>> {
  // Forward headers, stripping hop-by-hop + local auth.
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

  return headers;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchUpstreamWithRetry(
  options: ProxyOptions,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const retry = options.retry ?? DEFAULT_UPSTREAM_RETRY;
  const fetchFn = (u: string, i?: RequestInit) => fetchWithTimeout(u, i ?? {}, timeoutMs);
  return fetchWithRetry(fetchFn, url, init, retry);
}

const DEFAULT_UPSTREAM_RETRY: Partial<RetryConfig> = {
  // Keep this small; this proxy is in the critical path.
  maxRetries: 1,
  baseDelayMs: 250,
  // Prefer fast failover over waiting out rate limits.
  // 520/529 = Cloudflare upstream errors (common with Anthropic).
  retryableCodes: [502, 503, 504, 520, 529],
};

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

function shouldTriggerRateLimitFallback(
  cfg: RateLimitFallbackConfig | undefined,
  provider: ProviderId | null,
  status: number,
): boolean {
  if (!cfg || cfg.enabled === false) return false;
  // 429 = rate limit, 529 = Cloudflare overloaded (after retry exhaustion)
  const codes = cfg.onStatusCodes && cfg.onStatusCodes.length > 0 ? cfg.onStatusCodes : [429, 529];
  if (!codes.includes(status)) return false;

  const from =
    cfg.fromProviders && cfg.fromProviders.length > 0
      ? cfg.fromProviders
      : (["anthropic"] as const);
  return provider ? (from as readonly string[]).includes(provider) : false;
}

function getFallbackChain(cfg: RateLimitFallbackConfig | undefined): Array<{
  provider: ProviderId;
  modelMap?: Record<string, string>;
  defaultModel?: string;
}> {
  if (!cfg) return [];

  if (Array.isArray(cfg.chain) && cfg.chain.length > 0) {
    return cfg.chain
      .filter(
        (
          x,
        ): x is {
          provider: ProviderId;
          modelMap?: Record<string, string>;
          defaultModel?: string;
        } => Boolean(x && typeof x === "object" && typeof (x as any).provider === "string"),
      )
      .map((x) => ({
        provider: x.provider,
        modelMap: x.modelMap,
        defaultModel: x.defaultModel,
      }));
  }

  // Back-compat single hop.
  if (cfg.toProvider) {
    return [
      {
        provider: cfg.toProvider,
        modelMap: cfg.modelMap,
        defaultModel: cfg.defaultModel,
      },
    ];
  }

  // Sensible default: Anthropic 429 -> Codex -> DeepSeek.
  return [
    { provider: "openai-codex", defaultModel: "openai-codex/gpt-5.3-codex" },
    { provider: "deepseek", defaultModel: "deepseek/deepseek-chat" },
  ];
}

function resolveFallbackModelId(
  modelMap: Record<string, string> | undefined,
  defaultModel: string | undefined,
  requestedModelId: string | undefined,
): string | null {
  const requested = requestedModelId ? normalizeModelId(requestedModelId) : "";
  if (requested && modelMap) {
    const direct = modelMap[requested];
    if (typeof direct === "string" && direct.trim()) return direct.trim();
  }
  return typeof defaultModel === "string" && defaultModel.trim() ? defaultModel.trim() : null;
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
  const health =
    options.providerHealth?.enabled && options.providers
      ? new ProviderHealthManager({
          persistPath: options.providerHealth.persistPath,
          baseCooldownMs: options.providerHealth.baseCooldownMs,
          maxCooldownMs: options.providerHealth.maxCooldownMs,
        })
      : null;
  const probeIntervalMs =
    Number.isFinite(options.providerHealth?.probeIntervalMs) &&
    (options.providerHealth?.probeIntervalMs ?? 0) > 0
      ? (options.providerHealth?.probeIntervalMs as number)
      : 30 * 60_000;
  const probeTimeoutMs =
    Number.isFinite(options.providerHealth?.probeTimeoutMs) &&
    (options.providerHealth?.probeTimeoutMs ?? 0) > 0
      ? (options.providerHealth?.probeTimeoutMs as number)
      : 8_000;

  let probeTimer: NodeJS.Timeout | null = null;

  async function buildProbeHeadersForProvider(
    provider: ProviderId,
    upstreamConfig: UpstreamProviderConfig | undefined,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    applyUpstreamHeaderOverrides(headers, options);
    applyProviderHeaderOverrides(headers, upstreamConfig);
    if (!headers["content-type"]) headers["content-type"] = "application/json";

    if (provider === "openai-codex") {
      if (!headers["openai-beta"]) headers["openai-beta"] = "responses=experimental";
      if (!headers["originator"]) headers["originator"] = "pi";
      headers["accept"] = "text/event-stream";
      headers["user-agent"] = `pi(oauthrouter/${VERSION})`;

      if (!headers["authorization"]) {
        const auth = await getOpenAICodexAuthHeader({ authStorePath: options.authStorePath });
        headers["authorization"] = auth.Authorization;
      }

      const bearer = headers["authorization"];
      const m = typeof bearer === "string" ? bearer.match(/^\s*Bearer\s+(.+)\s*$/i) : null;
      const jwt = m ? m[1] : typeof bearer === "string" ? bearer.trim() : "";
      const accountId = jwt ? extractChatGptAccountIdFromJwt(jwt) : undefined;
      if (accountId && !headers["chatgpt-account-id"]) headers["chatgpt-account-id"] = accountId;
    }

    if (provider === "anthropic") {
      if (!headers["anthropic-version"]) headers["anthropic-version"] = "2023-06-01";
      normalizeAnthropicUpstreamAuthHeaders(headers);
    }

    return headers;
  }

  async function probeProvider(
    provider: ProviderId,
    tier: ProviderTier,
    modelId: string,
  ): Promise<void> {
    if (!health || !options.providers) return;
    if (tier === "UNKNOWN") return;

    const cfg = options.providers[provider];
    if (!cfg) return;

    const urlBase = cfg.apiBase;
    if (!urlBase) return;

    let url = `${urlBase}/v1/chat/completions`;
    let body: string;

    if (provider === "anthropic") {
      url = `${urlBase}/v1/messages`;
      const oa = {
        model: modelId,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      } as OpenAIChatCompletionsRequest;
      const anthropicReq = buildAnthropicMessagesRequestFromOpenAI(oa);

      // Mirror the OAuth-token system-preamble requirement used in the main request path (ROUTER-016).
      const providerAuthHeader = cfg.authHeader;
      const providerAuthToken =
        typeof providerAuthHeader === "string"
          ? providerAuthHeader.replace(/^Bearer\s+/i, "")
          : typeof providerAuthHeader === "object" && providerAuthHeader?.value
            ? providerAuthHeader.value.replace(/^Bearer\s+/i, "")
            : null;
      if (providerAuthToken && providerAuthToken.startsWith("sk-ant-oat")) {
        const CLAUDE_CODE_PREAMBLE = "You are Claude Code, Anthropic's official CLI for Claude.";
        anthropicReq.system = CLAUDE_CODE_PREAMBLE;
      }

      body = JSON.stringify(anthropicReq);
    } else if (provider === "openai-codex") {
      url = `${urlBase}/backend-api/codex/responses`;
      const oa = {
        model: modelId,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false,
      } as OpenAIChatCompletionsRequest;
      body = JSON.stringify(buildCodexResponsesRequestFromOpenAIChatCompletions(oa));
    } else if (provider === "deepseek") {
      const oa = {
        model: modelId,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      } as OpenAIChatCompletionsRequest;
      body = JSON.stringify(normalizeDeepSeekChatCompletionsRequest(oa));
    } else if (provider === "openai") {
      const oa = {
        model: modelId,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      } as OpenAIChatCompletionsRequest;
      body = JSON.stringify(normalizeOpenAiChatCompletionsRequest(oa));
    } else {
      // Unknown provider, skip.
      return;
    }

    let headers: Record<string, string>;
    try {
      headers = await buildProbeHeadersForProvider(provider, cfg);
    } catch (err) {
      // If we can't even build headers (auth refresh failure etc), record a failure and return.
      const msg = err instanceof Error ? err.stack || err.message : String(err);
      console.error(`[provider-probe] headers provider=${provider} tier=${tier} error=${msg}`);
      health.recordResult(provider, tier, 599);
      return;
    }
    const started = Date.now();
    try {
      const rsp = await fetchWithTimeout(url, { method: "POST", headers, body }, probeTimeoutMs);
      health.recordResult(provider, tier, rsp.status, Date.now() - started);
      try {
        await rsp.body?.cancel();
      } catch {
        // ignore
      }
    } catch {
      // Treat timeouts/network errors as 599-ish.
      health.recordResult(provider, tier, 599, Date.now() - started);
    }
  }

  async function runBackgroundProbesOnce(): Promise<void> {
    if (!health || !options.providers) return;
    const fbCfg = options.rateLimitFallback;
    if (!fbCfg?.enabled) return;

    const tiers: ProviderTier[] = ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"];
    for (const tier of tiers) {
      for (const provider of Object.keys(options.providers) as ProviderId[]) {
        try {
          const model = canonicalModelForTier(provider, tier);
          if (!model) continue;
          await probeProvider(provider, tier, model);
        } catch (err) {
          // Never let probes crash the proxy. Treat as a failure signal for that provider/tier.
          try {
            health.recordResult(provider, tier, 599);
          } catch {
            // ignore
          }
          const msg = err instanceof Error ? err.stack || err.message : String(err);
          console.error(`[provider-probe] provider=${provider} tier=${tier} error=${msg}`);
        }
      }
    }
  }

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
      health &&
      (req.url === "/debug/provider-health" || req.url?.startsWith("/debug/provider-health?"))
    ) {
      sendJson(res, 200, { state: health.getSnapshot() });
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
      await proxyRequest(req, res, options, budgetTracker, trace, health);
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
  const listenHost =
    typeof options.listenHost === "string" && options.listenHost.trim()
      ? options.listenHost.trim()
      : "127.0.0.1";
  // 0.0.0.0 is not a connectable destination; return a sane local baseUrl for callers.
  const baseHost = listenHost === "0.0.0.0" ? "127.0.0.1" : listenHost;

  return new Promise<ProxyHandle>((resolve, reject) => {
    server.on("error", reject);

    server.listen(listenPort, listenHost, () => {
      const addr = server.address() as AddressInfo;
      const port = addr.port;

      if (health && options.providerHealth?.enabled) {
        // Fire-and-forget initial probe; then keep probing in the background.
        void runBackgroundProbesOnce().catch((err) => {
          const msg = err instanceof Error ? err.stack || err.message : String(err);
          console.error(`[provider-probe] initial error=${msg}`);
        });
        probeTimer = setInterval(() => {
          void runBackgroundProbesOnce().catch((err) => {
            const msg = err instanceof Error ? err.stack || err.message : String(err);
            console.error(`[provider-probe] interval error=${msg}`);
          });
        }, probeIntervalMs);
        // Don't keep the process alive just for probes.
        probeTimer.unref?.();
      }

      options.onReady?.(port);
      resolve({
        port,
        listenHost,
        baseUrl: `http://${baseHost}:${port}`,
        authToken,
        close: () =>
          new Promise<void>((res, rej) => {
            if (probeTimer) {
              clearInterval(probeTimer);
              probeTimer = null;
            }
            server.close((e) => (e ? rej(e) : res()));
          }),
      });
    });
  });
}

// --- Test-only exports ---
// These helpers are intentionally not part of the stable public API; they exist to make
// the proxy's normalization and fallback logic unit-testable without binding sockets.
export const __test__canonicalModelForTier = canonicalModelForTier;
export const __test__parseBearerToken = parseBearerToken;
export const __test__ensureCommaSeparatedIncludes = ensureCommaSeparatedIncludes;
export const __test__normalizeAnthropicUpstreamAuthHeaders = normalizeAnthropicUpstreamAuthHeaders;
export const __test__estimateInputTokensFromBody = estimateInputTokensFromBody;
export const __test__shouldTriggerRateLimitFallback = shouldTriggerRateLimitFallback;
export const __test__getRateLimitFallbackChain = getFallbackChain;
export const __test__resolveFallbackModelId = resolveFallbackModelId;

async function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: ProxyOptions,
  budgetTracker: DailyBudgetTracker,
  trace: TraceEvent,
  health: ProviderHealthManager | null,
): Promise<void> {
  const originalPath = req.url ?? "";

  // Collect body
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  let body = Buffer.concat(chunks);

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
  trace.toolCount = (parsed as any)?.tools?.length ?? 0;

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

    // Detect image content in the last user message
    const hasImageContent = (() => {
      if (!lastUserMsg || !Array.isArray(lastUserMsg.content)) return false;
      return lastUserMsg.content.some(
        (block: any) => block && typeof block === "object" && block.type === "image_url",
      );
    })();

    const modelPricing = buildModelPricingForAuto();
    // Don't pass system prompt to router - it's the agent identity, not the user's request
    const decision = route(prompt, undefined, maxTokens, {
      config: options.routingConfig ?? DEFAULT_AUTO_ROUTING_CONFIG,
      modelPricing,
      hasImageContent,
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
  let provider: ProviderId | null = options.providers
    ? providerFromModel
    : options.apiBase
      ? isAnthropicApiBase(options.apiBase)
        ? "anthropic"
        : "openai"
      : providerFromModel;

  const tier = tierFromModelId(modelId);
  trace.tier = tier;

  // Pre-route away from providers in cooldown (e.g. after 429s) BEFORE hitting upstream.
  // This avoids paying an extra 429 roundtrip and preserves streaming context.
  if (
    health &&
    provider &&
    tier !== "UNKNOWN" &&
    health.isInCooldown(provider, tier) &&
    options.rateLimitFallback?.enabled
  ) {
    // Candidates are: primary provider first, then the configured fallback chain providers.
    const chain = getFallbackChain(options.rateLimitFallback);
    const candidates: ProviderId[] = [provider];
    for (const h of chain) {
      const p = h.provider;
      if (!p || p === provider) continue;
      if (!candidates.includes(p)) candidates.push(p);
    }

    const picked = health.pickHealthyProvider(tier, candidates);
    if (picked && picked !== provider) {
      // Rewrite the requested model to the picked provider's mapped model when possible.
      // If we don't have a direct mapping for this model id, fall back to a canonical per-tier model.
      const hop = chain.find((h) => h.provider === picked);
      const routedModel =
        hop?.provider && (hop.modelMap || hop.defaultModel)
          ? resolveFallbackModelId(hop.modelMap, hop.defaultModel, modelId)
          : null;
      const routedModelFinal = routedModel ?? canonicalModelForTier(picked, tier);

      if (routedModelFinal) {
        trace.preRoute = {
          triggered: true,
          fromProvider: provider,
          toProvider: picked,
          requestedModel: modelId,
          routedModel: routedModelFinal,
          reason: "provider_in_cooldown",
        };
        modelId = routedModelFinal;
        if (parsed) parsed.model = routedModelFinal;
        provider = picked;
      }
    }
  }

  // --- Tool-use preamble (universal, all providers) ---
  // Non-Claude models (GPT-5.x Codex, DeepSeek, etc.) tend to describe tool calls
  // and ask for confirmation rather than invoking them directly.  Injecting an
  // explicit instruction into the system message fixes this across all providers.
  if (
    isChatCompletions &&
    parsed &&
    Array.isArray((parsed as any).tools) &&
    (parsed as any).tools.length > 0
  ) {
    const toolPreamble =
      "IMPORTANT: You have tools available. When a user's request can be fulfilled by calling a tool, you MUST call the tool directly. Do NOT describe what you would do, ask for confirmation, or explain that you will use a tool. Just call it.";

    const msgs = parsed.messages;
    if (Array.isArray(msgs)) {
      const lastSystemIdx = msgs.reduce<number>((acc, m, i) => (m.role === "system" ? i : acc), -1);
      if (lastSystemIdx >= 0) {
        const sys = msgs[lastSystemIdx];
        const existing = typeof sys.content === "string" ? sys.content : "";
        sys.content = existing + "\n\n" + toolPreamble;
      } else {
        msgs.unshift({ role: "system", content: toolPreamble });
      }
    }

    if ((parsed as any).tool_choice === undefined) {
      (parsed as any).tool_choice = "auto";
    }

    body = Buffer.from(JSON.stringify(parsed));

    console.error(
      `[tool-preamble] injected for ${provider}/${modelId} tools=${(parsed as any).tools.length}`,
    );
  }

  const upstreamConfig = provider && options.providers ? options.providers[provider] : undefined;
  const upstreamApiBase = upstreamConfig?.apiBase ?? options.apiBase;
  if (!upstreamApiBase) {
    throw new Error("No upstream apiBase configured");
  }

  // Capture the model we are about to route upstream. This is updated again if we fall back later.
  trace.modelIdRouted = modelId;

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
      // Extract system text regardless of string or AnthropicSystemBlock[] format
      const existingSystem =
        typeof anthropicReq.system === "string"
          ? anthropicReq.system
          : Array.isArray(anthropicReq.system)
            ? anthropicReq.system.map((b: any) => b.text ?? "").join("\n\n")
            : "";
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
      const sysPreamble = (
        typeof anthropicReq.system === "string"
          ? anthropicReq.system
          : Array.isArray(anthropicReq.system)
            ? anthropicReq.system.map((b: any) => b.text ?? "").join(" ")
            : ""
      ).substring(0, 80);
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

        // FIX-4: Send SSE heartbeat immediately to prevent OpenClaw 10-15s timeout
        // while Anthropic is processing (especially for extended thinking).
        nodeRes.write(": heartbeat\n\n");

        if (!upstream.body) {
          nodeRes.write("data: [DONE]\n\n");
          nodeRes.end();
          return;
        }

        const created = Math.floor(Date.now() / 1000);
        const idFallback = `chatcmpl_${randomBytes(12).toString("hex")}`;
        let toolCallIndex = -1;
        // FIX-3: Track usage from Anthropic SSE events
        let usageInputTokens = 0;
        let usageOutputTokens = 0;
        // FIX-1: Track whether we're inside a thinking block
        let insideThinkingBlock = false;

        for await (const frame of readSseDataFrames(upstream.body)) {
          if (frame.data === "[DONE]") break;
          const payload = tryParseJson<any>(frame.data);
          if (!payload) continue;

          const type = typeof payload.type === "string" ? payload.type : "";

          // FIX-3: Capture usage from message_start event
          if (type === "message_start" && payload.message?.usage) {
            usageInputTokens = payload.message.usage.input_tokens ?? 0;
          }

          // FIX-1: Track thinking block start/stop (don't forward thinking text as content)
          if (type === "content_block_start" && payload.content_block?.type === "thinking") {
            insideThinkingBlock = true;
            continue;
          }
          if (type === "content_block_stop" && insideThinkingBlock) {
            insideThinkingBlock = false;
            continue;
          }
          // FIX-1: Skip thinking deltas — OpenClaw stores them from native API but
          // they shouldn't be forwarded as content through the OpenAI compat layer.
          if (
            type === "content_block_delta" &&
            (payload.delta?.type === "thinking_delta" || payload.delta?.type === "signature_delta")
          ) {
            continue;
          }

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
            // FIX-3: Capture output token usage from message_delta
            if (payload.usage?.output_tokens) {
              usageOutputTokens = payload.usage.output_tokens;
            }
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
              const chunk: Record<string, unknown> = {
                id: idFallback,
                object: "chat.completion.chunk",
                created,
                model: requestedModel,
                choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
              };
              // FIX-3: Attach usage to the final chunk
              if (usageInputTokens > 0 || usageOutputTokens > 0) {
                chunk.usage = {
                  prompt_tokens: usageInputTokens,
                  completion_tokens: usageOutputTokens,
                  total_tokens: usageInputTokens + usageOutputTokens,
                };
              }
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

  if (provider === "deepseek" && isChatCompletions && body.length > 0) {
    const openAiReq = JSON.parse(body.toString()) as OpenAIChatCompletionsRequest;
    if (typeof modelId === "string" && modelId.trim()) openAiReq.model = modelId;
    const normalized = normalizeDeepSeekChatCompletionsRequest(openAiReq);
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
      const resolved = isAutoModelId(m) ? FALLBACK_MODELS["openai-codex"].SIMPLE : m;
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
        const mapper = createCodexSseToChatCompletionsMapper({
          created,
          idFallback,
          requestedModel,
        });

        for await (const frame of readSseDataFrames(upstream.body)) {
          if (frame.data === "[DONE]") break;

          const payload = tryParseJson<any>(frame.data);
          if (!payload) continue;

          for (const outChunk of mapper.handlePayload(payload)) {
            nodeRes.write(`data: ${JSON.stringify(outChunk)}\n\n`);
          }

          // Ignore reasoning/metadata events.
        }

        // Emit a terminal finish_reason so tool loops can trigger correctly.
        const { finalChunk } = mapper.finalize();
        nodeRes.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
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
        const toolCalls: Array<{
          id: string;
          type: "function";
          function: { name: string; arguments: string };
        }> = [];
        const toolCallIdx = new Map<string, number>();
        let activeToolCallId: string | null = null;

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
            if (type === "response.output_item.added") {
              const item = payload.item;
              if (item && typeof item === "object" && item.type === "function_call") {
                const callId = typeof item.call_id === "string" ? item.call_id : "";
                const name = typeof item.name === "string" ? item.name : "";
                if (callId && name) {
                  activeToolCallId = callId;
                  if (!toolCallIdx.has(callId)) {
                    toolCallIdx.set(callId, toolCalls.length);
                    const rawArgs = (item as any).arguments;
                    toolCalls.push({
                      id: callId,
                      type: "function",
                      function: {
                        name,
                        arguments:
                          typeof rawArgs === "string"
                            ? rawArgs
                            : rawArgs && typeof rawArgs === "object"
                              ? JSON.stringify(rawArgs)
                              : "",
                      },
                    });
                  }
                }
              }
            }
            if (
              type === "response.function_call_arguments.delta" &&
              payload &&
              typeof payload === "object"
            ) {
              const callId =
                typeof payload.call_id === "string"
                  ? payload.call_id
                  : activeToolCallId
                    ? activeToolCallId
                    : "";
              const d = (payload as any).delta;
              const delta =
                typeof d === "string"
                  ? d
                  : d && typeof d === "object" && typeof (d as any).partial_json === "string"
                    ? String((d as any).partial_json)
                    : d && typeof d === "object" && typeof (d as any).delta === "string"
                      ? String((d as any).delta)
                      : d && typeof d === "object" && typeof (d as any).arguments === "string"
                        ? String((d as any).arguments)
                        : "";
              if (callId && delta && toolCallIdx.has(callId)) {
                const idx = toolCallIdx.get(callId) ?? 0;
                toolCalls[idx]!.function.arguments += delta;
              }
            }
            if (
              type === "response.function_call_arguments.done" &&
              payload &&
              typeof payload === "object"
            ) {
              const callId =
                typeof payload.call_id === "string"
                  ? payload.call_id
                  : activeToolCallId
                    ? activeToolCallId
                    : "";
              const rawArgs = (payload as any).arguments;
              const args =
                typeof rawArgs === "string"
                  ? rawArgs
                  : rawArgs && typeof rawArgs === "object"
                    ? JSON.stringify(rawArgs)
                    : "";
              if (callId && args && toolCallIdx.has(callId)) {
                const idx = toolCallIdx.get(callId) ?? 0;
                toolCalls[idx]!.function.arguments = args;
              }
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

          const outItems = (json as any)?.output;
          if (Array.isArray(outItems)) {
            for (const it of outItems) {
              if (it && typeof it === "object" && it.type === "function_call") {
                const callId = typeof it.call_id === "string" ? it.call_id : "";
                const name = typeof it.name === "string" ? it.name : "";
                const args = typeof it.arguments === "string" ? it.arguments : "";
                if (callId && name) {
                  toolCalls.push({
                    id: callId,
                    type: "function",
                    function: { name, arguments: args },
                  });
                }
              }
            }
          }
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
              message: {
                role: "assistant",
                content: toolCalls.length > 0 ? content || null : content,
                ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
              },
              finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
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

  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  try {
    if (!provider) throw new Error("Could not resolve provider for requested model");

    const primaryHeaders = await buildUpstreamHeadersForProvider(
      req,
      options,
      provider,
      upstreamConfig,
    );
    let activeProvider: ProviderId = provider;
    let activeUpstreamUrl = upstreamUrl;
    let activeUpstreamPath = upstreamPath;
    let activeUpstreamBody = upstreamBody;
    let activeStreamMapper = responseStreamMapper;
    let activeMapper = responseMapper;
    let passthrough = !activeStreamMapper && !activeMapper;

    // Debug: capture the exact upstream request body (after adapter transforms).
    void logUpstreamRequestDebug({
      requestId: trace.requestId,
      provider: activeProvider,
      url: activeUpstreamUrl,
      path: activeUpstreamPath,
      method: req.method ?? "POST",
      headers: primaryHeaders,
      body: activeUpstreamBody,
    });

    let upstream = await fetchUpstreamWithRetry(
      options,
      activeUpstreamUrl,
      {
        method: req.method ?? "POST",
        headers: primaryHeaders,
        body: activeUpstreamBody.length > 0 ? activeUpstreamBody : undefined,
      },
      timeoutMs,
    );

    // Update provider health based on the initial attempt.
    if (health && tier !== "UNKNOWN") {
      const initialLatency = Date.now() - trace.ts;
      health.recordResult(activeProvider, tier, upstream.status, initialLatency);
    }

    // Provider-aware 429 fallback (fix for OpenClaw fallbacks not being able to replay the request).
    // Chain: Anthropic -> Codex -> DeepSeek (default), configurable via options.rateLimitFallback.chain.
    const fbCfg = options.rateLimitFallback;
    if (
      isChatCompletions &&
      shouldTriggerRateLimitFallback(fbCfg, activeProvider, upstream.status)
    ) {
      const chain = getFallbackChain(fbCfg);
      const attempts: NonNullable<TraceEvent["fallback"]>["attempts"] = [];

      // Parse the original OpenAI-shaped request once so we can replay it.
      let originalOpenAiReq: OpenAIChatCompletionsRequest | null = null;
      try {
        originalOpenAiReq = JSON.parse(body.toString()) as OpenAIChatCompletionsRequest;
      } catch {
        originalOpenAiReq = null;
      }

      for (const hop of chain) {
        if (!originalOpenAiReq) break;

        const toProvider = hop.provider;
        // Avoid loops when the fallback chain includes the active provider.
        if (toProvider === activeProvider) continue;
        const toConfig = options.providers?.[toProvider];
        if (!toConfig) continue;

        const fallbackModel = resolveFallbackModelId(hop.modelMap, hop.defaultModel, modelId);
        if (!fallbackModel) continue;

        // Best-effort: close the previous response body before the next attempt.
        try {
          await upstream.body?.cancel();
        } catch {}

        // Clone + rewrite model.
        const openAiReq: OpenAIChatCompletionsRequest = {
          ...originalOpenAiReq,
          model: fallbackModel,
        };

        let fbPath = originalPath; // preserve any query string
        let fbBody: Uint8Array;
        let fbStreamMapper:
          | ((upstream: Response, res: ServerResponse) => Promise<void>)
          | undefined;
        let fbMapper:
          | ((
              upstream: Response,
            ) => Promise<{ status: number; headers: Record<string, string>; body: Buffer }>)
          | undefined;

        if (toProvider === "openai-codex") {
          // Re-use the existing Codex adapter path (chat.completions -> /backend-api/codex/responses).
          const clientStream = Boolean((openAiReq as any).stream);
          const requestedModel = typeof openAiReq.model === "string" ? openAiReq.model : undefined;
          const codexReq = buildCodexResponsesRequestFromOpenAIChatCompletions(openAiReq);

          fbPath = "/backend-api/codex/responses";
          fbBody = Buffer.from(JSON.stringify(codexReq));

          if (clientStream) {
            fbStreamMapper = async (upstreamRsp, nodeRes) => {
              const upstreamCt = upstreamRsp.headers.get("content-type") ?? "";

              if (!upstreamRsp.ok) {
                const raw = await upstreamRsp.text();
                nodeRes.writeHead(upstreamRsp.status, {
                  "content-type": upstreamCt || "application/json",
                });
                nodeRes.end(raw);
                return;
              }

              nodeRes.writeHead(200, {
                "content-type": "text/event-stream; charset=utf-8",
                "cache-control": "no-cache, no-transform",
              });

              if (!upstreamRsp.body) {
                nodeRes.write("data: [DONE]\n\n");
                nodeRes.end();
                return;
              }

              const created = Math.floor(Date.now() / 1000);
              const idFallback = `chatcmpl_${randomBytes(12).toString("hex")}`;
              let id = idFallback;

              for await (const frame of readSseDataFrames(upstreamRsp.body)) {
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
              }

              nodeRes.write("data: [DONE]\n\n");
              nodeRes.end();
            };
          } else {
            fbMapper = async (upstreamRsp) => {
              const upstreamCt = upstreamRsp.headers.get("content-type") ?? "application/json";
              const raw = await upstreamRsp.text();

              if (!upstreamRsp.ok) {
                return {
                  status: upstreamRsp.status,
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
                  if (rsp && typeof rsp === "object" && typeof rsp.id === "string")
                    upstreamId = rsp.id;

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
        } else {
          // OpenAI-compatible providers: /v1/chat/completions passthrough with model normalization.
          const normalized =
            toProvider === "deepseek"
              ? normalizeDeepSeekChatCompletionsRequest(openAiReq)
              : toProvider === "openai"
                ? normalizeOpenAiChatCompletionsRequest(openAiReq)
                : openAiReq;
          fbBody = Buffer.from(JSON.stringify(normalized));
        }

        const fbUrl = `${toConfig.apiBase}${fbPath}`;
        const fbHeaders = await buildUpstreamHeadersForProvider(req, options, toProvider, toConfig);

        const fbStarted = Date.now();
        // Debug: capture the fallback hop request body as well.
        void logUpstreamRequestDebug({
          requestId: trace.requestId,
          provider: toProvider,
          url: fbUrl,
          path: fbPath,
          method: req.method ?? "POST",
          headers: fbHeaders,
          body: Buffer.from(fbBody),
        });
        const fbUpstream = await fetchUpstreamWithRetry(
          options,
          fbUrl,
          { method: req.method ?? "POST", headers: fbHeaders, body: fbBody as unknown as BodyInit },
          timeoutMs,
        );
        const fbLatency = Date.now() - fbStarted;

        attempts.push({
          fromProvider: activeProvider,
          toProvider,
          fromStatus: upstream.status,
          toStatus: fbUpstream.status,
          requestedModel: modelId,
          fallbackModel,
        });

        if (health && tier !== "UNKNOWN") {
          // Record the rate-limit failure on the previous provider and the result of this hop.
          health.recordResult(activeProvider, tier, upstream.status);
          health.recordResult(toProvider, tier, fbUpstream.status, fbLatency);
        }

        // If this hop isn't rate-limited, accept it and stop.
        upstream = fbUpstream;
        activeProvider = toProvider;
        activeUpstreamUrl = fbUrl;
        activeUpstreamPath = fbPath;
        activeUpstreamBody = Buffer.from(fbBody);
        activeStreamMapper = fbStreamMapper;
        activeMapper = fbMapper;
        passthrough = !activeStreamMapper && !activeMapper;

        trace.providerId = activeProvider;
        trace.upstreamUrl = activeUpstreamUrl;
        trace.modelIdRouted = fallbackModel;
        trace.fallback = {
          triggered: true,
          attempts,
          requestedModel: modelId,
          fallbackModel,
        };

        const codes =
          fbCfg?.onStatusCodes && fbCfg.onStatusCodes.length > 0 ? fbCfg.onStatusCodes : [429, 529];
        if (!codes.includes(fbUpstream.status)) break;
      }
    }

    // --- Write response (mapped or passthrough) ---
    if (activeStreamMapper) {
      trace.status = upstream.ok ? 200 : upstream.status;
      await activeStreamMapper(upstream, res);
    } else if (activeMapper) {
      const mapped = await activeMapper(upstream);
      trace.status = mapped.status;
      res.writeHead(mapped.status, mapped.headers);
      res.end(mapped.body);
    } else if (passthrough) {
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

    if (reserved && trace.status !== undefined && trace.status >= 200 && trace.status < 300) {
      await budgetTracker.commit(estimatedInputTokens, estimatedOutputTokens);
    }
  } catch (err) {
    if (reserved) {
      await budgetTracker.rollback(estimatedInputTokens, estimatedOutputTokens);
    }

    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }

    throw err;
  }
}

export const __test__proxyRequest = proxyRequest;
