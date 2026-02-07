/**
 * Balance monitor (DISABLED)
 *
 * oauthrouter is being re-scaffolded from ClawRouter.
 * The original USDC-on-Base balance monitoring was tied to the x402 wallet flow
 * and has been intentionally disabled.
 *
 * Stubs remain to keep types stable while new OAuth-based provider auth is built.
 */

/** Balance thresholds (legacy; unused in oauthrouter scaffold). */
export const BALANCE_THRESHOLDS = {
  LOW_BALANCE_MICROS: 1_000_000n,
  ZERO_THRESHOLD: 100n,
} as const;

export type BalanceInfo = {
  balance: bigint;
  balanceUSD: string;
  isLow: boolean;
  isEmpty: boolean;
  walletAddress: string;
};

export type SufficiencyResult = {
  sufficient: boolean;
  info: BalanceInfo;
  shortfall?: string;
};

export class BalanceMonitor {
  private readonly walletAddress: string;

  constructor(walletAddress: string) {
    this.walletAddress = walletAddress;
  }

  async checkBalance(): Promise<BalanceInfo> {
    throw new Error(
      "oauthrouter: BalanceMonitor is disabled (legacy ClawRouter wallet/x402 flow removed)",
    );
  }

  async checkSufficient(_estimatedCostMicros: bigint): Promise<SufficiencyResult> {
    throw new Error(
      "oauthrouter: BalanceMonitor is disabled (legacy ClawRouter wallet/x402 flow removed)",
    );
  }

  getWalletAddress(): string {
    return this.walletAddress;
  }

  /**
   * Legacy no-op retained for compatibility with code that did optimistic deduction.
   */
  deductFromCache(_amountMicros: bigint): void {
    // no-op
  }

  /** Legacy no-op retained for compatibility. */
  invalidateCache(): void {
    // no-op
  }
}
