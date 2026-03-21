/**
 * RefcountLeaseManager manages reference counts for keyed resources and
 * disposes of them after a configurable delay once the refcount hits zero.
 *
 * Typical uses:
 * - Mounting/unmounting shared overlayfs root filesystems for projects.
 * - Keeping syncdb/docs loaded in memory while multiple clients use them.
 *
 * - acquire(key) bumps the refcount and returns an async release() function.
 * - release() decrements the refcount; when it reaches zero a disposer is
 *   scheduled after delayMs unless a new acquire happens first.
 * - release({ immediate: true }) disposes immediately when the refcount hits
 *   zero instead of scheduling delayed cleanup.
 * - All operations are serialized per key to avoid races.
 */
export class RefcountLeaseManager<K> {
  private readonly delayMs: number;
  private readonly disposer: (key: K) => Promise<void>;
  private closed = false;
  private counts = new Map<K, number>();
  private timers = new Map<K, NodeJS.Timeout>();
  private locks = new Map<K, Promise<void>>();

  constructor(opts: { delayMs?: number; disposer: (key: K) => Promise<void> }) {
    this.delayMs = opts.delayMs ?? 30_000;
    this.disposer = opts.disposer;
  }

  /**
   * Acquire a lease on key. Returns an async release function.
   */
  async acquire(
    key: K,
  ): Promise<(opts?: { immediate?: boolean }) => Promise<void>> {
    if (this.closed) {
      throw new Error("lease manager is closed");
    }
    await this.withLock(key, async () => {
      // Cancel any pending disposal.
      const pending = this.timers.get(key);
      if (pending) {
        clearTimeout(pending);
        this.timers.delete(key);
      }
      const prev = this.counts.get(key) ?? 0;
      this.counts.set(key, prev + 1);
    });

    return async (opts?: { immediate?: boolean }) => {
      await this.withLock(key, async () => {
        const prev = this.counts.get(key) ?? 0;
        const next = Math.max(prev - 1, 0);
        this.counts.set(key, next);
        if (next > 0) return;

        const pending = this.timers.get(key);
        if (pending) {
          clearTimeout(pending);
          this.timers.delete(key);
        }

        if (opts?.immediate || this.delayMs <= 0) {
          try {
            await this.disposer(key);
          } finally {
            if ((this.counts.get(key) ?? 0) === 0) {
              this.counts.delete(key);
            }
          }
          return;
        }

        // Schedule disposer after delay; if a new acquire happens before it fires, it will be cancelled.
        const timer = setTimeout(() => {
          void this.withLock(key, async () => {
            if ((this.counts.get(key) ?? 0) > 0) return;
            try {
              await this.disposer(key);
            } finally {
              this.timers.delete(key);
              // Only clear count entry if still zero.
              if ((this.counts.get(key) ?? 0) === 0) {
                this.counts.delete(key);
              }
            }
          });
        }, this.delayMs);
        timer.unref?.();
        this.timers.set(key, timer);
      });
    };
  }

  getCount(key: K): number {
    return this.counts.get(key) ?? 0;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.counts.clear();
    await Promise.allSettled(this.locks.values());
    this.locks.clear();
  }

  private async withLock<T>(key: K, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release: () => void;
    const current = new Promise<void>((res) => {
      release = res;
    });
    this.locks.set(key, current);
    await prev;
    try {
      return await fn();
    } finally {
      release!();
      if (this.locks.get(key) === current) {
        this.locks.delete(key);
      }
    }
  }
}
