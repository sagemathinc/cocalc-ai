import { DatabaseSync } from "node:sqlite";

import type { PersistMaintenanceConfig } from "@cocalc/backend/conat/persist-maintenance/config";

export function maintenanceTestConfig({
  root,
  catalogPath,
  dryRun = false,
}: {
  root: string;
  catalogPath: string;
  dryRun?: boolean;
}): PersistMaintenanceConfig {
  return {
    enabled: true,
    dryRun,
    catalogPath,
    rootTemplates: [root],
    idleMs: 0,
    minFileBytes: 1,
    minReclaimBytes: 1,
    minReclaimRatio: 0.01,
    minBetweenMs: 0,
    maxFileBytes: 1024 * 1024 * 1024,
    maxBytesPerHour: 1024 * 1024 * 1024,
    maxBytesPerDay: 1024 * 1024 * 1024,
    maxAttemptsPerHour: 100,
    maxConcurrent: 1,
    missingRetentionMs: 1000,
    jobTimeoutMs: 60_000,
    schedulerIntervalMs: 60_000,
    scanIntervalMs: 1000,
    scanEntryLimit: 10_000,
    scanByteLimit: 1024 * 1024 * 1024,
    scanTimeLimitMs: 60_000,
    minFreeBytes: 0,
    freeSpaceMultiplier: 1,
    maxLoadPerCpu: 1000,
    minFreeMemoryRatio: 0,
    promotionBarrierMs: 10_000,
    mutationHintIntervalMs: 1,
    runRetentionMs: 30 * 24 * 60 * 60 * 1000,
    runRetentionCount: 1000,
  };
}

export function createBloatedDatabase(path: string, rows = 256): void {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=DELETE");
  db.exec("CREATE TABLE payload(id INTEGER PRIMARY KEY, value BLOB NOT NULL)");
  const insert = db.prepare("INSERT INTO payload(value) VALUES(?)");
  db.exec("BEGIN");
  for (let i = 0; i < rows; i++) {
    insert.run(Buffer.alloc(32 * 1024, i % 251));
  }
  db.exec("COMMIT");
  db.exec("DELETE FROM payload WHERE id > 1");
  db.close();
}

export function quickCheck(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("PRAGMA quick_check").get() as Record<
      string,
      unknown
    >;
    return `${Object.values(row)[0]}`;
  } finally {
    db.close();
  }
}
