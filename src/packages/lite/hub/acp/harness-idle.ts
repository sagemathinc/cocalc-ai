/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// A retained harness agent (a Claude controller, for example) keeps its
// process, and on a project host a transcript staging slot, until it is
// disposed. Dispose one that has been idle this long; the conversation's next
// turn starts a fresh harness, which resumes the same session.

export interface HarnessIdleDisposerOptions<T> {
  /** Idle time before disposal; 0 or less disables it. */
  idleMs: number;
  /** Called once the agent has been idle for idleMs. */
  dispose: (key: string, agent: T) => Promise<void>;
  onError?: (key: string, err: unknown) => void;
}

export class HarnessIdleDisposer<T> {
  private readonly timers = new Map<
    string,
    { agent: T; timer: ReturnType<typeof setTimeout> }
  >();
  // Turns using each key's agent now: it is idle only when none are.
  private readonly inUse = new Map<string, number>();

  constructor(private readonly options: HarnessIdleDisposerOptions<T>) {}

  /** A turn takes the key's agent: keep it. Call this synchronously when the
   * turn gets the agent, before any await, and release it exactly once. */
  acquire(key: string): void {
    this.inUse.set(key, (this.inUse.get(key) ?? 0) + 1);
    this.cancel(key);
  }

  /** A turn is done with the key's agent; agent is the one still retained
   * under that key (undefined if none is). Once no turn uses it, it is
   * disposed after idleMs. */
  release(key: string, agent: T | undefined): void {
    const count = (this.inUse.get(key) ?? 1) - 1;
    if (count > 0) {
      this.inUse.set(key, count);
      return;
    }
    this.inUse.delete(key);
    if (agent !== undefined) this.schedule(key, agent);
  }

  private schedule(key: string, agent: T): void {
    this.cancel(key);
    if (!(this.options.idleMs > 0)) return;
    const timer = setTimeout(() => {
      if (this.timers.get(key)?.timer !== timer) return;
      this.timers.delete(key);
      this.options.dispose(key, agent).catch((err) => {
        this.options.onError?.(key, err);
      });
    }, this.options.idleMs);
    timer.unref?.();
    this.timers.set(key, { agent, timer });
  }

  private cancel(key: string): void {
    const entry = this.timers.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.timers.delete(key);
  }

  /** Agents waiting to be disposed. */
  get size(): number {
    return this.timers.size;
  }
}

/** The idle time from COCALC_ACP_HARNESS_IDLE_DISPOSE_MS (default 10
 * minutes; 0 disables idle disposal). */
export function harnessIdleDisposeMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.COCALC_ACP_HARNESS_IDLE_DISPOSE_MS;
  if (raw == null || `${raw}`.trim() === "") return 10 * 60_000;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 10 * 60_000;
}
