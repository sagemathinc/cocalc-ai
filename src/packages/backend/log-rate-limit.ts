/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** Bounded insertion-ordered map; the oldest key goes when it is full. */
export class BoundedMap<V> {
  private readonly values = new Map<string, V>();
  constructor(private readonly maxKeys: number) {}

  get(key: string) {
    return this.values.get(key);
  }

  set(key: string, value: V) {
    this.values.delete(key);
    if (this.values.size >= this.maxKeys) {
      const oldest = this.values.keys().next().value;
      if (oldest != null) this.values.delete(oldest);
    }
    this.values.set(key, value);
  }

  delete(key: string) {
    this.values.delete(key);
  }

  get size() {
    return this.values.size;
  }
}

/** Allows one log line per key per interval and counts what it suppressed. */
export class LogRateLimiter {
  private readonly state: BoundedMap<{ at: number; suppressed: number }>;
  private readonly intervalMs: number;
  private readonly now: () => number;

  constructor({
    intervalMs = 60_000,
    maxKeys = 1000,
    now = () => Date.now(),
  }: { intervalMs?: number; maxKeys?: number; now?: () => number } = {}) {
    this.intervalMs = intervalMs;
    this.now = now;
    this.state = new BoundedMap(maxKeys);
  }

  /** Returns the suppressed count to log with, or undefined to stay quiet. */
  take(key: string): number | undefined {
    const now = this.now();
    const entry = this.state.get(key);
    if (entry && now - entry.at < this.intervalMs) {
      entry.suppressed++;
      return undefined;
    }
    this.state.set(key, { at: now, suppressed: 0 });
    return entry?.suppressed ?? 0;
  }
}
