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

// OpenClaw auth-profiles.json helpers
export {
  getAnthropicAuthHeader,
  getDefaultOpenClawAgentAuthStorePath,
  parseOpenClawAuthProfileStoreJson,
  resolveBestProfileIdForProvider,
  resolveBearerTokenForProvider,
} from "./openclaw-auth-profiles.js";
export type { OpenClawAuthProfileStore, OpenClawAuthProfileCredential } from "./openclaw-auth-profiles.js";
