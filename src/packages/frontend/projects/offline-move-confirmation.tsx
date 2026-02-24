import { Alert, Space, Tag, Timeline, Typography } from "antd";
import type { ReactNode } from "react";

const OFFLINE_MOVE_CONFIRM_CODE = "MOVE_OFFLINE_CONFIRMATION_REQUIRED";
const CALL_HUB_SUFFIX = /\s*-\s*callHub:[\s\S]*$/i;

type OfflineMoveReason = "no_backup" | "stale_backup";

export interface OfflineMoveConfirmationPayload {
  schema_version: 1;
  source_status: string;
  source_offline: true;
  source_deprovisioned: boolean;
  last_backup: string | null;
  last_edited: string | null;
  reason: OfflineMoveReason;
}

export interface OfflineMoveConfirmationDialog {
  title: string;
  content: ReactNode;
  okText: string;
  okButtonProps?: { danger?: boolean };
}

function trimPrefix(s: string): string {
  return s.replace(/^[:\s-]+/, "").trim();
}

function stripCallHub(s: string): string {
  return s.replace(CALL_HUB_SUFFIX, "").trim();
}

function parseLegacyDetail(detail: string): OfflineMoveConfirmationPayload {
  const clean = stripCallHub(detail);
  const statusMatch = clean.match(/status=([^)\s,]+)/i);
  const backupMatch = clean.match(/last_backup=([^,\)\s]+)/i);
  const editedMatch = clean.match(/last_edited=([^,\)\s]+)/i);
  const backupRaw = backupMatch?.[1];
  const editedRaw = editedMatch?.[1];
  const source_status = (statusMatch?.[1] ?? "unknown").toLowerCase();
  const last_backup =
    !backupRaw || backupRaw.toLowerCase() === "none" ? null : backupRaw;
  const last_edited =
    !editedRaw || editedRaw.toLowerCase() === "unknown" ? null : editedRaw;
  return {
    schema_version: 1,
    source_status,
    source_offline: true,
    source_deprovisioned: source_status === "deprovisioned",
    last_backup,
    last_edited,
    reason: last_backup == null ? "no_backup" : "stale_backup",
  };
}

export function parseOfflineMoveConfirmationError(
  err: unknown,
): OfflineMoveConfirmationPayload | null {
  const message = `${err ?? ""}`;
  const idx = message.indexOf(OFFLINE_MOVE_CONFIRM_CODE);
  if (idx < 0) return null;
  const detail = trimPrefix(message.slice(idx + OFFLINE_MOVE_CONFIRM_CODE.length));
  if (!detail) return parseLegacyDetail("");
  const clean = stripCallHub(detail);
  if (clean.startsWith("{")) {
    try {
      const parsed = JSON.parse(clean);
      if (
        parsed &&
        parsed.schema_version === 1 &&
        typeof parsed.source_status === "string" &&
        (parsed.reason === "no_backup" || parsed.reason === "stale_backup")
      ) {
        return parsed as OfflineMoveConfirmationPayload;
      }
    } catch {
      // fallback below
    }
  }
  return parseLegacyDetail(clean);
}

function formatTime(value: string | null): string {
  if (!value) return "None";
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return value;
  return d.toLocaleString();
}

function statusLabel(status: string): string {
  const s = `${status ?? "unknown"}`.trim().toLowerCase();
  if (s === "deprovisioned") return "Deprovisioned";
  if (!s) return "Unknown";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function buildOfflineMoveConfirmationDialog(
  payload: OfflineMoveConfirmationPayload,
): OfflineMoveConfirmationDialog {
  const noBackup = payload.reason === "no_backup";
  const sourceDeprovisioned = payload.source_deprovisioned;
  const sourceHeadline = payload.source_deprovisioned
    ? "Source host is deprovisioned (disk deleted)."
    : `Source host is offline (${statusLabel(payload.source_status)}).`;

  const riskMessage = (() => {
    if (noBackup && sourceDeprovisioned) {
      return "No backup exists for this workspace. The source host is already deprovisioned, so this workspace will be empty after move.";
    }
    if (noBackup) {
      return "No backup exists for this workspace. Moving now cannot recover the latest data from the source host.";
    }
    if (sourceDeprovisioned) {
      return "The latest available backup is older than the latest edit. Since the source host is already deprovisioned, newer edits are already unavailable. Moving restores the latest available backup.";
    }
    return "The latest backup is older than the latest edit. Moving now restores the latest backup and omits newer edits.";
  })();

  const okText = (() => {
    if (noBackup && sourceDeprovisioned) return "Move and create empty workspace";
    if (noBackup) return "Move and accept data-loss risk";
    if (sourceDeprovisioned) return "Move and restore available backup";
    return "Move using older backup";
  })();

  const moveOutcome = (() => {
    if (noBackup) {
      return "Workspace will be empty because there are no backups of it.";
    }
    if (sourceDeprovisioned) {
      return "Destination host restores the latest available backup. Edits newer than that backup are already unavailable.";
    }
    return "Destination host restores from the latest backup above.";
  })();

  const alertType = noBackup && !sourceDeprovisioned ? "error" : "warning";

  const items = [
    {
      color: payload.last_backup ? "orange" : "red",
      children: (
        <>
          <Typography.Text strong>Last backup</Typography.Text>
          <div>{formatTime(payload.last_backup)}</div>
        </>
      ),
    },
    {
      color: "blue",
      children: (
        <>
          <Typography.Text strong>Last edit</Typography.Text>
          <div>{formatTime(payload.last_edited)}</div>
        </>
      ),
    },
    {
      color: "gray",
      children: (
        <>
          <Typography.Text strong>If you move now</Typography.Text>
          <div>{moveOutcome}</div>
        </>
      ),
    },
  ];

  return {
    title: "Move from offline host?",
    okText,
    okButtonProps: { danger: !sourceDeprovisioned },
    content: (
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        <Alert
          showIcon
          type={alertType}
          message={sourceHeadline}
          description={riskMessage}
        />
        <div>
          <Tag color={noBackup ? "red" : "orange"}>
            {noBackup ? "No backup available" : "Backup stale"}
          </Tag>
          {sourceDeprovisioned && <Tag color="default">Source deprovisioned</Tag>}
        </div>
        <Timeline items={items} />
      </Space>
    ),
  };
}
