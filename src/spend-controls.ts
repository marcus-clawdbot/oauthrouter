/**
 * Spend Controls (Budgets / Allowlists)
 *
 * Skeleton implementation:
 * - Per-request max cost (estimated)
 * - Daily budget cap (estimated)
 * - Model allow/deny lists
 *
 * NOTE: Final upstream settlement may differ from the estimate.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export type SpendControlsConfig = {
  /** Reject requests whose estimated cost exceeds this value (USD). */
  maxRequestUsd?: number;
  /** Reject requests once total estimated spend for the current UTC day exceeds this value (USD). */
  dailyBudgetUsd?: number;
  /** If set, only these models are allowed. */
  allowlistModels?: string[];
  /** If set, these models are blocked. */
  denylistModels?: string[];
  /** If true, allow requests when cost cannot be estimated (unknown model). */
  allowUnknownCost?: boolean;
};

export class SpendLimitError extends Error {
  readonly code:
    | "MODEL_NOT_ALLOWED"
    | "REQUEST_COST_TOO_HIGH"
    | "DAILY_BUDGET_EXCEEDED"
    | "COST_ESTIMATE_UNAVAILABLE";
  readonly status: number;

  constructor(
    code: SpendLimitError["code"],
    message: string,
    status = 403,
  ) {
    super(message);
    this.name = "SpendLimitError";
    this.code = code;
    this.status = status;
  }
}

type BudgetFile = {
  version: 1;
  dateUtc: string;
  spentMicros: string;
};

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function usdToMicros(usd: number): bigint {
  if (!Number.isFinite(usd) || usd < 0) throw new Error(`Invalid USD amount: ${usd}`);
  return BigInt(Math.round(usd * 1_000_000));
}

export function microsToUsdString(micros: bigint): string {
  const sign = micros < 0n ? "-" : "";
  const abs = micros < 0n ? -micros : micros;
  const whole = abs / 1_000_000n;
  const frac = abs % 1_000_000n;
  return `${sign}${whole.toString()}.${frac.toString().padStart(6, "0")}`;
}

export function normalizeModelId(modelId: string): string {
  return modelId.trim().toLowerCase().replace(/^oauthrouter\//, "").replace(/^blockrun\//, "");
}

/**
 * Daily budget tracker with simple file-backed persistence.
 *
 * - Date boundary: UTC
 * - File: ~/.openclaw/oauthrouter/budget.json
 */
export class DailyBudgetTracker {
  private readonly filePath: string;
  private loaded = false;

  private dateUtc: string = todayUtc();
  private spentMicros: bigint = 0n;
  private reservedMicros: bigint = 0n;

  private queue: Promise<void> = Promise.resolve();

  constructor(filePath?: string) {
    const dir = join(homedir(), ".openclaw", "oauthrouter");
    this.filePath = filePath ?? join(dir, "budget.json");
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    let resolveNext: () => void;
    const next = new Promise<void>((r) => (resolveNext = r));
    const prev = this.queue;
    this.queue = prev.then(() => next);

    await prev;
    try {
      return await fn();
    } finally {
      resolveNext!();
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;

    await this.withLock(async () => {
      if (this.loaded) return;
      const current = todayUtc();

      try {
        const raw = await readFile(this.filePath, "utf-8");
        const parsed = JSON.parse(raw) as Partial<BudgetFile>;
        if (parsed.version === 1 && typeof parsed.dateUtc === "string") {
          if (parsed.dateUtc === current) {
            this.dateUtc = parsed.dateUtc;
            if (typeof parsed.spentMicros === "string") this.spentMicros = BigInt(parsed.spentMicros);
          } else {
            this.dateUtc = current;
            this.spentMicros = 0n;
            this.reservedMicros = 0n;
            await this.save();
          }
        }
      } catch {
        this.dateUtc = current;
        this.spentMicros = 0n;
        this.reservedMicros = 0n;
        await this.save();
      }

      this.loaded = true;
    });
  }

  private async save(): Promise<void> {
    const dir = join(homedir(), ".openclaw", "oauthrouter");
    await mkdir(dir, { recursive: true });
    const data: BudgetFile = {
      version: 1,
      dateUtc: this.dateUtc,
      spentMicros: this.spentMicros.toString(),
    };
    await writeFile(this.filePath, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  }

  private async rollDayIfNeeded(): Promise<void> {
    const current = todayUtc();
    if (current === this.dateUtc) return;
    this.dateUtc = current;
    this.spentMicros = 0n;
    this.reservedMicros = 0n;
    await this.save();
  }

  async reserve(costMicros: bigint, dailyLimitMicros: bigint): Promise<void> {
    await this.ensureLoaded();

    return this.withLock(async () => {
      await this.rollDayIfNeeded();
      const projected = this.spentMicros + this.reservedMicros + costMicros;
      if (projected > dailyLimitMicros) {
        throw new SpendLimitError(
          "DAILY_BUDGET_EXCEEDED",
          `Daily budget exceeded. Spent: $${microsToUsdString(this.spentMicros)}, ` +
            `Requested: $${microsToUsdString(costMicros)}, ` +
            `Limit: $${microsToUsdString(dailyLimitMicros)} (UTC day)`,
          403,
        );
      }
      this.reservedMicros += costMicros;
    });
  }

  async commit(costMicros: bigint): Promise<void> {
    await this.ensureLoaded();

    return this.withLock(async () => {
      await this.rollDayIfNeeded();
      this.reservedMicros = this.reservedMicros >= costMicros ? this.reservedMicros - costMicros : 0n;
      this.spentMicros += costMicros;
      await this.save();
    });
  }

  async rollback(costMicros: bigint): Promise<void> {
    await this.ensureLoaded();

    return this.withLock(async () => {
      this.reservedMicros = this.reservedMicros >= costMicros ? this.reservedMicros - costMicros : 0n;
    });
  }
}
