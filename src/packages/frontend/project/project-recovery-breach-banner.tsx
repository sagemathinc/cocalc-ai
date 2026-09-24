/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Space } from "antd";
import { useEffect, useState } from "react";
import type { ProjectRecoveryStatus } from "@cocalc/conat/hub/api/projects";
import { useActions } from "@cocalc/frontend/app-framework";
import { getProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import { lite } from "@cocalc/frontend/lite";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  PAYING_BACKUP_INCIDENT_DELAY_MS,
  PAYING_SNAPSHOT_INCIDENT_DELAY_MS,
  recoveryDelayExceeds,
} from "@cocalc/util/consts/project-recovery";

const REFRESH_MS = 5 * 60_000;

export function ProjectRecoveryBreachAlert({
  status,
  onReview,
}: {
  status: ProjectRecoveryStatus;
  onReview: (kind: "snapshots" | "backups") => void;
}) {
  if (status.storage_service_class === "free") return null;
  const snapshotLate =
    !status.snapshot_disabled &&
    recoveryDelayExceeds(
      status.snapshot_due_at,
      PAYING_SNAPSHOT_INCIDENT_DELAY_MS,
    );
  const backupLate =
    !status.backup_disabled &&
    recoveryDelayExceeds(status.backup_due_at, PAYING_BACKUP_INCIDENT_DELAY_MS);
  if (!snapshotLate && !backupLate) return null;

  const delayed = [
    snapshotLate ? "local snapshots" : null,
    backupLate ? "off-host backups" : null,
  ]
    .filter(Boolean)
    .join(" and ");
  return (
    <Alert
      banner
      showIcon
      type="error"
      title="Project recovery is delayed"
      description={`Scheduled ${delayed} are overdue. Review the latest confirmed recovery points and the reason for the delay.`}
      action={
        <Space wrap>
          {snapshotLate && (
            <Button size="small" onClick={() => onReview("snapshots")}>
              Review snapshots
            </Button>
          )}
          {backupLate && (
            <Button size="small" onClick={() => onReview("backups")}>
              Review backups
            </Button>
          )}
        </Space>
      }
    />
  );
}

export function ProjectRecoveryBreachBanner({
  project_id,
}: {
  project_id: string;
}) {
  const actions = useActions({ project_id });
  const [status, setStatus] = useState<ProjectRecoveryStatus | null>(null);

  useEffect(() => {
    if (!project_id || lite) return;
    let active = true;
    const refresh = async () => {
      try {
        const next =
          await webapp_client.conat_client.hub.projects.getRecoveryStatus({
            project_id,
          });
        if (active) setStatus(next);
      } catch {
        // Keep the last confirmed status through a temporary connection error.
      }
    };
    setStatus(null);
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [project_id]);

  if (lite || !status) return null;
  return (
    <ProjectRecoveryBreachAlert
      status={status}
      onReview={(kind) => {
        actions?.setState({
          find_tab: kind,
          find_scope_mode: "home",
          find_scope_path: getProjectHomeDirectory(project_id),
        });
        actions?.set_active_tab("search");
      }}
    />
  );
}
