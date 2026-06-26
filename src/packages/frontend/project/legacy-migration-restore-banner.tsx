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

type OptimisticRestoreState = {
  opId: string;
  status: string;
};

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
  const [reopenDismissed, setReopenDismissed] = useState(() =>
    wasReopenDismissed(dismissKey),
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

  if (!legacyProjectId) return null;

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

  const restored =
    effectiveStatus === "restored" || summary?.status === "succeeded";
  if (restored) {
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

  const failed =
    effectiveStatus === "failed" ||
    summary?.status === "failed" ||
    summary?.status === "canceled" ||
    summary?.status === "expired";
  const percent = progressPercent({ summary, progress });
  const detail = progressText({ summary, progress });
  const error = failed ? labelValue(summary?.error) || effectiveError : "";

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
          {detail ? <Text type="secondary">{detail}</Text> : null}
          {percent != null ? (
            <Progress
              percent={percent}
              size="small"
              status={progressBarStatus(summary?.status)}
            />
          ) : null}
          {error ? <Text type="danger">{error}</Text> : null}
          {failed ? (
            <Button
              loading={retrying}
              onClick={() => void retryRestore()}
              size="small"
            >
              Retry file restore
            </Button>
          ) : null}
        </Space>
      }
    />
  );
}
