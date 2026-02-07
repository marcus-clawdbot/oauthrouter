/**
 * Legacy BlockRun wallet auth (DISABLED)
 *
 * oauthrouter is being re-scaffolded from ClawRouter.
 * The prior wallet/x402 payment flow has been intentionally removed.
 *
 * Stubs remain so the codebase compiles while OAuth-based auth is implemented.
 */

import type { ProviderAuthMethod, ProviderAuthContext, ProviderAuthResult } from "./types.js";

export async function resolveOrGenerateWalletKey(): Promise<{
  key: string;
  address: string;
  source: "saved" | "env" | "generated";
}> {
  throw new Error(
    "oauthrouter: wallet-based auth is disabled (legacy ClawRouter x402 flow removed)",
  );
}

/** @deprecated Disabled legacy auth method stub. */
export const walletKeyAuth: ProviderAuthMethod = {
  id: "wallet-key",
  label: "Wallet Private Key (disabled)",
  hint: "Disabled: oauthrouter removed the legacy wallet/x402 flow",
  kind: "custom",
  run: async (_ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
    throw new Error(
      "oauthrouter: wallet-key auth is disabled (legacy ClawRouter x402 flow removed)",
    );
  },
};

/** @deprecated Disabled legacy auth method stub. */
export const envKeyAuth: ProviderAuthMethod = {
  id: "env-key",
  label: "Environment Variable (disabled)",
  hint: "Disabled: oauthrouter removed the legacy wallet/x402 flow",
  kind: "custom",
  run: async (_ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
    throw new Error(
      "oauthrouter: env-key auth is disabled (legacy ClawRouter x402 flow removed)",
    );
  },
};
