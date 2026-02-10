import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import type { ProviderId } from "./model-registry.js";

// Align with the router's 4-tier complexity taxonomy (see src/router/types.ts).
export type ProviderTier = "SIMPLE" | "MEDIUM" | "COMPLEX" | "REASONING" | "UNKNOWN";

export function tierFromModelId(modelId: string | null | undefined): ProviderTier {
  const m = typeof modelId === "string" ? modelId.toLowerCase() : "";
  if (!m) return "UNKNOWN";

  // DeepSeek
  if (m.includes("deepseek-reasoner") || m.includes("/reasoner")) return "REASONING";
  if (m.includes("deepseek-chat") || m.includes("/deepseek-chat")) return "MEDIUM";

  // Anthropic families
  if (m.includes("haiku")) return "SIMPLE";
  if (m.includes("sonnet")) return "MEDIUM";
  if (m.includes("opus")) return "COMPLEX";

  // Codex subscription models (heuristic)
  if (m.includes("codex-mini") || m.includes("gpt-5.1-codex-mini")) return "SIMPLE";
  if (m.includes("codex-max") || m.includes("gpt-5.1-codex-max")) return "COMPLEX";
  if (m.includes("gpt-5.3")) return "COMPLEX";
  if (m.includes("gpt-5.2")) return "MEDIUM";
  if (m.includes("gpt-5.1")) return "MEDIUM";

  return "UNKNOWN";
}

type ProviderHealthEntry = {
  lastOkTs?: number;
  lastFailTs?: number;
  lastStatus?: number;
  lastLatencyMs?: number;
  consecutiveFailures?: number;
  cooldownUntilTs?: number;
};

type ProviderHealthState = {
  version: 1;
  updatedAt: number;
  tiers: Partial<Record<ProviderTier, Partial<Record<ProviderId, ProviderHealthEntry>>>>;
};

export type ProviderHealthOptions = {
  enabled?: boolean;
  /** Persisted health state path (default: ~/.openclaw/oauthrouter/provider-health.json). */
  persistPath?: string;
  /** If a provider 429s, base cooldown before retrying it. */
  baseCooldownMs?: number;
  /** Cap cooldown to avoid getting stuck. */
  maxCooldownMs?: number;
};

const DEFAULT_STATE_PATH = join(homedir(), ".openclaw", "oauthrouter", "provider-health.json");

export class ProviderHealthManager {
  readonly persistPath: string;
  readonly baseCooldownMs: number;
  readonly maxCooldownMs: number;

  private state: ProviderHealthState;
  private flushScheduled = false;

  constructor(options: ProviderHealthOptions = {}) {
    this.persistPath = options.persistPath ?? DEFAULT_STATE_PATH;
    this.baseCooldownMs = Number.isFinite(options.baseCooldownMs)
      ? (options.baseCooldownMs as number)
      : 2 * 60_000;
    this.maxCooldownMs = Number.isFinite(options.maxCooldownMs)
      ? (options.maxCooldownMs as number)
      : 30 * 60_000;
    this.state = this.loadOrInit();
  }

  getSnapshot(): ProviderHealthState {
    return this.state;
  }

  isInCooldown(provider: ProviderId, tier: ProviderTier, now = Date.now()): boolean {
    const entry = this.state.tiers?.[tier]?.[provider];
    const until = entry?.cooldownUntilTs ?? 0;
    return Boolean(until && until > now);
  }

  recordResult(provider: ProviderId, tier: ProviderTier, status: number, latencyMs?: number): void {
    if (tier === "UNKNOWN") return;
    const now = Date.now();

    const tiers = (this.state.tiers ??= {});
    const tierMap = (tiers[tier] ??= {});
    const entry = (tierMap[provider] ??= {});

    entry.lastStatus = status;
    if (Number.isFinite(latencyMs)) entry.lastLatencyMs = latencyMs;

    if (status >= 200 && status < 300) {
      entry.lastOkTs = now;
      entry.consecutiveFailures = 0;
      entry.cooldownUntilTs = 0;
    } else {
      entry.lastFailTs = now;
      const fails = (entry.consecutiveFailures ?? 0) + 1;
      entry.consecutiveFailures = fails;

      // Cool down aggressively on 429; otherwise keep it short.
      const base = status === 429 ? this.baseCooldownMs : Math.min(30_000, this.baseCooldownMs);
      const cd = Math.min(this.maxCooldownMs, base * Math.pow(2, Math.max(0, fails - 1)));
      entry.cooldownUntilTs = now + cd;
    }

    this.state.updatedAt = now;
    this.flushSoon();
  }

  /**
   * Pick the first provider that is not in cooldown.
   */
  pickHealthyProvider(tier: ProviderTier, candidates: ProviderId[]): ProviderId | null {
    if (tier === "UNKNOWN") return candidates[0] ?? null;
    const now = Date.now();
    for (const p of candidates) {
      if (!this.isInCooldown(p, tier, now)) return p;
    }
    return candidates[0] ?? null;
  }

  private loadOrInit(): ProviderHealthState {
    try {
      const txt = readFileSync(this.persistPath, "utf-8");
      const parsed = JSON.parse(txt) as ProviderHealthState;
      if (parsed && parsed.version === 1 && typeof parsed.updatedAt === "number") {
        // Migrate older tier naming (haiku/sonnet/opus/unknown) to SIMPLE/MEDIUM/COMPLEX/UNKNOWN.
        const tiers: any = parsed.tiers || {};
        const migrated: any = {};

        // Prefer already-migrated keys if present.
        if (tiers.SIMPLE) migrated.SIMPLE = tiers.SIMPLE;
        if (tiers.MEDIUM) migrated.MEDIUM = tiers.MEDIUM;
        if (tiers.COMPLEX) migrated.COMPLEX = tiers.COMPLEX;
        if (tiers.REASONING) migrated.REASONING = tiers.REASONING;
        if (tiers.UNKNOWN) migrated.UNKNOWN = tiers.UNKNOWN;

        // Legacy keys -> new keys (only if missing).
        if (tiers.haiku && !migrated.SIMPLE) migrated.SIMPLE = tiers.haiku;
        if (tiers.sonnet && !migrated.MEDIUM) migrated.MEDIUM = tiers.sonnet;
        if (tiers.opus && !migrated.COMPLEX) migrated.COMPLEX = tiers.opus;
        if (tiers.unknown && !migrated.UNKNOWN) migrated.UNKNOWN = tiers.unknown;

        parsed.tiers = migrated;
        return parsed;
      }
    } catch {
      // ignore
    }

    return { version: 1, updatedAt: Date.now(), tiers: {} };
  }

  private flushSoon(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setTimeout(() => {
      this.flushScheduled = false;
      try {
        this.flush();
      } catch {
        // ignore persistence errors; health is best-effort.
      }
    }, 500);
  }

  private flush(): void {
    const dir = join(this.persistPath, "..");
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // ignore
    }

    const tmp = `${this.persistPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf-8");
    renameSync(tmp, this.persistPath);
  }
}
