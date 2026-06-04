/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export interface MembershipTierOrderInput {
  id: string;
  label?: string;
  price_monthly?: unknown;
  price_yearly?: unknown;
  priority?: unknown;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : undefined;
  }
  if (value != null && typeof value === "object") {
    const numberValue = (value as { toNumber?: () => number }).toNumber?.();
    if (Number.isFinite(numberValue)) return numberValue;
  }
  return undefined;
}

function monthlyEquivalentPrice(
  tier: MembershipTierOrderInput,
): number | undefined {
  const monthly = asFiniteNumber(tier.price_monthly);
  if (monthly != null) return monthly;
  const yearly = asFiniteNumber(tier.price_yearly);
  return yearly == null ? undefined : yearly / 12;
}

function compareNumberKeys(
  left: number | undefined,
  right: number | undefined,
): number {
  const leftValue = left ?? Number.POSITIVE_INFINITY;
  const rightValue = right ?? Number.POSITIVE_INFINITY;
  return leftValue - rightValue;
}

export function compareMembershipTiersByDisplayOrder(
  left: MembershipTierOrderInput,
  right: MembershipTierOrderInput,
): number {
  return (
    compareNumberKeys(
      asFiniteNumber(left.priority),
      asFiniteNumber(right.priority),
    ) ||
    compareNumberKeys(
      monthlyEquivalentPrice(left),
      monthlyEquivalentPrice(right),
    ) ||
    (left.label ?? left.id).localeCompare(right.label ?? right.id)
  );
}

export function sortMembershipTiersByDisplayOrder<
  T extends MembershipTierOrderInput,
>(tiers: readonly T[]): T[] {
  return [...tiers].sort(compareMembershipTiersByDisplayOrder);
}
