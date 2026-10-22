/*
Health of the deleted-project backup purges (hard-delete.ts).

A purge that is quarantined, or that stays overdue, means a deleted project's
backups are kept past its retention promise. In 2026-08 147 purges were
quarantined on two unreadable backup shards and nothing reported it for two
months, so admin health surfaces both states:

- critical: any quarantined purge, or any purge more than a day past due;
- warning: any purge past due (the worker runs them one at a time, so a short
  backlog right after the due time is normal);
- healthy: otherwise.
*/

import getPool from "@cocalc/database/pool";

export const BACKUP_PURGE_OVERDUE_CRITICAL_SECONDS = 24 * 60 * 60;

export interface BackupPurgeHealth {
  quarantined: number;
  overdue: number;
  overdue_critical: number;
  oldest_overdue_due_at: string | null;
  oldest_quarantined_at: string | null;
}

export type BackupPurgeHealthLevel = "healthy" | "warning" | "critical";

export function backupPurgeHealthLevel(
  health: BackupPurgeHealth,
): BackupPurgeHealthLevel {
  if (health.quarantined > 0 || health.overdue_critical > 0) {
    return "critical";
  }
  if (health.overdue > 0) {
    return "warning";
  }
  return "healthy";
}

export function backupPurgeHealthSummary(health: BackupPurgeHealth): string {
  if (health.quarantined === 0 && health.overdue === 0) {
    return "No deleted-project backup purge is quarantined or overdue.";
  }
  return `${health.quarantined} deleted-project backup purge${health.quarantined === 1 ? " is" : "s are"} quarantined and ${health.overdue} ${health.overdue === 1 ? "is" : "are"} overdue (${health.overdue_critical} more than a day past due); their backups are kept past the retention promise until resolved.`;
}

export async function getBackupPurgeHealth(): Promise<BackupPurgeHealth> {
  const { rows } = await getPool().query<{
    quarantined: string;
    overdue: string;
    overdue_critical: string;
    oldest_overdue_due_at: Date | null;
    oldest_quarantined_at: Date | null;
  }>(
    `SELECT COUNT(*) FILTER (WHERE backup_purge_status = 'quarantined')::TEXT AS quarantined,
            COUNT(*) FILTER (
              WHERE backups_purged_at IS NULL
                AND backup_purge_due_at < NOW()
            )::TEXT AS overdue,
            COUNT(*) FILTER (
              WHERE backups_purged_at IS NULL
                AND backup_purge_due_at < NOW() - make_interval(secs => $1)
            )::TEXT AS overdue_critical,
            MIN(backup_purge_due_at) FILTER (
              WHERE backups_purged_at IS NULL
                AND backup_purge_due_at < NOW()
            ) AS oldest_overdue_due_at,
            MIN(backup_purge_quarantined_at) FILTER (
              WHERE backup_purge_status = 'quarantined'
            ) AS oldest_quarantined_at
       FROM deleted_projects`,
    [BACKUP_PURGE_OVERDUE_CRITICAL_SECONDS],
  );
  const row = rows[0];
  return {
    quarantined: Number(row?.quarantined ?? 0) || 0,
    overdue: Number(row?.overdue ?? 0) || 0,
    overdue_critical: Number(row?.overdue_critical ?? 0) || 0,
    oldest_overdue_due_at: row?.oldest_overdue_due_at
      ? new Date(row.oldest_overdue_due_at).toISOString()
      : null,
    oldest_quarantined_at: row?.oldest_quarantined_at
      ? new Date(row.oldest_quarantined_at).toISOString()
      : null,
  };
}
