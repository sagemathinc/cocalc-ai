/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

export interface SerialQueueStats {
  active: boolean;
  queue_depth: number;
  completed: number;
  failed: number;
}

export class BillingAuthoritySerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private waiting = 0;
  private active = false;
  private completed = 0;
  private failed = 0;

  run<T>(fn: () => Promise<T>): Promise<T> {
    this.waiting += 1;
    const result = this.tail.then(async () => {
      this.waiting -= 1;
      this.active = true;
      try {
        const value = await fn();
        this.completed += 1;
        return value;
      } catch (err) {
        this.failed += 1;
        throw err;
      } finally {
        this.active = false;
      }
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  stats(): SerialQueueStats {
    return {
      active: this.active,
      queue_depth: this.waiting,
      completed: this.completed,
      failed: this.failed,
    };
  }
}
