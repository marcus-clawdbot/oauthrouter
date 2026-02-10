/**
 * OAuthRouter (scaffold)
 *
 * Forked from BlockRunAI/ClawRouter.
 * ROUTER-001/002: rebrand + disable all BlockRun/x402 behavior.
 */

import type { OpenClawPluginDefinition, OpenClawPluginApi } from "./types.js";
import { VERSION } from "./version.js";

const plugin: OpenClawPluginDefinition = {
  id: "oauthrouter",
  name: "OAuthRouter",
  description: "Local LLM router scaffold (OAuth-based proxy TBD)",
  version: VERSION,

  register(api: OpenClawPluginApi) {
    void api;
    // Intentionally no provider registration yet.
  },
};

export default plugin;

// Routing engine exports
export { route, DEFAULT_ROUTING_CONFIG, getFallbackChain } from "./router/index.js";
export type { RoutingDecision, RoutingConfig, Tier } from "./router/index.js";

// Proxy export is available for programmatic use (plugin wiring TBD).
export { startProxy } from "./proxy.js";
export type { ProxyOptions, ProxyHandle } from "./proxy.js";
export type { SpendControlsConfig } from "./spend-controls.js";
export {
  FALLBACK_MODELS,
  canonicalModelForProviderTier,
  ANTHROPIC_TO_CODEX_FALLBACK_MODEL_MAP,
  ANTHROPIC_TO_DEEPSEEK_FALLBACK_MODEL_MAP,
  buildDefaultRateLimitFallbackChain,
} from "./fallback-config.js";
export {
  __test__canonicalModelForTier,
  __test__parseBearerToken,
  __test__ensureCommaSeparatedIncludes,
  __test__normalizeAnthropicUpstreamAuthHeaders,
  __test__estimateInputTokensFromBody,
  __test__shouldTriggerRateLimitFallback,
  __test__getRateLimitFallbackChain,
  __test__resolveFallbackModelId,
  __test__proxyRequest,
} from "./proxy.js";

// Internal mappers (exported for unit tests).
export { createCodexSseToChatCompletionsMapper } from "./codex-sse-mapper.js";
export { normalizeDeepSeekChatCompletionsRequest, toDeepSeekModelId } from "./adapters/deepseek.js";
export { ProviderHealthManager, tierFromModelId } from "./provider-health.js";

// Debug / routing trace exports (primarily for tests)
export { RingBuffer, RoutingTraceStore, routingTrace } from "./routing-trace.js";
export type { TraceEvent } from "./routing-trace.js";

// OpenClaw auth-profiles.json helpers
export {
  getAnthropicAuthHeader,
  getAnthropicApiKeyHeader,
  getOpenAiAuthHeader,
  getOpenAICodexAuthHeader,
  getDefaultOpenClawAgentAuthStorePath,
  parseOpenClawAuthProfileStoreJson,
  resolveBestProfileIdForProvider,
  resolveBearerTokenForProvider,
} from "./openclaw-auth-profiles.js";
export type {
  OpenClawAuthProfileStore,
  OpenClawAuthProfileCredential,
  OpenAICodexAuthHeaderResult,
} from "./openclaw-auth-profiles.js";
