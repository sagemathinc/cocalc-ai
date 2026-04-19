/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export interface AdaptiveWindowOptions {
  min?: number;
  initial?: number;
  max?: number;
}

// This is intentionally simple AIMD. It keeps the implementation predictable
// and lets recovery / heartbeat schedulers use the same control law.
export class AdaptiveWindow {
  private readonly min: number;
  private readonly max: number;
  private current: number;
  private successCredits = 0;

  constructor(options: AdaptiveWindowOptions = {}) {
    this.min = Math.max(1, Math.floor(options.min ?? 1));
    this.max = Math.max(this.min, Math.floor(options.max ?? 16));
    this.current = Math.min(
      this.max,
      Math.max(this.min, Math.floor(options.initial ?? Math.min(4, this.max))),
    );
  }

  capacity = (): number => {
    return this.current;
  };

  noteSuccess = (): void => {
    if (this.current >= this.max) {
      this.successCredits = 0;
      return;
    }
    this.successCredits += 1;
    if (this.successCredits >= this.current) {
      this.current = Math.min(this.max, this.current + 1);
      this.successCredits = 0;
    }
  };

  noteFailure = (): void => {
    this.current = Math.max(this.min, Math.floor(this.current / 2));
    this.successCredits = 0;
  };
}
