/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// "Run now" should start a run in seconds, not at the scheduler's next poll.
// The scheduler registers how to wake it; the manage API calls it. Another
// process of this bay still picks the run up at its next poll.

let kick: (() => void) | undefined;

export function setSensorSchedulerKick(fn: (() => void) | undefined): void {
  kick = fn;
}

/** Look for due sensors now instead of at the next poll. */
export function kickSensorScheduler(): void {
  kick?.();
}
