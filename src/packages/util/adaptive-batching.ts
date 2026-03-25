/*
Adaptive batching for async sinks that can become the bottleneck under load.

Use this when individual events arrive quickly, but flushing each one
independently would overload an async writer such as sqlite, a socket, or a
remote RPC. The batcher keeps a minimum delay floor for low-latency updates,
measures actual flush latency, and backs off toward a larger delay when the
sink slows down. Immediate terminal events can still force a flush, and batch
size / byte limits bound memory growth while the sink catches up.
*/

type AddToAdaptiveBatchOptions = {
  flush?: boolean;
  size?: number;
};

export type AdaptiveAsyncBatcherSnapshot = {
  pendingItems: number;
  pendingBytes: number;
  timerScheduled: boolean;
  flushInFlight: boolean;
  estimatedLatencyMs?: number;
  nextDelayMs: number;
};

export type AdaptiveAsyncBatcherFlushStats = {
  batchSize: number;
  batchBytes: number;
  durationMs: number;
  scheduledDelayMs: number;
  estimatedLatencyMs?: number;
  nextDelayMs: number;
};

export type AdaptiveAsyncBatcher<T> = {
  add(item: T, options?: AddToAdaptiveBatchOptions): void;
  flush(): Promise<void>;
  close(): Promise<void>;
  snapshot(): AdaptiveAsyncBatcherSnapshot;
};

export function createAdaptiveAsyncBatcher<T>({
  minDelayMs,
  maxDelayMs,
  initialDelayMs = minDelayMs,
  ewmaAlpha = 0.25,
  latencyMultiplier = 2,
  maxItems = Number.POSITIVE_INFINITY,
  maxBytes = Number.POSITIVE_INFINITY,
  estimateSize,
  flush,
  onFlushComplete,
  now = Date.now,
}: {
  minDelayMs: number;
  maxDelayMs: number;
  initialDelayMs?: number;
  ewmaAlpha?: number;
  latencyMultiplier?: number;
  maxItems?: number;
  maxBytes?: number;
  estimateSize?: (item: T) => number;
  flush: (items: T[]) => Promise<void>;
  onFlushComplete?: (stats: AdaptiveAsyncBatcherFlushStats) => void;
  now?: () => number;
}): AdaptiveAsyncBatcher<T> {
  if (!(minDelayMs > 0)) {
    throw new Error("minDelayMs must be positive");
  }
  if (!(maxDelayMs >= minDelayMs)) {
    throw new Error("expected minDelayMs <= maxDelayMs");
  }
  if (!(initialDelayMs >= minDelayMs && initialDelayMs <= maxDelayMs)) {
    throw new Error("expected initialDelayMs to be within the min/max delay");
  }
  if (!(ewmaAlpha > 0 && ewmaAlpha <= 1)) {
    throw new Error("expected ewmaAlpha to satisfy 0 < ewmaAlpha <= 1");
  }
  if (!(latencyMultiplier >= 1)) {
    throw new Error("expected latencyMultiplier >= 1");
  }
  if (!(maxItems >= 1)) {
    throw new Error("expected maxItems >= 1");
  }
  if (!(maxBytes >= 1)) {
    throw new Error("expected maxBytes >= 1");
  }

  let closed = false;
  let estimatedLatencyMs: number | undefined;
  let nextDelayMs = clampDelay(initialDelayMs);
  let batch: T[] = [];
  let batchBytes = 0;
  let timer: NodeJS.Timeout | null = null;
  let scheduledDelayMs = 0;
  let flushChain: Promise<void> = Promise.resolve();
  let flushInFlight = false;

  function clampDelay(value: number): number {
    return Math.min(maxDelayMs, Math.max(minDelayMs, Math.ceil(value)));
  }

  function updateNextDelay(durationMs: number): void {
    estimatedLatencyMs =
      estimatedLatencyMs == null
        ? durationMs
        : estimatedLatencyMs * (1 - ewmaAlpha) + durationMs * ewmaAlpha;
    nextDelayMs = clampDelay(estimatedLatencyMs * latencyMultiplier);
  }

  function clearTimer(): number {
    const delay = scheduledDelayMs;
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    scheduledDelayMs = 0;
    return delay;
  }

  function ensureTimer(): void {
    if (closed || timer != null || batch.length === 0) {
      return;
    }
    scheduledDelayMs = nextDelayMs;
    timer = setTimeout(() => {
      timer = null;
      scheduledDelayMs = 0;
      void flushBuffered();
    }, scheduledDelayMs);
    timer.unref?.();
  }

  async function flushBuffered(): Promise<void> {
    const pendingDelayMs = clearTimer();
    if (batch.length === 0) {
      await flushChain;
      return;
    }
    const items = batch;
    const itemsBytes = batchBytes;
    batch = [];
    batchBytes = 0;

    const continuation = flushChain
      .catch(() => undefined)
      .then(async () => {
        const started = now();
        flushInFlight = true;
        try {
          await flush(items);
        } finally {
          flushInFlight = false;
          const durationMs = Math.max(0, now() - started);
          updateNextDelay(durationMs);
          onFlushComplete?.({
            batchSize: items.length,
            batchBytes: itemsBytes,
            durationMs,
            scheduledDelayMs: pendingDelayMs,
            estimatedLatencyMs,
            nextDelayMs,
          });
        }
      });
    flushChain = continuation;
    await continuation;
  }

  return {
    add(item: T, options?: AddToAdaptiveBatchOptions): void {
      if (closed) return;
      batch.push(item);
      const size = options?.size ?? estimateSize?.(item) ?? 1;
      batchBytes += Math.max(0, size);
      if (
        options?.flush ||
        batch.length >= maxItems ||
        batchBytes >= maxBytes
      ) {
        void flushBuffered();
        return;
      }
      ensureTimer();
    },

    async flush(): Promise<void> {
      await flushBuffered();
    },

    async close(): Promise<void> {
      closed = true;
      await flushBuffered();
    },

    snapshot(): AdaptiveAsyncBatcherSnapshot {
      return {
        pendingItems: batch.length,
        pendingBytes: batchBytes,
        timerScheduled: timer != null,
        flushInFlight,
        estimatedLatencyMs,
        nextDelayMs,
      };
    },
  };
}
