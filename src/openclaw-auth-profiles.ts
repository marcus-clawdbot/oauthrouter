import { readFileSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as lockfile from "proper-lockfile";

/**
 * OpenClaw auth-profiles.json
 *
 * Current format:
 * {
 *   version: 1,
 *   profiles: {
 *     "provider:profileId": { type, provider, ... }
 *   },
 *   order?: { [provider]: ["provider:profileId", ...] },
 *   lastGood?: { [provider]: "provider:profileId" }
 * }
 *
 * Legacy format (import-only):
 * { "provider:profileId": { type, provider, ... }, ... }
 */

export type OpenClawAuthProfileCredential =
  | {
      type: "token";
      provider: string;
      token: string;
      [key: string]: unknown;
    }
  | {
      type: "api_key";
      provider: string;
      /** Some stores use `key`, others use `apiKey`. */
      key?: string;
      apiKey?: string;
      [key: string]: unknown;
    }
  | {
      type: "oauth";
      provider: string;
      /** OAuth access token (JWT for OpenAI Codex). */
      access?: string;
      /** OAuth refresh token. */
      refresh?: string;
      /** Expiry timestamp (ms since epoch). */
      expires?: number;
      /** ChatGPT account id (OpenAI Codex). */
      accountId?: string;
      [key: string]: unknown;
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
    return {
      ...(v as any),
      type: "token",
      provider: String(v.provider),
      token: String(v.token),
    };
  }

  if (v.type === "api_key") {
    const key = isNonEmptyString(v.key) ? String(v.key) : undefined;
    const apiKey = isNonEmptyString(v.apiKey) ? String(v.apiKey) : undefined;
    if (!key && !apiKey) return null;
    return {
      ...(v as any),
      type: "api_key",
      provider: String(v.provider),
      key,
      apiKey,
    };
  }

  if (v.type === "oauth") {
    const access = isNonEmptyString(v.access) ? String(v.access) : undefined;
    const refresh = isNonEmptyString(v.refresh) ? String(v.refresh) : undefined;
    const expires = typeof v.expires === "number" ? v.expires : undefined;
    const accountId = isNonEmptyString(v.accountId) ? String(v.accountId) : undefined;

    return {
      ...(v as any),
      type: "oauth",
      provider: String(v.provider),
      access,
      refresh,
      expires,
      accountId,
    };
  }

  return null;
}

/**
 * Parse the OpenClaw auth-profiles.json file.
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

  // Current store format
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
      for (const [provider, value] of Object.entries(
        record.lastGood as Record<string, unknown>,
      )) {
        if (typeof value === "string" && value.trim()) lastGood[provider] = value.trim();
      }
      if (Object.keys(lastGood).length > 0) store.lastGood = lastGood;
    }

    return store;
  }

  // Legacy store format
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
  if (lastGood && store.profiles[lastGood]?.provider === provider) {
    return lastGood;
  }

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
  if (!profileId) throw new Error(`No auth profile found for provider \"${provider}\"`);

  const cred = store.profiles[profileId];
  if (!cred) throw new Error(`Auth profile \"${profileId}\" not found`);

  if (cred.type === "token") {
    const token = cred.token.trim();
    if (!token) throw new Error(`Auth profile \"${profileId}\" has empty token`);
    return { profileId, token };
  }

  if (cred.type === "api_key") {
    const token = (cred.apiKey ?? cred.key ?? "").trim();
    if (!token) throw new Error(`Auth profile \"${profileId}\" has empty api key`);
    return { profileId, token };
  }

  if (cred.type === "oauth") {
    const token = (cred.access ?? "").trim();
    if (!token) throw new Error(`Auth profile \"${profileId}\" has empty oauth access token`);
    return { profileId, token };
  }

  throw new Error(
    `Auth profile \"${profileId}\" for provider \"${provider}\" is not a bearer token (type=${(cred as any).type})`,
  );
}

/**
 * Read auth-profiles.json and return the Anthropic Authorization header.
 *
 * Never logs secrets.
 */
export function getAnthropicAuthHeader(params?: {
  authStorePath?: string;
}): { Authorization: string } {
  const authStorePath = params?.authStorePath ?? getDefaultOpenClawAgentAuthStorePath();
  const jsonText = readFileSync(authStorePath, "utf-8");
  const store = parseOpenClawAuthProfileStoreJson(jsonText);
  const { token } = resolveBearerTokenForProvider(store, "anthropic");
  return { Authorization: `Bearer ${token}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI Codex OAuth (refresh + persistence)
// ─────────────────────────────────────────────────────────────────────────────

const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
const OPENAI_CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

export type OpenAICodexOAuthProfile = {
  type: "oauth";
  provider: "openai-codex";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  [key: string]: unknown;
};

export type OpenAICodexAccessTokenInfo = {
  profileId: string;
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
};

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1];
    if (!payload) return null;
    const text = Buffer.from(payload, "base64url").toString("utf8");
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function extractOpenAICodexAccountId(accessToken: string): string | null {
  const payload = decodeJwtPayload(accessToken);
  const auth = payload?.[JWT_CLAIM_PATH];
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return null;
  const accountId = (auth as any).chatgpt_account_id;
  return typeof accountId === "string" && accountId.trim().length > 0 ? accountId.trim() : null;
}

function coerceOpenAICodexOAuthProfile(
  cred: OpenClawAuthProfileCredential,
): OpenAICodexOAuthProfile | null {
  if (cred.type !== "oauth" || cred.provider !== OPENAI_CODEX_PROVIDER_ID) return null;
  const access = typeof cred.access === "string" ? cred.access : null;
  const refresh = typeof cred.refresh === "string" ? cred.refresh : null;
  const expires = typeof cred.expires === "number" ? cred.expires : null;
  if (!access || !refresh || !expires) return null;
  return cred as unknown as OpenAICodexOAuthProfile;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const dir = dirname(path);
  const tmp = join(dir, `.auth-profiles.json.tmp.${process.pid}.${Date.now()}`);
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, path);
}

async function withAuthProfilesLock<T>(authStorePath: string, fn: () => Promise<T>): Promise<T> {
  const release = await lockfile.lock(authStorePath, {
    retries: { retries: 20, factor: 1.25, minTimeout: 25, maxTimeout: 500, randomize: true },
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}

async function refreshOpenAICodexToken(params: {
  refreshToken: string;
  fetchImpl: typeof fetch;
  now: () => number;
}): Promise<{ access: string; refresh: string; expires: number; accountId: string }> {
  const response = await params.fetchImpl(OPENAI_CODEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: params.refreshToken,
      client_id: OPENAI_CODEX_OAUTH_CLIENT_ID,
    }),
  });

  if (!response.ok) {
    // Do not include response text; keep errors non-sensitive.
    throw new Error(`OpenAI Codex OAuth refresh failed (HTTP ${response.status})`);
  }

  const json = (await response.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  };

  const access = typeof json.access_token === "string" ? json.access_token : null;
  const refresh = typeof json.refresh_token === "string" ? json.refresh_token : null;
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : null;

  if (!access || !refresh || !expiresIn) {
    throw new Error("OpenAI Codex OAuth refresh response missing fields");
  }

  const accountId = extractOpenAICodexAccountId(access);
  if (!accountId) {
    throw new Error("Failed to extract accountId from refreshed OpenAI Codex access token");
  }

  return {
    access,
    refresh,
    expires: params.now() + expiresIn * 1000,
    accountId,
  };
}

/**
 * Return a valid OpenAI Codex OAuth access token from auth-profiles.json,
 * refreshing (and persisting rotated tokens) if expired.
 */
export async function getValidOpenAICodexAccessToken(params?: {
  authStorePath?: string;
  profileId?: string;
  refreshLeewayMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<OpenAICodexAccessTokenInfo> {
  const authStorePath = params?.authStorePath ?? getDefaultOpenClawAgentAuthStorePath();
  const fetchImpl = params?.fetchImpl ?? fetch;
  const now = params?.now ?? (() => Date.now());
  const refreshLeewayMs = params?.refreshLeewayMs ?? 60_000;

  return withAuthProfilesLock(authStorePath, async () => {
    const jsonText = await readFile(authStorePath, "utf8");

    // Preserve all fields on write by editing the raw object.
    const raw = JSON.parse(jsonText) as any;
    const store = parseOpenClawAuthProfileStoreJson(jsonText);

    const profileId =
      params?.profileId ?? resolveBestProfileIdForProvider(store, OPENAI_CODEX_PROVIDER_ID) ??
      `${OPENAI_CODEX_PROVIDER_ID}:default`;

    const cred = store.profiles[profileId];
    if (!cred) {
      throw new Error(`OpenAI Codex profile \"${profileId}\" not found in auth-profiles.json`);
    }

    const oauth = coerceOpenAICodexOAuthProfile(cred);
    if (!oauth) {
      throw new Error(
        `OpenAI Codex profile \"${profileId}\" is not a valid oauth credential (expected access/refresh/expires)`,
      );
    }

    const isValid = oauth.expires > now() + refreshLeewayMs;

    if (isValid) {
      const accountId = oauth.accountId ?? extractOpenAICodexAccountId(oauth.access);
      if (!accountId) {
        throw new Error("OpenAI Codex access token is missing accountId and it could not be extracted");
      }

      return {
        profileId,
        access: oauth.access,
        refresh: oauth.refresh,
        expires: oauth.expires,
        accountId,
      };
    }

    const refreshed = await refreshOpenAICodexToken({
      refreshToken: oauth.refresh,
      fetchImpl,
      now,
    });

    const nextCred: OpenAICodexOAuthProfile = {
      ...oauth,
      access: refreshed.access,
      refresh: refreshed.refresh,
      expires: refreshed.expires,
      accountId: refreshed.accountId,
    };

    // Update raw (current format or legacy format).
    if (raw && typeof raw === "object" && raw.profiles && typeof raw.profiles === "object") {
      raw.profiles[profileId] = { ...(raw.profiles[profileId] ?? {}), ...nextCred };
    } else if (raw && typeof raw === "object") {
      raw[profileId] = { ...(raw[profileId] ?? {}), ...nextCred };
    }

    await writeJsonAtomic(authStorePath, raw);

    return {
      profileId,
      access: refreshed.access,
      refresh: refreshed.refresh,
      expires: refreshed.expires,
      accountId: refreshed.accountId,
    };
  });
}
