/**
 * Local proxy server (DISABLED)
 *
 * This repository was cloned from ClawRouter, which provided a local HTTP proxy
 * that handled BlockRun's x402 micropayments.
 *
 * For oauthrouter, that payment/wallet flow is intentionally disabled.
 * This file keeps a minimal stub API so downstream imports/types can compile
 * while new OAuth-based routing/provider work is implemented.
 */

export type LowBalanceInfo = {
  walletAddress: string;
  balanceUSD: string;
};

export type InsufficientFundsInfo = {
  walletAddress: string;
  balanceUSD: string;
  requiredUSD: string;
};

export type ProxyOptions = {
  /** Legacy option (ClawRouter): wallet private key for x402 signing. */
  walletKey?: string;
  /** Optional routing overrides (kept for future use). */
  routingConfig?: unknown;
  onReady?: (port: number) => void;
  onError?: (error: Error) => void;
  onRouted?: (decision: unknown) => void;
  onLowBalance?: (info: LowBalanceInfo) => void;
  onInsufficientFunds?: (info: InsufficientFundsInfo) => void;
};

export type ProxyHandle = {
  baseUrl: string;
  close: () => Promise<void>;
};

/**
 * Start the legacy x402 proxy.
 *
 * Disabled in oauthrouter. This will throw until the new proxy/provider design
 * is implemented.
 */
export async function startProxy(_options: ProxyOptions): Promise<ProxyHandle> {
  throw new Error(
    "oauthrouter: startProxy() is disabled (legacy x402/wallet proxy removed during re-scaffold)",
  );
}
