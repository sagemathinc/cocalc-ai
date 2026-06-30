/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Progress, Space, Typography, message } from "antd";
import { useEffect, useMemo, useState } from "react";

import type { LroEvent, LroSummary } from "@cocalc/conat/hub/api/lro";
import { redux, useProjectFromMap } from "@cocalc/frontend/app-framework";
import { isDismissed, progressBarStatus } from "@cocalc/frontend/lro/utils";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  LEGACY_RESTORE_ERROR_LABEL,
  LEGACY_RESTORE_LRO_LABEL,
  LEGACY_RESTORE_STATUS_LABEL,
  LEGACY_SOURCE_PROJECT_LABEL,
  legacyRestoreMissingArchiveEntriesFromError,
} from "@cocalc/util/legacy-migration";

const { Text } = Typography;

function labelValue(value: unknown): string {
  return `${value ?? ""}`.trim();
}

function projectLabels(project: any): Record<string, unknown> {
  return project?.get?.("labels")?.toJS?.() ?? project?.get?.("labels") ?? {};
}

function reopenDismissKey({
  project_id,
  opId,
}: {
  project_id: string;
  opId: string;
}): string {
  return `legacy-project-restore-reopened:${project_id}:${opId || "no-op"}`;
}

function activeRestoreSeenKey({
  project_id,
  opId,
}: {
  project_id: string;
  opId: string;
}): string {
  return `legacy-project-restore-active-seen:${project_id}:${opId || "no-op"}`;
}

function knownRestoredKey({
  project_id,
  opId,
}: {
  project_id: string;
  opId: string;
}): string {
  return `legacy-project-restore-known-restored:${project_id}:${opId || "no-op"}`;
}

function restoreIssueDismissKey({
  project_id,
  opId,
}: {
  project_id: string;
  opId: string;
}): string {
  return `legacy-project-restore-issue-dismissed:${project_id}:${opId || "no-op"}`;
}

export function markLegacyProjectRestoreKnownRestored({
  project_id,
  opId,
}: {
  project_id: string;
  opId?: string | null;
}): void {
  try {
    globalThis.sessionStorage?.setItem(
      knownRestoredKey({ project_id, opId: labelValue(opId) }),
      "1",
    );
  } catch {}
}

function wasReopenDismissed(key: string): boolean {
  try {
    return globalThis.sessionStorage?.getItem(key) === "1";
  } catch {
    return false;
  }
}

function markReopenDismissed(key: string): void {
  try {
    globalThis.sessionStorage?.setItem(key, "1");
  } catch {}
}

function wasActiveRestoreSeen(key: string): boolean {
  try {
    return globalThis.sessionStorage?.getItem(key) === "1";
  } catch {
    return false;
  }
}

function markActiveRestoreSeen(key: string): void {
  try {
    globalThis.sessionStorage?.setItem(key, "1");
  } catch {}
}

function wasKnownRestored(key: string): boolean {
  try {
    return globalThis.sessionStorage?.getItem(key) === "1";
  } catch {
    return false;
  }
}

function wasRestoreIssueDismissed(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === "1";
  } catch {
    return false;
  }
}

function markRestoreIssueDismissed(key: string): void {
  try {
    globalThis.localStorage?.setItem(key, "1");
  } catch {}
}

function isActiveRestoreStatus(status: string): boolean {
  return (
    status === "pending" || status === "restoring" || status === "indexing"
  );
}

function progressPercent({
  summary,
  progress,
}: {
  summary?: LroSummary;
  progress?: Extract<LroEvent, { type: "progress" }>;
}): number | undefined {
  const value =
    progress?.progress ??
    summary?.progress_summary?.progress ??
    (summary?.status === "succeeded" ? 100 : undefined);
  if (value == null || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function progressText({
  summary,
  progress,
}: {
  summary?: LroSummary;
  progress?: Extract<LroEvent, { type: "progress" }>;
}): string {
  const phase = labelValue(progress?.phase ?? summary?.progress_summary?.phase);
  const message = labelValue(
    progress?.message ?? summary?.progress_summary?.message,
  );
  return [phase, message].filter(Boolean).join(": ");
}

function formatCount(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString()
    : "";
}

function formatBytes(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  if (value < 1024) return `${Math.round(value).toLocaleString()} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let scaled = value / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && scaled >= 1024; i += 1) {
    scaled /= 1024;
    unit = units[i];
  }
  return `${scaled.toFixed(scaled < 10 ? 1 : 0)} ${unit}`;
}

function timestampMs(value: unknown): number | undefined {
  const ms =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : typeof value === "string"
          ? Date.parse(value)
          : undefined;
  return typeof ms === "number" && Number.isFinite(ms) ? ms : undefined;
}

function formatTimestamp(value: unknown): string {
  const ms = timestampMs(value);
  return ms == null ? "" : new Date(ms).toLocaleString();
}

function restoreQueueAndTimingText({
  effectiveStatus,
  summary,
  progress,
}: {
  effectiveStatus: string;
  summary?: LroSummary;
  progress?: Extract<LroEvent, { type: "progress" }>;
}): string {
  const phase = labelValue(
    progress?.phase ?? summary?.progress_summary?.phase,
  ).toLowerCase();
  const isQueued =
    effectiveStatus === "pending" ||
    summary?.status === "queued" ||
    phase === "queued";
  const started = formatTimestamp(summary?.started_at ?? summary?.created_at);
  if (!isQueued && !started) return "";
  const prefix = isQueued ? "Restore is queued." : "Restore is running.";
  return started ? `${prefix} LRO started ${started}.` : prefix;
}

function progressDetailText({
  summary,
  progress,
}: {
  summary?: LroSummary;
  progress?: Extract<LroEvent, { type: "progress" }>;
}): string {
  const detail =
    progress?.detail ??
    (summary?.progress_summary?.detail as Record<string, unknown> | undefined);
  if (!detail || typeof detail !== "object") return "";
  const parts: string[] = [];
  const bytes = formatBytes((detail as any).bytes);
  const expectedBytes = formatBytes((detail as any).expected_bytes);
  if (bytes && expectedBytes) {
    parts.push(`${bytes} of ${expectedBytes}`);
  } else if (bytes) {
    parts.push(bytes);
  }
  const extracted = formatCount((detail as any).extracted_count);
  const files = formatCount((detail as any).file_count);
  if (extracted && files) {
    parts.push(`${extracted} of ${files} entries`);
  } else if (files) {
    parts.push(`${files} entries`);
  }
  const uncompressed = formatBytes((detail as any).uncompressed_bytes);
  if (uncompressed) {
    parts.push(`${uncompressed} unpacked`);
  }
  const currentPath = labelValue((detail as any).current_path);
  if (currentPath) {
    parts.push(currentPath);
  }
  const skipped = formatCount((detail as any).skipped_file_count);
  const skippedBytes = formatBytes((detail as any).skipped_bytes);
  if (skipped) {
    parts.push(
      skippedBytes
        ? `${skipped} oversized file(s) skipped (${skippedBytes})`
        : `${skipped} oversized file(s) skipped`,
    );
  }
  return parts.join(" • ");
}

type OptimisticRestoreState = {
  opId: string;
  status: string;
};

function skippedRestoreText({
  summary,
  progress,
  error,
}: {
  summary?: LroSummary;
  progress?: Extract<LroEvent, { type: "progress" }>;
  error?: string;
}): string {
  const detail =
    progress?.detail ??
    (summary?.progress_summary?.detail as
      | Record<string, unknown>
      | undefined) ??
    (summary?.result as Record<string, unknown> | undefined);
  if (!detail || typeof detail !== "object") return "";
  const parts: string[] = [];
  const skippedCount = (detail as any).skipped_file_count;
  if (
    typeof skippedCount === "number" &&
    Number.isFinite(skippedCount) &&
    skippedCount > 0
  ) {
    const bytes = formatBytes((detail as any).skipped_bytes);
    const files = Array.isArray((detail as any).skipped_files)
      ? (detail as any).skipped_files
      : [];
    const shown = files
      .map((file) => labelValue(file?.path))
      .filter(Boolean)
      .slice(0, 5);
    const hidden = Math.max(0, skippedCount - shown.length);
    parts.push(
      `${formatCount(skippedCount)} oversized file(s) were not restored${
        bytes ? ` (${bytes})` : ""
      }.`,
    );
    if (shown.length > 0) {
      parts.push(
        `Skipped: ${shown.join(", ")}${hidden ? `, and ${hidden} more` : ""}.`,
      );
    }
  }
  const missingCount = (detail as any).missing_archive_file_count;
  if (
    typeof missingCount === "number" &&
    Number.isFinite(missingCount) &&
    missingCount > 0
  ) {
    const files = Array.isArray((detail as any).missing_archive_files)
      ? (detail as any).missing_archive_files
      : [];
    const shown = files.map(labelValue).filter(Boolean).slice(0, 5);
    const hidden = Math.max(0, missingCount - shown.length);
    parts.push(
      `${formatCount(missingCount)} archive entr${
        missingCount === 1 ? "y was" : "ies were"
      } listed but not restored.`,
    );
    if (shown.length > 0) {
      parts.push(
        `Missing: ${shown.join(", ")}${hidden ? `, and ${hidden} more` : ""}.`,
      );
    }
  }
  const missingFromError = legacyRestoreMissingArchiveEntriesFromError(error);
  if (missingFromError.length > 0 && parts.length === 0) {
    const shown = missingFromError.slice(0, 5);
    const hidden = Math.max(0, missingFromError.length - shown.length);
    parts.push(
      `${formatCount(missingFromError.length)} archive entr${
        missingFromError.length === 1 ? "y was" : "ies were"
      } listed but not restored.`,
    );
    parts.push(
      `Missing: ${shown.join(", ")}${hidden ? `, and ${hidden} more` : ""}.`,
    );
  }
  return parts.join(" ");
}

export function LegacyMigrationRestoreBanner({
  project_id,
}: {
  project_id: string;
}) {
  const project = useProjectFromMap(project_id);
  const labels = useMemo(() => projectLabels(project), [project]);
  const legacyProjectId = labelValue(labels[LEGACY_SOURCE_PROJECT_LABEL]);
  const labeledStatus = labelValue(labels[LEGACY_RESTORE_STATUS_LABEL]);
  const labeledError = labelValue(labels[LEGACY_RESTORE_ERROR_LABEL]);
  const opId = labelValue(labels[LEGACY_RESTORE_LRO_LABEL]);
  const [summary, setSummary] = useState<LroSummary>();
  const [progress, setProgress] =
    useState<Extract<LroEvent, { type: "progress" }>>();
  const [retrying, setRetrying] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [optimisticRestore, setOptimisticRestore] =
    useState<OptimisticRestoreState>();
  const effectiveOpId = optimisticRestore?.opId ?? opId;
  const effectiveStatus = optimisticRestore?.status ?? labeledStatus;
  const effectiveError = optimisticRestore ? "" : labeledError;
  const dismissKey = useMemo(
    () => reopenDismissKey({ project_id, opId: effectiveOpId }),
    [effectiveOpId, project_id],
  );
  const activeSeenKey = useMemo(
    () => activeRestoreSeenKey({ project_id, opId: effectiveOpId }),
    [effectiveOpId, project_id],
  );
  const restoreIssueKey = useMemo(
    () => restoreIssueDismissKey({ project_id, opId: effectiveOpId }),
    [effectiveOpId, project_id],
  );
  const [reopenDismissed, setReopenDismissed] = useState(() =>
    wasReopenDismissed(dismissKey),
  );
  const [activeRestoreSeen, setActiveRestoreSeen] = useState(() =>
    wasActiveRestoreSeen(activeSeenKey),
  );
  const [knownRestored, setKnownRestored] = useState(() =>
    wasKnownRestored(knownRestoredKey({ project_id, opId: effectiveOpId })),
  );
  const [restoreIssueDismissed, setRestoreIssueDismissed] = useState(() =>
    wasRestoreIssueDismissed(restoreIssueKey),
  );

  useEffect(() => {
    if (optimisticRestore && opId === optimisticRestore.opId) {
      setOptimisticRestore(undefined);
    }
  }, [opId, optimisticRestore]);

  useEffect(() => {
    setReopenDismissed(wasReopenDismissed(dismissKey));
  }, [dismissKey]);

  useEffect(() => {
    setActiveRestoreSeen(wasActiveRestoreSeen(activeSeenKey));
  }, [activeSeenKey]);

  useEffect(() => {
    setKnownRestored(
      wasKnownRestored(knownRestoredKey({ project_id, opId: effectiveOpId })),
    );
  }, [effectiveOpId, project_id]);

  useEffect(() => {
    setRestoreIssueDismissed(wasRestoreIssueDismissed(restoreIssueKey));
  }, [restoreIssueKey]);

  useEffect(() => {
    setSummary(undefined);
    setProgress(undefined);
    if (!effectiveOpId) return;
    let closed = false;
    async function watch() {
      try {
        const current = await webapp_client.conat_client.hub.lro.get({
          op_id: effectiveOpId,
        });
        if (!closed) setSummary(current);
        await webapp_client.conat_client.lroWait({
          op_id: effectiveOpId,
          scope_type: "project",
          scope_id: project_id,
          timeout_ms: 24 * 60 * 60 * 1000,
          poll_ms: 5000,
          onProgress: (event) => {
            if (!closed) setProgress(event);
          },
          onSummary: (nextSummary) => {
            if (!closed) setSummary(nextSummary);
          },
        });
      } catch {}
    }
    void watch();
    return () => {
      closed = true;
    };
  }, [effectiveOpId, project_id]);

  const failed =
    effectiveStatus === "failed" ||
    summary?.status === "failed" ||
    summary?.status === "canceled" ||
    summary?.status === "expired";
  const restored =
    knownRestored ||
    effectiveStatus === "restored" ||
    summary?.status === "succeeded";
  const skippedText = skippedRestoreText({ summary, progress });

  useEffect(() => {
    if (!legacyProjectId || restored || failed) return;
    if (
      isActiveRestoreStatus(effectiveStatus) ||
      summary?.status === "queued" ||
      summary?.status === "running"
    ) {
      markActiveRestoreSeen(activeSeenKey);
      setActiveRestoreSeen(true);
    }
  }, [
    activeSeenKey,
    effectiveStatus,
    failed,
    legacyProjectId,
    restored,
    summary?.status,
  ]);

  if (!legacyProjectId) return null;
  if (restoreIssueDismissed && failed) return null;

  async function reopenProject() {
    setReopening(true);
    try {
      if (effectiveOpId) {
        void webapp_client.conat_client.hub.lro
          .dismiss({ op_id: effectiveOpId })
          .catch((err) => {
            console.warn("failed to dismiss completed legacy restore LRO", err);
          });
      }
      markReopenDismissed(dismissKey);
      setReopenDismissed(true);
      webapp_client.conat_client.releaseProjectHostRouting({ project_id });
      redux.getActions("page").close_project_tab(project_id);
      redux.removeProjectReferences(project_id);
      await Promise.resolve();
      await redux.getActions("projects").open_project({
        project_id,
        switch_to: true,
        restore_session: true,
        change_history: true,
      });
    } catch (err) {
      setReopenDismissed(false);
      void message.error(`${err}`);
    } finally {
      setReopening(false);
    }
  }

  if (restored) {
    if (!activeRestoreSeen) return null;
    if (reopenDismissed || isDismissed(summary)) return null;
    return (
      <Alert
        showIcon
        type="success"
        message="Legacy project files restored"
        description={
          <Space direction="vertical" size={10}>
            <Text>
              The imported files are now available. Reopen the project to reset
              the file browser state and show the restored directory listing.
            </Text>
            {skippedText ? (
              <Text type="warning" style={{ fontSize: 12 }}>
                {skippedText}
              </Text>
            ) : null}
            <Button
              type="primary"
              size="large"
              loading={reopening}
              onClick={() => void reopenProject()}
            >
              Reopen Project
            </Button>
          </Space>
        }
      />
    );
  }

  if (summary != null && isDismissed(summary)) {
    return null;
  }

  const percent = progressPercent({ summary, progress });
  const detail = progressText({ summary, progress });
  const detailExtra = progressDetailText({ summary, progress });
  const queueAndTiming = restoreQueueAndTimingText({
    effectiveStatus,
    summary,
    progress,
  });
  const error = failed ? labelValue(summary?.error) || effectiveError : "";
  const warningText = skippedRestoreText({ summary, progress, error });
  const errorIsMissingArchiveEntries =
    legacyRestoreMissingArchiveEntriesFromError(error).length > 0;

  async function retryRestore() {
    setRetrying(true);
    try {
      const result =
        await webapp_client.conat_client.hub.legacyMigration.retryProjectRestore(
          {
            legacy_project_id: legacyProjectId,
          },
        );
      setOptimisticRestore({
        opId: result.restore_lro_op_id ?? "",
        status: result.restore_status,
      });
      setSummary(undefined);
      setProgress(undefined);
      void message.success("Legacy project file restore restarted.");
      if (result.restore_lro_op_id && result.restore_lro_op_id !== opId) {
        await webapp_client.conat_client.hub.lro.get({
          op_id: result.restore_lro_op_id,
        });
      }
    } catch (err) {
      void message.error(`${err}`);
    } finally {
      setRetrying(false);
    }
  }

  async function acceptRestoreIssue() {
    markRestoreIssueDismissed(restoreIssueKey);
    setRestoreIssueDismissed(true);
    if (effectiveOpId) {
      await webapp_client.conat_client.hub.lro
        .dismiss({ op_id: effectiveOpId })
        .catch((err) => {
          console.warn("failed to dismiss legacy restore LRO", err);
        });
    }
    void message.success("Legacy restore warning hidden for this project.");
  }

  return (
    <Alert
      showIcon
      type={failed ? "error" : "info"}
      message={
        failed
          ? "Legacy project file restore failed"
          : "Restoring legacy project files"
      }
      description={
        <Space direction="vertical" size={8} style={{ width: "100%" }}>
          <Text>
            This project was created from a legacy archive. Files may be
            incomplete until the restore finishes. You can leave this page and
            come back later.
          </Text>
          {queueAndTiming ? (
            <Text type="secondary">{queueAndTiming}</Text>
          ) : null}
          {detail ? <Text type="secondary">{detail}</Text> : null}
          {detailExtra ? (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {detailExtra}
            </Text>
          ) : null}
          {warningText ? (
            <Text type="warning" style={{ fontSize: 12 }}>
              {warningText}
            </Text>
          ) : null}
          {percent != null ? (
            <Progress
              percent={percent}
              size="small"
              status={progressBarStatus(summary?.status)}
            />
          ) : null}
          {error && !errorIsMissingArchiveEntries ? (
            <Text type="danger">{error}</Text>
          ) : null}
          {failed ? (
            <Space wrap>
              <Button
                loading={retrying}
                onClick={() => void retryRestore()}
                size="small"
              >
                Retry full file restore
              </Button>
              <Button onClick={() => void acceptRestoreIssue()} size="small">
                Accept and hide
              </Button>
            </Space>
          ) : null}
        </Space>
      }
    />
  );
}
