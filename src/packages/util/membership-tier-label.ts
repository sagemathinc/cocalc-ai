/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

export const MAX_MEMBERSHIP_TIER_LABEL_LENGTH = 100;

export function boundedMembershipTierLabel({
  id,
  label,
}: {
  id: unknown;
  label?: unknown;
}): string {
  const fallback = `${id ?? ""}`.trim();
  const display = `${label ?? ""}`.trim() || fallback;
  return display.slice(0, MAX_MEMBERSHIP_TIER_LABEL_LENGTH);
}

export function assertValidMembershipTierLabel(label: unknown): void {
  if (label == null) return;
  if (typeof label !== "string") {
    throw Error("membership tier label must be a string");
  }
  if (label.length > MAX_MEMBERSHIP_TIER_LABEL_LENGTH) {
    throw Error(
      `membership tier label must be at most ${MAX_MEMBERSHIP_TIER_LABEL_LENGTH} characters`,
    );
  }
}
