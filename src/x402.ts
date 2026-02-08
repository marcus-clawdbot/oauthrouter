/**
 * x402 payment flow (DISABLED)
 *
 * oauthrouter is being re-scaffolded from ClawRouter.
 * The original x402 / wallet-based micropayment implementation has been
 * intentionally removed/disabled.
 *
 * Stubs remain only to keep the codebase compiling while OAuth-based wiring is
 * implemented.
 */

/** Pre-auth parameters for skipping the 402 round trip (legacy API). */
export type PreAuthParams = {
  estimatedAmount: string;
};

/** Result from createPaymentFetch — legacy shape retained for compatibility. */
export type PaymentFetchResult = {
  fetch: (
    input: RequestInfo | URL,
    init?: RequestInit,
    // kept for compatibility; ignored
    preAuth?: PreAuthParams,
  ) => Promise<Response>;
  cache: unknown;
};

/**
 * Legacy API stub.
 *
 * In ClawRouter, this created a fetch() wrapper that handled x402 payment.
 * In oauthrouter, payment signing is disabled; this function throws to fail-closed.
 */
export function createPaymentFetch(privateKey: `0x${string}`): PaymentFetchResult {
  void privateKey;
  throw new Error(
    "oauthrouter: x402 payment fetch is disabled (legacy ClawRouter wallet flow removed)",
  );
}
