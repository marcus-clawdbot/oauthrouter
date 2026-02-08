/**
 * Spend Controls (OAuthRouter)
 *
 * For OAuth-backed providers (Claude Max / GPT Pro style), we can't reliably
 * map to real $ cost. So v0 controls are token/quota based:
 * - Per-request input/output token caps (estimated)
 * - Daily UTC budgets for input/output tokens (estimated)
 * - Daily request cap
 * - Model allow/deny lists
 *
 * Estimation note: input tokens are approximated as ~4 chars/token.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export type SpendControlsConfig = {
  /** Reject if estimated input tokens exceed this number. */
  maxRequestInputTokens?: number;
  /** Reject if estimated output tokens (max_tokens) exceed this number. */
  maxRequestOutputTokens?: number;

  /** Reject once total estimated input tokens for the current UTC day exceeds this number. */
  dailyInputTokenBudget?: number;
  /** Reject once total estimated output tokens for the current UTC day exceeds this number. */
  dailyOutputTokenBudget?: number;
  /** Reject once total requests for the current UTC day exceeds this number. */
  dailyRequestBudget?: number;

  /** If set, only these models are allowed. */
  allowlistModels?: string[];
  /** If set, these models are blocked. */
  denylistModels?: string[];
};

export class SpendLimitError extends Error {
  readonly code: "MODEL_NOT_ALLOWED" | "REQUEST_TOKENS_TOO_HIGH" | "DAILY_BUDGET_EXCEEDED";
  readonly status: number;

  constructor(code: SpendLimitError["code"], message: string, status = 403) {
    super(message);
    this.name = "SpendLimitError";
    this.code = code;
    this.status = status;
  }
}

type BudgetFile = {
  version: 1;
  dateUtc: string;
  inputTokens: number;
  outputTokens: number;
  requests: number;
};

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function normalizeModelId(modelId: string): string {
  const base = modelId
    .trim()
    .toLowerCase()
    .replace(/^oauthrouter\//, "")
    .replace(/^blockrun\//, "");

  // ROUTER-014: Accept Anthropic dotted aliases (e.g. claude-haiku-4.5)
  // as equivalent to dashed Anthropic IDs (claude-haiku-4-5).
  return base.replace(/\b(anthropic\/claude-(?:haiku|sonnet|opus)-4)\.5\b/g, "$1-5");
}

/**
 * Daily budget tracker with simple file-backed persistence.
 * File: ~/.openclaw/oauthrouter/budget.json
 */
export class DailyBudgetTracker {
  private readonly filePath: string;
  private loaded = false;

  private dateUtc: string = todayUtc();
  private inputTokens = 0;
  private outputTokens = 0;
  private requests = 0;

  private reservedInputTokens = 0;
  private reservedOutputTokens = 0;
  private reservedRequests = 0;

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

  private async save(): Promise<void> {
    const dir = join(homedir(), ".openclaw", "oauthrouter");
    await mkdir(dir, { recursive: true });
    const data: BudgetFile = {
      version: 1,
      dateUtc: this.dateUtc,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      requests: this.requests,
    };
    await writeFile(this.filePath, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
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
            this.inputTokens = Number(parsed.inputTokens ?? 0);
            this.outputTokens = Number(parsed.outputTokens ?? 0);
            this.requests = Number(parsed.requests ?? 0);
          } else {
            // new UTC day
            this.dateUtc = current;
            this.inputTokens = 0;
            this.outputTokens = 0;
            this.requests = 0;
            this.reservedInputTokens = 0;
            this.reservedOutputTokens = 0;
            this.reservedRequests = 0;
            await this.save();
          }
        }
      } catch {
        this.dateUtc = current;
        this.inputTokens = 0;
        this.outputTokens = 0;
        this.requests = 0;
        this.reservedInputTokens = 0;
        this.reservedOutputTokens = 0;
        this.reservedRequests = 0;
        await this.save();
      }

      this.loaded = true;
    });
  }

  private async rollDayIfNeeded(): Promise<void> {
    const current = todayUtc();
    if (current === this.dateUtc) return;
    this.dateUtc = current;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.requests = 0;
    this.reservedInputTokens = 0;
    this.reservedOutputTokens = 0;
    this.reservedRequests = 0;
    await this.save();
  }

  async reserve(opts: {
    inputTokens: number;
    outputTokens: number;
    inputLimit?: number;
    outputLimit?: number;
    requestLimit?: number;
  }): Promise<void> {
    await this.ensureLoaded();

    return this.withLock(async () => {
      await this.rollDayIfNeeded();

      const projectedInput = this.inputTokens + this.reservedInputTokens + opts.inputTokens;
      const projectedOutput = this.outputTokens + this.reservedOutputTokens + opts.outputTokens;
      const projectedReq = this.requests + this.reservedRequests + 1;

      if (opts.inputLimit !== undefined && projectedInput > opts.inputLimit) {
        throw new SpendLimitError(
          "DAILY_BUDGET_EXCEEDED",
          `Daily input token budget exceeded. Used=${this.inputTokens}, requested=${opts.inputTokens}, limit=${opts.inputLimit} (UTC day)`,
        );
      }
      if (opts.outputLimit !== undefined && projectedOutput > opts.outputLimit) {
        throw new SpendLimitError(
          "DAILY_BUDGET_EXCEEDED",
          `Daily output token budget exceeded. Used=${this.outputTokens}, requested=${opts.outputTokens}, limit=${opts.outputLimit} (UTC day)`,
        );
      }
      if (opts.requestLimit !== undefined && projectedReq > opts.requestLimit) {
        throw new SpendLimitError(
          "DAILY_BUDGET_EXCEEDED",
          `Daily request budget exceeded. Used=${this.requests}, limit=${opts.requestLimit} (UTC day)`,
        );
      }

      this.reservedInputTokens += opts.inputTokens;
      this.reservedOutputTokens += opts.outputTokens;
      this.reservedRequests += 1;
    });
  }

  async commit(inputTokens: number, outputTokens: number): Promise<void> {
    await this.ensureLoaded();

    return this.withLock(async () => {
      await this.rollDayIfNeeded();

      this.reservedInputTokens = Math.max(0, this.reservedInputTokens - inputTokens);
      this.reservedOutputTokens = Math.max(0, this.reservedOutputTokens - outputTokens);
      this.reservedRequests = Math.max(0, this.reservedRequests - 1);

      this.inputTokens += inputTokens;
      this.outputTokens += outputTokens;
      this.requests += 1;

      await this.save();
    });
  }

  async rollback(inputTokens: number, outputTokens: number): Promise<void> {
    await this.ensureLoaded();

    return this.withLock(async () => {
      this.reservedInputTokens = Math.max(0, this.reservedInputTokens - inputTokens);
      this.reservedOutputTokens = Math.max(0, this.reservedOutputTokens - outputTokens);
      this.reservedRequests = Math.max(0, this.reservedRequests - 1);
    });
  }
}
