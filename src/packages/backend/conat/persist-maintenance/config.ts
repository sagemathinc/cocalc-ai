/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { join } from "node:path";

import { syncFiles } from "@cocalc/backend/data";

const TRUE = new Set(["1", "true", "yes", "on"]);

function bool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  return value == null ? fallback : TRUE.has(value.trim().toLowerCase());
}

function number(name: string, fallback: number, minimum = 0): number {
  const value = process.env[name];
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(
      `${name} must be a number greater than or equal to ${minimum}`,
    );
  }
  return parsed;
}

export interface PersistMaintenanceConfig {
  enabled: boolean;
  dryRun: boolean;
  catalogPath: string;
  rootTemplates: string[];
  idleMs: number;
  minFileBytes: number;
  minReclaimBytes: number;
  minReclaimRatio: number;
  minBetweenMs: number;
  maxFileBytes: number;
  maxBytesPerHour: number;
  maxBytesPerDay: number;
  maxAttemptsPerHour: number;
  maxConcurrent: number;
  missingRetentionMs: number;
  jobTimeoutMs: number;
  schedulerIntervalMs: number;
  scanIntervalMs: number;
  scanEntryLimit: number;
  scanByteLimit: number;
  scanTimeLimitMs: number;
  minFreeBytes: number;
  freeSpaceMultiplier: number;
  maxLoadPerCpu: number;
  minFreeMemoryRatio: number;
  promotionBarrierMs: number;
  mutationHintIntervalMs: number;
  runRetentionMs: number;
  runRetentionCount: number;
  pauseFile?: string;
}

export function loadPersistMaintenanceConfig(): PersistMaintenanceConfig {
  const rootTemplates = [
    syncFiles.local,
    syncFiles.localProjects,
    syncFiles.localAccounts,
    syncFiles.localHosts,
    syncFiles.localHub,
  ].filter((value, index, all): value is string => {
    return !!value && all.indexOf(value) === index;
  });
  return {
    enabled: bool("COCALC_PERSIST_MAINTENANCE_ENABLED", false),
    dryRun: bool("COCALC_PERSIST_MAINTENANCE_DRY_RUN", true),
    catalogPath:
      process.env.COCALC_PERSIST_MAINTENANCE_DB?.trim() ||
      join(syncFiles.local, ".maintenance", "catalog.sqlite"),
    rootTemplates,
    idleMs:
      number("COCALC_PERSIST_MAINTENANCE_IDLE_HOURS", 24) * 60 * 60 * 1000,
    minFileBytes:
      number("COCALC_PERSIST_MAINTENANCE_MIN_FILE_MB", 64) * 1024 * 1024,
    minReclaimBytes:
      number("COCALC_PERSIST_MAINTENANCE_MIN_RECLAIM_MB", 32) * 1024 * 1024,
    minReclaimRatio: number(
      "COCALC_PERSIST_MAINTENANCE_MIN_RECLAIM_RATIO",
      0.25,
    ),
    minBetweenMs:
      number("COCALC_PERSIST_MAINTENANCE_MIN_DAYS_BETWEEN", 7) *
      24 *
      60 *
      60 *
      1000,
    maxFileBytes:
      number("COCALC_PERSIST_MAINTENANCE_MAX_FILE_GB", 4) * 1024 * 1024 * 1024,
    maxBytesPerHour: number(
      "COCALC_PERSIST_MAINTENANCE_MAX_BYTES_PER_HOUR",
      1024 * 1024 * 1024,
    ),
    maxBytesPerDay: number(
      "COCALC_PERSIST_MAINTENANCE_MAX_BYTES_PER_DAY",
      4 * 1024 * 1024 * 1024,
    ),
    maxAttemptsPerHour: number(
      "COCALC_PERSIST_MAINTENANCE_MAX_ATTEMPTS_PER_HOUR",
      4,
      1,
    ),
    maxConcurrent: number("COCALC_PERSIST_MAINTENANCE_MAX_CONCURRENT", 1, 1),
    missingRetentionMs:
      number("COCALC_PERSIST_MAINTENANCE_MISSING_RETENTION_DAYS", 30) *
      24 *
      60 *
      60 *
      1000,
    jobTimeoutMs:
      number("COCALC_PERSIST_MAINTENANCE_JOB_TIMEOUT_MINUTES", 30, 1) *
      60 *
      1000,
    schedulerIntervalMs: number(
      "COCALC_PERSIST_MAINTENANCE_SCHEDULER_INTERVAL_MS",
      60_000,
      1000,
    ),
    scanIntervalMs: number(
      "COCALC_PERSIST_MAINTENANCE_SCAN_INTERVAL_MS",
      60 * 60 * 1000,
      1000,
    ),
    scanEntryLimit: number(
      "COCALC_PERSIST_MAINTENANCE_SCAN_ENTRY_LIMIT",
      5000,
      1,
    ),
    scanByteLimit: number(
      "COCALC_PERSIST_MAINTENANCE_SCAN_BYTE_LIMIT",
      4 * 1024 * 1024 * 1024,
      1,
    ),
    scanTimeLimitMs: number(
      "COCALC_PERSIST_MAINTENANCE_SCAN_TIME_LIMIT_MS",
      250,
      1,
    ),
    minFreeBytes:
      number("COCALC_PERSIST_MAINTENANCE_MIN_FREE_GB", 10) * 1024 * 1024 * 1024,
    freeSpaceMultiplier: number(
      "COCALC_PERSIST_MAINTENANCE_FREE_SPACE_MULTIPLIER",
      2.5,
      1,
    ),
    maxLoadPerCpu: number(
      "COCALC_PERSIST_MAINTENANCE_MAX_LOAD_PER_CPU",
      0.75,
      0.01,
    ),
    minFreeMemoryRatio: number(
      "COCALC_PERSIST_MAINTENANCE_MIN_FREE_MEMORY_RATIO",
      0.1,
    ),
    promotionBarrierMs: number(
      "COCALC_PERSIST_MAINTENANCE_PROMOTION_BARRIER_MS",
      2000,
      100,
    ),
    mutationHintIntervalMs: number(
      "COCALC_PERSIST_MAINTENANCE_MUTATION_HINT_INTERVAL_MS",
      5 * 60 * 1000,
      1000,
    ),
    runRetentionMs:
      number("COCALC_PERSIST_MAINTENANCE_RUN_RETENTION_DAYS", 30) *
      24 *
      60 *
      60 *
      1000,
    runRetentionCount: number(
      "COCALC_PERSIST_MAINTENANCE_RUN_RETENTION_COUNT",
      1000,
      10,
    ),
    pauseFile:
      process.env.COCALC_PERSIST_MAINTENANCE_PAUSE_FILE?.trim() || undefined,
  };
}
