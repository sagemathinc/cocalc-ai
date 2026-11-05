/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// An account's membership limits and usage, the numbers "Usage and limits"
// shows, for API keys and agents with usage:read: never which purchase,
// grant, license, organization or override provides them, and no per-event
// details (project titles, request paths). Built from the shape of the
// values (scalars and flat maps of numbers), so a new field of another kind
// stays out until reviewed.

import type {
  MembershipDetails,
  MembershipUsage,
  MembershipUsageValue,
} from "@cocalc/conat/hub/api/purchases";

function scalar(value: unknown): MembershipUsageValue | undefined {
  if (value instanceof Date)
    return Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.slice(0, 200);
  return undefined;
}

function numbers(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  if (value instanceof Date) return;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.every(([, v]) => typeof v === "number" && Number.isFinite(v)))
    return;
  return Object.fromEntries(entries) as Record<string, number>;
}

function curated(
  value: object | undefined,
): Record<string, MembershipUsageValue | Record<string, number>> {
  const result: Record<string, MembershipUsageValue | Record<string, number>> =
    {};
  for (const [key, raw] of Object.entries(value ?? {})) {
    if (key === "account_id") continue;
    const v = scalar(raw) ?? numbers(raw);
    if (v !== undefined) result[key] = v;
  }
  return result;
}

export function membershipUsageSummary(
  details: MembershipDetails,
): MembershipUsage {
  const { selected } = details;
  const expires = scalar(selected.expires);
  return {
    membership: {
      class: selected.class,
      source: selected.source,
      ...(typeof expires === "string" ? { expires } : {}),
    },
    limits: curated(
      selected.effective_limits ?? selected.entitlements?.usage_limits,
    ),
    usage: details.usage_status ? curated(details.usage_status) : null,
  };
}
