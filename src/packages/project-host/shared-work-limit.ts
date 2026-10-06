/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Run expensive keyed work with a concurrency limit and a bounded wait queue.
// Callers with the same key share one in-flight run, and a successful result
// is reused for reuseMs. Failures are not reused.
export function createSharedWorkLimit<T>({
  maxConcurrent,
  maxWaiting,
  reuseMs,
  maxEntries,
  busyMessage,
  now = Date.now,
}: {
  maxConcurrent: number;
  maxWaiting: number;
  reuseMs: number;
  maxEntries: number;
  busyMessage: string;
  now?: () => number;
}): (key: string, run: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiters: (() => void)[] = [];
  const entries = new Map<
    string,
    { result: Promise<T>; finishedAt?: number }
  >();

  async function withSlot(run: () => Promise<T>): Promise<T> {
    while (running >= maxConcurrent) {
      if (waiters.length >= maxWaiting) {
        throw new Error(busyMessage);
      }
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    running += 1;
    try {
      return await run();
    } finally {
      running -= 1;
      waiters.shift()?.();
    }
  }

  return async (key, run) => {
    const existing = entries.get(key);
    if (
      existing != null &&
      (existing.finishedAt == null || now() - existing.finishedAt < reuseMs)
    ) {
      return await existing.result;
    }
    const entry: { result: Promise<T>; finishedAt?: number } = {
      result: withSlot(run),
    };
    entries.set(key, entry);
    for (const [oldKey, old] of entries) {
      if (entries.size <= maxEntries) break;
      if (old.finishedAt != null) entries.delete(oldKey);
    }
    try {
      const result = await entry.result;
      entry.finishedAt = now();
      return result;
    } catch (err) {
      if (entries.get(key) === entry) entries.delete(key);
      throw err;
    }
  };
}
