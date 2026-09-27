/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

export interface CensusLimits {
  directories: number;
  entries: number;
  entriesPerDirectory: number;
  candidates: number;
  depth: number;
}

export interface CensusCapacity {
  projects: number;
  bytes: number;
}

export const DEFAULT_CENSUS_CAPACITY: CensusCapacity = {
  projects: 4096,
  bytes: 64 * 1024 * 1024,
};

/** Trusted operator configuration; never supplied by list/status callers. */
export function censusCapacityFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): CensusCapacity {
  const result = { ...DEFAULT_CENSUS_CAPACITY };
  for (const [field, name, maximum] of [
    ["projects", "COCALC_COLLABORATORS_CENSUS_PROJECTS", 100_000],
    ["bytes", "COCALC_COLLABORATORS_CENSUS_BYTES", 1024 * 1024 * 1024],
  ] as const) {
    const raw = env[name];
    if (raw === undefined) continue;
    const value = Number(raw);
    if (
      !/^[1-9][0-9]*$/.test(raw) ||
      !Number.isSafeInteger(value) ||
      value > maximum
    )
      throw Error(`invalid ${name}`);
    result[field] = value;
  }
  return result;
}

export const DEFAULT_CENSUS_LIMITS: CensusLimits = {
  directories: 10_000,
  entries: 100_000,
  entriesPerDirectory: 10_000,
  candidates: 10_000,
  depth: 32,
};

export interface CensusRequest {
  project_id: string;
  /** Owner-issued idempotency key. A new run requires an explicit replacement CAS. */
  run_id: string;
  /** Opaque owner/host fence and persistent volume identity, not process counters. */
  authority: string;
  volume_id: string;
  root: string;
  policy_version: string;
  /** Canonical absolute subtrees. Exclusions encountered are reported as partial. */
  excluded_paths?: string[];
  limits?: Partial<CensusLimits>;
}

export interface CensusRun extends Omit<
  CensusRequest,
  "limits" | "excluded_paths"
> {
  limits: CensusLimits;
  excluded_paths: string[];
}

export interface CensusWork {
  run: CensusRun;
  path: string;
  depth: number;
}

export interface CensusCandidate {
  project_id: string;
  run_id: string;
  chat_path: string;
}

export interface CensusProgress {
  /** Discovery/handoff coverage only, not resource indexing or participant coverage. */
  coverage: "indexing" | "partial" | "complete";
  traversal_complete: boolean;
  directories: number;
  completed_directories: number;
  blocked_directories: number;
  entries: number;
  candidates: number;
  pending_candidates: number;
  excluded_entries: number;
  skipped_symlinks: number;
  errors: number;
  blocked_reason?: string;
}

export interface CensusPreviousRun extends CensusProgress {
  run_id: string;
  policy_version: string;
  started_at: number;
}

export interface CensusStatus extends CensusProgress {
  run: CensusRun;
  started_at: number;
  /** Last explicitly reset run, not an assertion of current traversal coverage. */
  previous?: CensusPreviousRun;
}

/** Structurally compatible with a Node Dirent; no whole-directory arrays. */
export interface CensusDirent {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface CensusDirectory {
  read(): Promise<CensusDirent | null>;
  assertCurrent?(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Integration must open only an existing volume, never start/provision compute.
 * The adapter must validate the run's authority and persistent volume identity,
 * enforce root/mount boundaries and no symlink traversal (including ancestors),
 * and bound individual I/O waits. The engine's time budget is cooperative.
 * A sandbox readdir/getListing result is NOT a suitable implementation.
 */
export interface CensusReader {
  assertCurrent(): Promise<void>;
  openDirectory(path: string): Promise<CensusDirectory>;
  close(): Promise<void>;
}

export interface CensusObservation {
  name: string;
  kind: "directory" | "file" | "symlink" | "other";
}

export class CensusQuotaError extends Error {
  constructor(
    readonly reason: string,
    readonly entireRun: boolean = true,
  ) {
    super(`collaboration census capacity reached: ${reason}`);
  }
}
