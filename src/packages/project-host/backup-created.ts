/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type BackupSnapshotRef = {
  id: string;
  time?: Date;
  summary?: Record<string, string | number>;
  snapshotGeneration?: number;
};

export function parseCreatedBackupSnapshot(
  created: unknown,
): BackupSnapshotRef | undefined {
  if (!created || typeof created !== "object") return undefined;

  const record = created as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) {
    return undefined;
  }

  return {
    id: record.id,
    time: parseBackupDate(record.time),
    summary: parseBackupSummary(record.summary),
    snapshotGeneration:
      typeof record.snapshotGeneration === "number" &&
      Number.isSafeInteger(record.snapshotGeneration) &&
      record.snapshotGeneration > 0
        ? record.snapshotGeneration
        : undefined,
  };
}

export function newestBackupTimeForIds({
  backups,
  backupIds,
  fallback,
}: {
  backups: readonly BackupSnapshotRef[];
  backupIds: ReadonlySet<string>;
  fallback?: Date;
}): Date | undefined {
  let newest = fallback;
  for (const backup of backups) {
    if (!backupIds.has(backup.id) || !backup.time) continue;
    if (!newest || backup.time > newest) {
      newest = backup.time;
    }
  }
  return newest;
}

// A successful upload is not a confirmed recovery point until every newly
// created ID can be read back from the remote repository with a valid time.
export function confirmedBackupTimeForIds({
  backups,
  backupIds,
}: {
  backups: readonly BackupSnapshotRef[];
  backupIds: ReadonlySet<string>;
}): Date | undefined {
  if (backupIds.size === 0) return undefined;
  const byId = new Map(backups.map((backup) => [backup.id, backup]));
  let newest: Date | undefined;
  for (const id of backupIds) {
    const time = byId.get(id)?.time;
    if (!time || !validDate(time)) return undefined;
    if (!newest || time > newest) newest = time;
  }
  return newest;
}

function parseBackupDate(value: unknown): Date | undefined {
  if (value instanceof Date) {
    return validDate(value) ? value : undefined;
  }
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const date = new Date(value);
  return validDate(date) ? date : undefined;
}

function validDate(date: Date): boolean {
  return !Number.isNaN(date.getTime());
}

function parseBackupSummary(
  value: unknown,
): Record<string, string | number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const summary: Record<string, string | number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" || typeof entry === "number") {
      summary[key] = entry;
    }
  }
  return summary;
}
