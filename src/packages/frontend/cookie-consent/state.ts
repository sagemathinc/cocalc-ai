/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const EVENT_NAME = "cc:internalStateChange";

let active = false;
let decided = false;

function emit(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(EVENT_NAME));
  }
}

export function markBannerActive(): void {
  active = true;
  decided = true;
  emit();
}

export function markBannerDecidedDisabled(): void {
  active = false;
  decided = true;
  emit();
}

export function isBannerActive(): boolean {
  return active;
}

export function isBannerDecided(): boolean {
  return decided;
}

export const BANNER_STATE_EVENT = EVENT_NAME;
