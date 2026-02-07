/**
 * @marcus-clawdbot/oauthrouter
 *
 * OAuthRouter for OpenClaw.
 *
 * NOTE: This repository was cloned from ClawRouter and is being re-scaffolded.
 * The original x402 / wallet-payment proxy and BlockRun provider wiring are
 * intentionally disabled here (stubs remain in src/ for now).
 */

import type { OpenClawPluginDefinition, OpenClawPluginApi } from "./types.js";
import { VERSION } from "./version.js";

/**
 * Detect if we're running in shell completion mode.
 * When `openclaw completion --shell zsh` runs, it loads plugins but only needs
 * the completion script output - any stdout logging pollutes the script.
 */
function isCompletionMode(): boolean {
  const args = process.argv;
  return args.some((arg, i) => arg === "completion" && i >= 1 && i <= 3);
}

const plugin: OpenClawPluginDefinition = {
  id: "oauthrouter",
  name: "OAuthRouter",
  description: "OAuth-based routing scaffold for OpenClaw (payments/provider wiring disabled)",
  version: VERSION,

  register(api: OpenClawPluginApi) {
    // Avoid side effects/logging during shell completion.
    if (isCompletionMode()) return;

    // Scaffold only: no provider registration, no proxy startup.
    api.logger.info("OAuthRouter loaded (scaffold). No providers registered yet.");
  },
};

export default plugin;

// Keep the local routing engine available for programmatic use.
export { route, DEFAULT_ROUTING_CONFIG } from "./router/index.js";
export type { RoutingDecision, RoutingConfig, Tier } from "./router/index.js";
