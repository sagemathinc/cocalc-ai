import { envToInt } from "@cocalc/backend/misc/env-to-number";

export const BACKUP_LRO_KIND = "project-backup";
export const DEFAULT_BACKUP_TIMEOUT_MS = 6 * 60 * 60 * 1000;
export const BACKUP_TIMEOUT_MS = Math.max(
  60_000,
  envToInt("COCALC_BACKUP_LRO_TIMEOUT_MS", DEFAULT_BACKUP_TIMEOUT_MS),
);

export function backupLroDedupeKey(project_id: string): string {
  return `${BACKUP_LRO_KIND}:${project_id}`;
}

export function getBackupOpReferenceTime(op: {
  started_at?: Date | string | null;
  created_at?: Date | string | null;
}): number {
  const startedAt = op.started_at ? new Date(op.started_at).getTime() : 0;
  if (startedAt) return startedAt;
  const createdAt = op.created_at ? new Date(op.created_at).getTime() : 0;
  return createdAt;
}

export function isBackupOpTimedOut(
  op: {
    started_at?: Date | string | null;
    created_at?: Date | string | null;
  },
  now = Date.now(),
  timeoutMs = BACKUP_TIMEOUT_MS,
): boolean {
  const reference = getBackupOpReferenceTime(op);
  if (!reference) return false;
  return now - reference > timeoutMs;
}
