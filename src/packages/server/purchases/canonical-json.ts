/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

export function compareCanonicalKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function canonicalizeBillingValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeBillingValue);
  if (value != null && typeof value === "object") {
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") {
      return canonicalizeBillingValue(toJSON.call(value));
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => compareCanonicalKeys(a, b))
        .map(([key, item]) => [key, canonicalizeBillingValue(item)]),
    );
  }
  return value;
}
