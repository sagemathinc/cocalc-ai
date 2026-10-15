/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Logging for a background loop that keeps failing for the same reason (the
// database went away): the first failure is logged, then one summary every
// few minutes while it lasts, then one line when it recovers.

export const FAILURE_SUMMARY_MS = 5 * 60_000;

interface Log {
  warn: (...args: any[]) => void;
  info: (...args: any[]) => void;
}

export class FailureLog {
  private failures = 0;
  private since = 0;
  private lastLogged = 0;

  constructor(
    private readonly log: Log,
    private readonly what: string,
    private readonly summaryMs = FAILURE_SUMMARY_MS,
    private readonly now: () => number = Date.now,
  ) {}

  failed(err: unknown): void {
    const t = this.now();
    this.failures += 1;
    if (this.failures === 1) {
      this.since = this.lastLogged = t;
      this.log.warn(`${this.what} failed`, err);
    } else if (t - this.lastLogged >= this.summaryMs) {
      this.lastLogged = t;
      this.log.warn(`${this.what} still failing`, {
        failures: this.failures,
        since: new Date(this.since).toISOString(),
        error: `${err}`,
      });
    }
  }

  succeeded(): void {
    if (this.failures === 0) return;
    this.log.info(`${this.what} recovered`, {
      failures: this.failures,
      after_ms: this.now() - this.since,
    });
    this.failures = 0;
  }
}
