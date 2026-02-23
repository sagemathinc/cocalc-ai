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
  const sourceHeadline = payload.source_deprovisioned
    ? "Source host is deprovisioned."
    : `Source host is offline (${statusLabel(payload.source_status)}).`;

  const riskMessage =
    payload.reason === "no_backup"
      ? "No backup exists for this workspace. Moving now cannot recover the latest data from the source host."
      : "The latest backup is older than the latest edit. Moving now restores the latest backup and omits newer edits.";

  const okText =
    payload.reason === "no_backup"
      ? "Move and accept data-loss risk"
      : "Move using older backup";

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
          <div>Destination host restores from the latest backup above.</div>
        </>
      ),
    },
  ];

  return {
    title: "Move from offline host?",
    okText,
    okButtonProps: { danger: true },
    content: (
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        <Alert
          showIcon
          type={payload.reason === "no_backup" ? "error" : "warning"}
          message={sourceHeadline}
          description={riskMessage}
        />
        <div>
          <Tag color={payload.reason === "no_backup" ? "red" : "orange"}>
            {payload.reason === "no_backup" ? "No backup available" : "Backup stale"}
          </Tag>
        </div>
        <Timeline items={items} />
      </Space>
    ),
  };
}
