/**
 * Provider wiring (STUB)
 *
 * ClawRouter registered a "blockrun" provider backed by a local x402 proxy.
 * oauthrouter intentionally disables that provider/payment wiring during re-scaffold.
 */

import type { ProviderPlugin } from "./types.js";
import type { ProxyHandle } from "./proxy.js";

let activeProxy: ProxyHandle | null = null;

/** Legacy helper retained for compatibility with older code paths. */
export function setActiveProxy(proxy: ProxyHandle): void {
  activeProxy = proxy;
}

export function getActiveProxy(): ProxyHandle | null {
  return activeProxy;
}

/**
 * oauthrouter provider stub.
 *
 * This is not currently registered by the plugin entrypoint.
 */
export const oauthrouterProvider: ProviderPlugin = {
  id: "oauthrouter",
  label: "OAuthRouter",
  docsPath: "https://github.com/marcus-clawdbot/oauthrouter",
  aliases: ["or"],
  auth: [],
};

/**
 * Legacy export name retained temporarily to reduce churn during re-scaffold.
 * Do not register this provider in oauthrouter.
 */
export const blockrunProvider = oauthrouterProvider;
