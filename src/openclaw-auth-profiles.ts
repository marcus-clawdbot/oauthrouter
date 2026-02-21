import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";

export type OpenClawAuthProfileCredential =
  | { type: "token"; provider: string; token: string }
  | { type: "api_key"; provider: string; key?: string; apiKey?: string }
  | {
      type: "oauth";
      provider: string;
      access?: string;
      refresh?: string;
      /** Epoch millis when the access token expires. */
      expiresAt?: number;
    };

export type OpenClawAuthProfileStore = {
  version?: number;
  profiles: Record<string, OpenClawAuthProfileCredential>;
  order?: Record<string, string[]>;
  lastGood?: Record<string, string>;
};

export function getDefaultOpenClawAgentAuthStorePath(params?: {
  agentId?: string;
  openclawDir?: string;
}): string {
  const openclawDir = params?.openclawDir ?? join(homedir(), ".openclaw");
  const agentId = params?.agentId ?? "main";
  return join(openclawDir, "agents", agentId, "agent", "auth-profiles.json");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function coerceCredential(value: unknown): OpenClawAuthProfileCredential | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!isNonEmptyString(v.type) || !isNonEmptyString(v.provider)) return null;

  if (v.type === "token") {
    if (!isNonEmptyString(v.token)) return null;
    return { type: "token", provider: String(v.provider), token: String(v.token) };
  }

  if (v.type === "api_key") {
    const key = isNonEmptyString(v.key) ? String(v.key) : undefined;
    const apiKey = isNonEmptyString(v.apiKey) ? String(v.apiKey) : undefined;
    if (!key && !apiKey) return null;
    return { type: "api_key", provider: String(v.provider), key, apiKey };
  }

  if (v.type === "oauth") {
    const access = isNonEmptyString(v.access) ? String(v.access) : undefined;
    const refresh = isNonEmptyString(v.refresh) ? String(v.refresh) : undefined;

    const rawExpires = v.expiresAt ?? v.expires;
    const expiresAt =
      typeof rawExpires === "number" && Number.isFinite(rawExpires) ? rawExpires : undefined;

    return { type: "oauth", provider: String(v.provider), access, refresh, expiresAt };
  }

  return null;
}

/**
 * Parse OpenClaw's per-agent auth-profiles.json.
 *
 * Supports both:
 *  - current format: { version, profiles, order?, lastGood? }
 *  - legacy format: { "provider:profile": { type, provider, ... }, ... }
 */
export function parseOpenClawAuthProfileStoreJson(jsonText: string): OpenClawAuthProfileStore {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    throw new Error("Invalid JSON in auth-profiles.json");
  }

  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid auth-profiles.json: expected an object");
  }

  const record = raw as Record<string, unknown>;

  if (record.profiles && typeof record.profiles === "object") {
    const profiles: Record<string, OpenClawAuthProfileCredential> = {};
    for (const [profileId, value] of Object.entries(record.profiles as Record<string, unknown>)) {
      const cred = coerceCredential(value);
      if (!cred) continue;
      profiles[profileId] = cred;
    }

    const store: OpenClawAuthProfileStore = { profiles };

    if (typeof record.version === "number") store.version = record.version;

    if (record.order && typeof record.order === "object") {
      const order: Record<string, string[]> = {};
      for (const [provider, value] of Object.entries(record.order as Record<string, unknown>)) {
        if (!Array.isArray(value)) continue;
        const list = value
          .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
          .filter(Boolean);
        if (list.length > 0) order[provider] = list;
      }
      if (Object.keys(order).length > 0) store.order = order;
    }

    if (record.lastGood && typeof record.lastGood === "object") {
      const lastGood: Record<string, string> = {};
      for (const [provider, value] of Object.entries(record.lastGood as Record<string, unknown>)) {
        if (typeof value === "string" && value.trim()) lastGood[provider] = value.trim();
      }
      if (Object.keys(lastGood).length > 0) store.lastGood = lastGood;
    }

    return store;
  }

  // Legacy format
  const profiles: Record<string, OpenClawAuthProfileCredential> = {};
  for (const [profileId, value] of Object.entries(record)) {
    const cred = coerceCredential(value);
    if (!cred) continue;
    profiles[profileId] = cred;
  }

  if (Object.keys(profiles).length === 0) {
    throw new Error("Invalid auth-profiles.json: no profiles found");
  }

  return { profiles };
}

export function resolveBestProfileIdForProvider(
  store: OpenClawAuthProfileStore,
  provider: string,
): string | null {
  const lastGood = store.lastGood?.[provider];
  if (lastGood && store.profiles[lastGood]?.provider === provider) return lastGood;

  const ordered = store.order?.[provider];
  if (Array.isArray(ordered)) {
    for (const id of ordered) {
      if (store.profiles[id]?.provider === provider) return id;
    }
  }

  for (const [id, cred] of Object.entries(store.profiles)) {
    if (cred.provider === provider) return id;
  }

  return null;
}

export function resolveBearerTokenForProvider(
  store: OpenClawAuthProfileStore,
  provider: string,
): { profileId: string; token: string } {
  const profileId = resolveBestProfileIdForProvider(store, provider);
  if (!profileId) throw new Error(`No auth profile found for provider "${provider}"`);

  const cred = store.profiles[profileId];
  if (!cred) throw new Error(`Auth profile "${profileId}" not found`);

  if (cred.type === "token") {
    const token = cred.token.trim();
    if (!token) throw new Error(`Auth profile "${profileId}" has empty token`);
    return { profileId, token };
  }

  if (cred.type === "api_key") {
    const token = (cred.apiKey ?? cred.key ?? "").trim();
    if (!token) throw new Error(`Auth profile "${profileId}" has empty api key`);
    return { profileId, token };
  }

  if (cred.type === "oauth") {
    const token = (cred.access ?? "").trim();
    if (!token) throw new Error(`Auth profile "${profileId}" has empty oauth access token`);
    return { profileId, token };
  }

  throw new Error(`Auth profile "${profileId}" for provider "${provider}" is not a token`);
}

/**
 * Read ~/.openclaw/agents/main/agent/auth-profiles.json and return the Anthropic Authorization header.
 *
 * Never logs secrets.
 */
export function getAnthropicAuthHeader(params?: { authStorePath?: string }): {
  Authorization: string;
} {
  const authStorePath = params?.authStorePath ?? getDefaultOpenClawAgentAuthStorePath();
  const jsonText = readFileSync(authStorePath, "utf-8");
  const store = parseOpenClawAuthProfileStoreJson(jsonText);
  const { token } = resolveBearerTokenForProvider(store, "anthropic");
  return { Authorization: `Bearer ${token}` };
}

/** Anthropic's HTTP API typically expects an api key via `x-api-key`. */
export function getAnthropicApiKeyHeader(params?: { authStorePath?: string }): {
  "x-api-key": string;
} {
  const authStorePath = params?.authStorePath ?? getDefaultOpenClawAgentAuthStorePath();
  const jsonText = readFileSync(authStorePath, "utf-8");
  const store = parseOpenClawAuthProfileStoreJson(jsonText);
  const { token } = resolveBearerTokenForProvider(store, "anthropic");
  return { "x-api-key": token };
}

export function getOpenAiAuthHeader(params?: { authStorePath?: string }): {
  Authorization: string;
} {
  const authStorePath = params?.authStorePath ?? getDefaultOpenClawAgentAuthStorePath();
  const jsonText = readFileSync(authStorePath, "utf-8");
  const store = parseOpenClawAuthProfileStoreJson(jsonText);
  const { token } = resolveBearerTokenForProvider(store, "openai");
  return { Authorization: `Bearer ${token}` };
}

function safeJsonStringify(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type OpenAICodexAuthHeaderResult = {
  Authorization: string;
  profileId: string;
  refreshed: boolean;
};

function shouldRefreshOAuthAccessToken(params: {
  access?: string;
  expiresAt?: number;
  nowMs: number;
  /** Refresh a bit early to avoid edge-of-expiry failures. */
  skewMs?: number;
}): boolean {
  const skewMs = params.skewMs ?? 60_000;
  if (!params.access || !params.access.trim()) return true;
  if (!params.expiresAt || !Number.isFinite(params.expiresAt)) return false;
  return params.expiresAt <= params.nowMs + skewMs;
}

async function refreshOpenAICodexAccessToken(params: {
  refreshToken: string;
  fetchImpl: FetchLike;
  nowMs: number;
}): Promise<{ access: string; refresh?: string; expiresAt?: number }> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
    client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
  });

  const res = await params.fetchImpl("https://auth.openai.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenAI token refresh failed (${res.status}): ${text}`);
  }

  const json = (await res.json()) as Record<string, unknown>;
  const access = typeof json.access_token === "string" ? json.access_token : "";
  const refresh = typeof json.refresh_token === "string" ? json.refresh_token : undefined;
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : undefined;

  if (!access.trim()) throw new Error("OpenAI token refresh response missing access_token");

  const expiresAt =
    typeof expiresIn === "number" && Number.isFinite(expiresIn)
      ? params.nowMs + Math.max(0, expiresIn) * 1000
      : undefined;

  return { access, refresh, expiresAt };
}

/**
 * Read OpenClaw auth-profiles.json and return an Authorization header for OpenAI Codex.
 *
 * For openai-codex oauth profiles, refreshes access tokens under a file lock using proper-lockfile.
 */
export async function getOpenAICodexAuthHeader(params?: {
  authStorePath?: string;
  fetchImpl?: FetchLike;
  nowMs?: number;
}): Promise<OpenAICodexAuthHeaderResult> {
  const authStorePath = params?.authStorePath ?? getDefaultOpenClawAgentAuthStorePath();
  const fetchImpl: FetchLike = params?.fetchImpl ?? fetch;
  const nowMs = params?.nowMs ?? Date.now();

  const release = await lockfile.lock(authStorePath, {
    retries: { retries: 8, factor: 1.25, minTimeout: 25, maxTimeout: 250 },
    stale: 10_000,
  });

  try {
    const jsonText = readFileSync(authStorePath, "utf-8");

    // Parse twice: once for typed resolution, once as raw so we can safely write back updates.
    const store = parseOpenClawAuthProfileStoreJson(jsonText);
    const profileId = resolveBestProfileIdForProvider(store, "openai-codex");
    if (!profileId) throw new Error('No auth profile found for provider "openai-codex"');

    const raw = JSON.parse(jsonText) as Record<string, unknown>;
    const rawProfiles =
      raw && typeof raw === "object" && raw.profiles && typeof raw.profiles === "object"
        ? (raw.profiles as Record<string, unknown>)
        : (raw as Record<string, unknown>);

    const cred = store.profiles[profileId];
    if (!cred) throw new Error(`Auth profile "${profileId}" not found`);
    if (cred.type !== "oauth") {
      throw new Error(`Auth profile "${profileId}" for provider "openai-codex" is not oauth`);
    }

    const needsRefresh = shouldRefreshOAuthAccessToken({
      access: cred.access,
      expiresAt: cred.expiresAt,
      nowMs,
    });

    if (needsRefresh) {
      const refreshToken = (cred.refresh ?? "").trim();
      if (!refreshToken) {
        throw new Error(`Auth profile "${profileId}" missing oauth refresh token`);
      }

      const refreshed = await refreshOpenAICodexAccessToken({
        refreshToken,
        fetchImpl,
        nowMs,
      });

      const rawEntry = rawProfiles[profileId];
      if (!rawEntry || typeof rawEntry !== "object") {
        throw new Error(`Auth profile "${profileId}" not found in raw store`);
      }

      const entry = rawEntry as Record<string, unknown>;
      entry.access = refreshed.access;
      if (refreshed.refresh) entry.refresh = refreshed.refresh;
      if (refreshed.expiresAt) entry.expiresAt = refreshed.expiresAt;

      writeFileSync(authStorePath, safeJsonStringify(raw), "utf-8");

      return {
        Authorization: `Bearer ${refreshed.access}`,
        profileId,
        refreshed: true,
      };
    }

    const token = (cred.access ?? "").trim();
    if (!token) throw new Error(`Auth profile "${profileId}" has empty oauth access token`);

    return { Authorization: `Bearer ${token}`, profileId, refreshed: false };
  } finally {
    await release();
  }
}
