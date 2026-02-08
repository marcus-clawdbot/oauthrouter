import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type OpenClawAuthProfileCredential =
  | { type: "token"; provider: string; token: string }
  | { type: "api_key"; provider: string; key?: string; apiKey?: string }
  | { type: "oauth"; provider: string; access?: string };

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
    return { type: "oauth", provider: String(v.provider), access };
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
