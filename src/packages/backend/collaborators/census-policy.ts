/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { createHash } from "node:crypto";
import { positiveCapacitySetting } from "./capacity";
import { DEFAULT_CENSUS_LIMITS } from "./census-types";
import type { CensusLimits } from "./census-types";

export interface CensusPolicy {
  version: string;
  limits: CensusLimits;
}

/** Changing this trusted policy requests a new fenced run, never an implicit
 * eviction or traversal during a list/status call. Keep the revision on restart. */
export function censusPolicyFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): CensusPolicy {
  const revision = env.COCALC_COLLABORATORS_CENSUS_RESCAN_REVISION;
  if (
    revision !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(revision)
  )
    throw Error("invalid COCALC_COLLABORATORS_CENSUS_RESCAN_REVISION");
  const limits = { ...DEFAULT_CENSUS_LIMITS };
  for (const [key, suffix, maximum] of [
    ["directories", "DIRECTORIES", 1_000_000],
    ["entries", "ENTRIES", 1_000_000],
    ["entriesPerDirectory", "DIRECTORY_ENTRIES", 1_000_000],
    ["candidates", "CANDIDATES", 1_000_000],
    ["depth", "DEPTH", 256],
  ] as const)
    limits[key] = positiveCapacitySetting(
      env,
      `COCALC_COLLABORATORS_CENSUS_${suffix}`,
      limits[key],
      maximum,
    );
  let version = "home-no-links-or-mounts-v1";
  if (JSON.stringify(limits) !== JSON.stringify(DEFAULT_CENSUS_LIMITS))
    version += `:limits-${createHash("sha256").update(JSON.stringify(limits)).digest("hex").slice(0, 16)}`;
  if (revision !== undefined) version += `:rescan-${revision}`;
  return { version, limits };
}
