export const OFFLINE_MOVE_CONFIRM_CODE = "MOVE_OFFLINE_CONFIRMATION_REQUIRED";

export type OfflineMoveRiskReason = "no_backup" | "stale_backup";

export interface OfflineMoveConfirmationPayload {
  schema_version: 1;
  source_status: string;
  source_offline: true;
  source_deprovisioned: boolean;
  last_backup: string | null;
  last_edited: string | null;
  reason: OfflineMoveRiskReason;
}

function iso(value: Date | null | undefined): string | null {
  if (!value) return null;
  const ts = new Date(value as any).getTime();
  if (!Number.isFinite(ts)) return null;
  return new Date(ts).toISOString();
}

export function makeOfflineMoveConfirmationPayload({
  source_status,
  last_backup,
  last_edited,
}: {
  source_status?: string | null;
  last_backup?: Date | null;
  last_edited?: Date | null;
}): OfflineMoveConfirmationPayload {
  const status = `${source_status ?? "unknown"}`.trim() || "unknown";
  const backupIso = iso(last_backup);
  const editedIso = iso(last_edited);
  const reason: OfflineMoveRiskReason = backupIso == null ? "no_backup" : "stale_backup";
  return {
    schema_version: 1,
    source_status: status,
    source_offline: true,
    source_deprovisioned: status === "deprovisioned",
    last_backup: backupIso,
    last_edited: editedIso,
    reason,
  };
}

export function offlineMoveConfirmationError(
  payload: OfflineMoveConfirmationPayload,
): Error {
  return new Error(`${OFFLINE_MOVE_CONFIRM_CODE}: ${JSON.stringify(payload)}`);
}

