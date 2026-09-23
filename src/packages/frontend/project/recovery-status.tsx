/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useState } from "react";
import { Alert } from "antd";
import type { ProjectRecoveryStatus as RecoveryStatus } from "@cocalc/conat/hub/api/projects";
import { webapp_client } from "@cocalc/frontend/webapp-client";

const REFRESH_MS = 60_000;
const STALE_HOST_MS = 5 * 60_000;
const STALE_REPORT_MS = 25 * 60 * 60_000;

function formatted(value: string | null | undefined): string {
  if (!value) return "none recorded";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "unknown";
}

function age(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Date.now() - timestamp : null;
}

function reasonText(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const text = reason.toLowerCase();
  if (text.includes("lifecycle"))
    return "The host is busy starting or stopping projects.";
  if (text.includes("io_pressure"))
    return "The host is under storage pressure.";
  if (text.includes("memory")) return "The host is under memory pressure.";
  if (text.includes("quota")) return "Storage quota is blocking maintenance.";
  if (text.includes("limit of") && text.includes("backup")) {
    return "The backup retention limit is blocking a new backup.";
  }
  if (text.includes("egress"))
    return "The backup upload allowance is exhausted.";
  return "The last scheduled attempt did not complete. Please contact support if this persists.";
}

export function ProjectRecoveryStatus({
  project_id,
  kind,
}: {
  project_id: string;
  kind: "snapshot" | "backup";
}) {
  const [status, setStatus] = useState<RecoveryStatus | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!project_id) return;
    let closed = false;
    const refresh = async () => {
      try {
        const value =
          await webapp_client.conat_client.hub.projects.getRecoveryStatus({
            project_id,
          });
        if (!closed) {
          setStatus(value);
          setError(false);
        }
      } catch {
        if (!closed) setError(true);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }, [project_id]);

  const label = kind === "snapshot" ? "Local snapshots" : "Off-host backups";
  if (error) {
    return (
      <Alert type="warning" title={`${label}: protection status unavailable`} />
    );
  }
  if (!status) {
    return <div role="status">Checking {label.toLowerCase()} status…</div>;
  }
  const disabled =
    kind === "snapshot" ? status.snapshot_disabled : status.backup_disabled;
  const report = status[kind];
  const latest =
    kind === "snapshot"
      ? status.snapshot?.latest_snapshot_at
      : status.last_backup;
  const dueAt =
    kind === "snapshot" ? status.snapshot_due_at : status.backup_due_at;
  const hostStale = age(status.host_last_seen);
  const reportStale = age(report?.observed_at);
  const unknown =
    status.host_id == null ||
    hostStale == null ||
    hostStale > STALE_HOST_MS ||
    reportStale == null ||
    reportStale > STALE_REPORT_MS;
  const overdueMs = age(dueAt);
  const overdue = overdueMs != null && overdueMs > 0;
  const critical =
    overdue && overdueMs > (kind === "snapshot" ? 2 : 12) * 60 * 60_000;
  const reason = reasonText(report?.reason);
  let title = `${label}: latest confirmed ${formatted(latest)}`;
  let description: string | undefined;
  let type: "info" | "success" | "warning" | "error" = "success";
  if (disabled) {
    title = `${label}: automatic schedule disabled`;
    description = `Latest confirmed recovery point: ${formatted(latest)}.`;
    type = "info";
  } else if (unknown) {
    title = `${label}: current protection status unknown`;
    description = `Latest confirmed recovery point: ${formatted(latest)}. Host or maintenance reporting is stale.${overdue ? ` Scheduled recovery point was due ${formatted(dueAt)}.` : ""}`;
    type = critical ? "error" : "warning";
  } else if (overdue) {
    title = `${label}: scheduled recovery point overdue`;
    description = `Due ${formatted(dueAt)}. Latest confirmed: ${formatted(latest)}.${reason ? ` ${reason}` : ""}`;
    type = critical ? "error" : "warning";
  } else if (!latest) {
    title = `${label}: no confirmed recovery point`;
    description =
      report?.reason === "no_content_change" ||
      report?.reason === "no_change_due"
        ? "The last check found no changed content to protect."
        : "A confirmed recovery point has not been recorded yet.";
    type = "warning";
  } else if (report?.reason === "no_content_change") {
    description = "The last check found no changed content to protect.";
    type = "info";
  } else if (report?.outcome === "failed" || report?.outcome === "deferred") {
    description = reason ?? "The last scheduled attempt did not complete.";
    type = "warning";
  } else if (dueAt) {
    description = `Next due: ${formatted(dueAt)}.`;
  }
  return (
    <div
      aria-live={overdue ? "assertive" : "polite"}
      style={{ marginBottom: 10 }}
    >
      <Alert type={type} title={title} description={description} showIcon />
    </div>
  );
}
