/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

export interface CollaborationJournalCapacity {
  sources: number;
  bytes: number;
}

const DEFAULTS: CollaborationJournalCapacity = {
  sources: 10_000,
  bytes: 256 * 1024 * 1024,
};
const MAXIMUM: CollaborationJournalCapacity = {
  sources: 1_000_000,
  bytes: 4 * 1024 * 1024 * 1024,
};

export function positiveCapacitySetting(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (
    !/^[1-9][0-9]*$/.test(raw) ||
    !Number.isSafeInteger(value) ||
    value > maximum
  )
    throw Error(`invalid ${name}`);
  return value;
}

export function validateJournalCapacity(
  capacity: CollaborationJournalCapacity,
): CollaborationJournalCapacity {
  for (const key of ["sources", "bytes"] as const)
    if (
      !Number.isSafeInteger(capacity[key]) ||
      capacity[key] < 1 ||
      capacity[key] > MAXIMUM[key]
    )
      throw Error(`invalid collaboration journal ${key} capacity`);
  return { sources: capacity.sources, bytes: capacity.bytes };
}

/** Trusted runtime configuration only; never accepted from a client request. */
export function journalCapacityFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): CollaborationJournalCapacity {
  return validateJournalCapacity({
    sources: positiveCapacitySetting(
      env,
      "COCALC_COLLABORATORS_JOURNAL_SOURCES",
      DEFAULTS.sources,
      MAXIMUM.sources,
    ),
    bytes: positiveCapacitySetting(
      env,
      "COCALC_COLLABORATORS_JOURNAL_BYTES",
      DEFAULTS.bytes,
      MAXIMUM.bytes,
    ),
  });
}
