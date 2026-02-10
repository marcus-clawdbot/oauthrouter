import type { ProviderTier } from "./provider-health.js";
import type { ProviderId } from "./model-registry.js";

/**
 * Single source of truth for fallback model ids.
 *
 * This is used by:
 * - provider cooldown pre-routing (health-based "preRoute")
 * - rate-limit fallback (429) chain in the OpenClaw runner script
 * - canonical model ids for background probes
 * - auto-routing fallback lists (keep consistent across modules)
 */

export const FALLBACK_MODELS = {
  anthropic: {
    SIMPLE: "anthropic/claude-haiku-4-5",
    MEDIUM: "anthropic/claude-sonnet-4-5",
    COMPLEX: "anthropic/claude-opus-4-6",
    REASONING: "anthropic/claude-opus-4-6",
  },
  "openai-codex": {
    // SIMPLE/Haiku should fall back to the mini Codex model.
    SIMPLE: "openai-codex/gpt-5.1-codex-mini",
    MEDIUM: "openai-codex/gpt-5.2",
    COMPLEX: "openai-codex/gpt-5.3-codex",
    REASONING: "openai-codex/gpt-5.3-codex",
  },
  deepseek: {
    SIMPLE: "deepseek/deepseek-chat",
    MEDIUM: "deepseek/deepseek-chat",
    COMPLEX: "deepseek/deepseek-reasoner",
    REASONING: "deepseek/deepseek-reasoner",
  },
} as const;

export function canonicalModelForProviderTier(
  provider: ProviderId,
  tier: ProviderTier,
): string | null {
  if (tier === "UNKNOWN") return null;
  const table = (FALLBACK_MODELS as any)[provider] as
    | Record<Exclude<ProviderTier, "UNKNOWN">, string>
    | undefined;
  return table ? (table[tier as Exclude<ProviderTier, "UNKNOWN">] ?? null) : null;
}

/**
 * Default mapping from Anthropic family models to Codex models in a fallback hop.
 * Keys must be router model ids (e.g. "anthropic/claude-haiku-4-5").
 */
export const ANTHROPIC_TO_CODEX_FALLBACK_MODEL_MAP: Record<string, string> = {
  "anthropic/claude-haiku-4-5": FALLBACK_MODELS["openai-codex"].SIMPLE,
  "anthropic/claude-sonnet-4-5": FALLBACK_MODELS["openai-codex"].SIMPLE,
  "anthropic/claude-opus-4-6": FALLBACK_MODELS["openai-codex"].COMPLEX,
  "anthropic/claude-opus-4-5": FALLBACK_MODELS["openai-codex"].COMPLEX,
};

export const ANTHROPIC_TO_DEEPSEEK_FALLBACK_MODEL_MAP: Record<string, string> = {
  "anthropic/claude-haiku-4-5": FALLBACK_MODELS.deepseek.MEDIUM,
  "anthropic/claude-sonnet-4-5": FALLBACK_MODELS.deepseek.MEDIUM,
  "anthropic/claude-opus-4-6": FALLBACK_MODELS.deepseek.REASONING,
  "anthropic/claude-opus-4-5": FALLBACK_MODELS.deepseek.REASONING,
};

export function buildDefaultRateLimitFallbackChain(hasDeepSeek: boolean): Array<{
  provider: ProviderId;
  modelMap?: Record<string, string>;
  defaultModel?: string;
}> {
  return [
    {
      provider: "openai-codex",
      modelMap: ANTHROPIC_TO_CODEX_FALLBACK_MODEL_MAP,
      defaultModel: FALLBACK_MODELS["openai-codex"].SIMPLE,
    },
    ...(hasDeepSeek
      ? [
          {
            provider: "deepseek" as const,
            modelMap: ANTHROPIC_TO_DEEPSEEK_FALLBACK_MODEL_MAP,
            defaultModel: FALLBACK_MODELS.deepseek.MEDIUM,
          },
        ]
      : []),
  ];
}
