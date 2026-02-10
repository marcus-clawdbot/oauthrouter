/**
 * Model registry
 *
 * Minimal provider resolution based on router model IDs.
 *
 * ROUTER-007:
 *  - map model IDs -> provider adapter (anthropic/openai)
 *  - enable oauthrouter/auto routing across providers
 *
 * ROUTER-011:
 *  - openai-codex/* models route to chatgpt.com Codex backend.
 */

export type ProviderId = "openai" | "anthropic" | "openai-codex" | "deepseek";

export function resolveProviderForModelId(modelId: string): ProviderId | null {
  const m = modelId.trim();
  if (m.startsWith("openai-codex/")) return "openai-codex";
  if (m.startsWith("openai/")) return "openai";
  if (m.startsWith("anthropic/")) return "anthropic";
  if (m.startsWith("deepseek/")) return "deepseek";
  return null;
}

export function isAutoModelId(modelId: string): boolean {
  const m = modelId.trim();
  return m === "oauthrouter/auto" || m === "auto";
}
