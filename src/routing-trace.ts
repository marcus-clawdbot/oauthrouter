import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type SpendDecision =
  | { decision: "allowed"; code?: string }
  | { decision: "blocked"; code: string };

export type TraceEvent = {
  ts: number;
  requestId: string;
  path: string;
  method: string;

  // Optional client/session correlation (best-effort).
  sessionKey?: string;

  modelIdRequested?: string;
  modelIdResolved?: string;
  // The final model id that was actually sent upstream (after pre-routing / fallback rewrites).
  // This is what the dashboard should treat as "routed".
  modelIdRouted?: string;
  routingTier?: string;
  routingConfidence?: number;
  routingReasoning?: string;
  providerId?: string;
  upstreamUrl?: string;

  status?: number;
  latencyMs?: number;
  stream?: boolean;

  // Provider-aware fallback metadata (e.g., Anthropic 429 -> DeepSeek).
  fallback?: {
    triggered: boolean;
    attempts?: Array<{
      fromProvider?: string;
      toProvider?: string;
      fromStatus?: number;
      toStatus?: number;
      requestedModel?: string;
      fallbackModel?: string;
    }>;
    requestedModel?: string;
    fallbackModel?: string;
  };

  // Provider health / pre-routing metadata.
  tier?: string;
  preRoute?: {
    triggered: boolean;
    fromProvider?: string;
    toProvider?: string;
    requestedModel?: string;
    routedModel?: string;
    reason?: string;
  };

  toolCount?: number;
  spend?: SpendDecision;
  errorMessage?: string;
};

export class RingBuffer<T> {
  readonly capacity: number;
  private buf: T[] = [];

  constructor(capacity = 500) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  push(value: T): void {
    this.buf.push(value);
    if (this.buf.length > this.capacity) {
      this.buf.splice(0, this.buf.length - this.capacity);
    }
  }

  toArray(): T[] {
    return this.buf.slice();
  }

  tail(n: number): T[] {
    const size = this.buf.length;
    if (!Number.isFinite(n) || n <= 0) return [];
    if (n >= size) return this.toArray();
    return this.buf.slice(size - n);
  }

  get length(): number {
    return this.buf.length;
  }
}

export type RoutingTraceOptions = {
  capacity?: number;
  logPath?: string;
};

type Listener = (evt: TraceEvent) => void;

export class RoutingTraceStore {
  readonly ring: RingBuffer<TraceEvent>;

  private listeners = new Set<Listener>();
  private logPath: string;

  private stream: WriteStream | null = null;
  private pending: string[] = [];
  private flushing = false;
  private ensureReadyPromise: Promise<void> | null = null;

  constructor(options: RoutingTraceOptions = {}) {
    this.ring = new RingBuffer<TraceEvent>(options.capacity ?? 500);
    this.logPath =
      options.logPath ?? join(homedir(), ".openclaw", "oauthrouter", "logs", "routing-trace.jsonl");
  }

  append(evt: TraceEvent): void {
    this.ring.push(evt);

    for (const l of this.listeners) {
      try {
        l(evt);
      } catch {
        // ignore listener errors
      }
    }

    // Serialize early; enqueue for async buffered flush.
    this.pending.push(`${JSON.stringify(evt)}\n`);
    this.flushSoon();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  last(n: number): TraceEvent[] {
    return this.ring.tail(n);
  }

  private flushSoon(): void {
    if (this.flushing) return;
    this.flushing = true;
    setImmediate(() => {
      void this.flush().finally(() => {
        this.flushing = false;
        if (this.pending.length > 0) this.flushSoon();
      });
    });
  }

  private async ensureReady(): Promise<void> {
    if (this.ensureReadyPromise) return this.ensureReadyPromise;

    this.ensureReadyPromise = (async () => {
      await mkdir(join(homedir(), ".openclaw", "oauthrouter", "logs"), { recursive: true });
      this.stream = createWriteStream(this.logPath, { flags: "a" });
      // If the stream errors, we drop file logging but keep in-memory buffer.
      this.stream.on("error", () => {
        try {
          this.stream?.destroy();
        } catch {
          // ignore
        }
        this.stream = null;
      });
    })();

    return this.ensureReadyPromise;
  }

  private async flush(): Promise<void> {
    if (this.pending.length === 0) return;

    await this.ensureReady();
    const stream = this.stream;
    if (!stream) {
      // Drop pending if file logging unavailable.
      this.pending.length = 0;
      return;
    }

    // Drain queue in chunks to avoid huge writes.
    while (this.pending.length > 0 && this.stream === stream) {
      const chunk = this.pending.splice(0, 200).join("");
      const ok = stream.write(chunk);
      if (!ok) {
        await new Promise<void>((resolve) => stream.once("drain", resolve));
      }
    }
  }
}

export const routingTrace = new RoutingTraceStore();
