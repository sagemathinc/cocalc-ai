/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Times of recent events per key, within a sliding window, for a soft limit
kept in one process (or page): calls per account, request ids seen, sends
per thread. Its size is bounded however many keys ever appear:

- a key whose window has emptied is deleted;
- keys are kept in the order of their latest event, so the expired ones are
  always first, and each call deletes those (each key is deleted at most
  once per event, so this costs amortized O(1) a call);
- at most maxKeys keys are kept: past that, the key with the oldest latest
  event is dropped.

Dropping a key only forgets its events, so it can only loosen the limit
this backs. Use it only in front of an authoritative limit.
*/

export class RecentTimes {
  private readonly times = new Map<string, number[]>();
  private readonly windowMs: number;
  private readonly maxKeys: number;

  constructor({ windowMs, maxKeys }: { windowMs: number; maxKeys: number }) {
    if (!(windowMs > 0) || !Number.isSafeInteger(maxKeys) || maxKeys < 1) {
      throw new Error("RecentTimes needs a positive window and key limit");
    }
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
  }

  /** How many events the key has had in the window before now. */
  count(key: string, now: number): number {
    this.sweep(now);
    return this.live(key, now).length;
  }

  /** Records an event for the key at now. */
  add(key: string, now: number): void {
    this.sweep(now);
    const times = this.live(key, now);
    times.push(now);
    // Latest event last: delete and set moves the key to the end.
    this.times.delete(key);
    this.times.set(key, times);
    while (this.times.size > this.maxKeys) {
      const oldest = this.times.keys().next().value as string;
      this.times.delete(oldest);
    }
  }

  /** Records an event unless the key already has limit events in the
   * window; says whether it was recorded. */
  take(key: string, now: number, limit: number): boolean {
    if (this.count(key, now) >= limit) return false;
    this.add(key, now);
    return true;
  }

  get size(): number {
    return this.times.size;
  }

  clear(): void {
    this.times.clear();
  }

  private live(key: string, now: number): number[] {
    const times = this.times.get(key);
    if (times == null) return [];
    const kept = times.filter((t) => now - t < this.windowMs);
    if (kept.length === 0) this.times.delete(key);
    else if (kept.length < times.length) this.times.set(key, kept);
    return kept;
  }

  // The first keys have the oldest latest events: delete them while their
  // latest event is out of the window.
  private sweep(now: number): void {
    for (const [key, times] of this.times) {
      if (now - times[times.length - 1] < this.windowMs) return;
      this.times.delete(key);
    }
  }
}
