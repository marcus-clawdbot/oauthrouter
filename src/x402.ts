/**
 * x402 payment flow (DISABLED)
 *
 * oauthrouter is being re-scaffolded from ClawRouter.
 * The original x402 / wallet-based micropayment implementation has been
 * intentionally removed/disabled.
 *
 * Stubs remain to keep the codebase compiling while new OAuth-based provider
 * wiring is implemented.
 */

import { PaymentCache } from "./payment-cache.js";

/** Pre-auth parameters for skipping the 402 round trip (legacy API). */
export type PreAuthParams = {
  estimatedAmount: string;
};

/** Result from createPaymentFetch — includes the fetch wrapper and a cache handle. */
export type PaymentFetchResult = {
  fetch: (
    input: RequestInfo | URL,
    init?: RequestInit,
    // kept for compatibility; ignored
    preAuth?: PreAuthParams,
  ) => Promise<Response>;
  cache: PaymentCache;
};

/**
 * Legacy API stub.
 *
 * In ClawRouter, this created a fetch() wrapper that handled x402 payment.
 * In oauthrouter, payment signing is disabled; the wrapper just calls fetch().
 */
export function createPaymentFetch(privateKey: `0x${string}`): PaymentFetchResult {
  void privateKey;
  const cache = new PaymentCache();

  return {
    cache,
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      return fetch(input, init);
    },
  };
}
