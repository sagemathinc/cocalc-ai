/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Card, Space, Typography } from "antd";
import type { ReactNode } from "react";

import { Icon, type IconName } from "@cocalc/frontend/components";
import CreateBackup from "@cocalc/frontend/project/backups/create";
import CloneProject from "@cocalc/frontend/project/explorer/clone";
import { ProjectRecoveryStatus } from "@cocalc/frontend/project/recovery-status";
import CreateSnapshot from "@cocalc/frontend/project/snapshots/create";
import RestoreSnapshot from "@cocalc/frontend/project/snapshots/restore";

import { Datastore } from "./datastore";
import type { Project } from "./types";
import { useProjectRuntimeCapabilities } from "../runtime-capabilities";

const { Text } = Typography;

interface RecoveryActionProps {
  icon: IconName;
  title: string;
  description: ReactNode;
  actions: ReactNode;
  status?: ReactNode;
  mode?: "project" | "flyout";
}

interface Props {
  project_id: string;
  project: Project;
  mode?: "project" | "flyout";
  showDatastore?: boolean;
  datastoreReload?: number;
}

function RecoveryAction({
  icon,
  title,
  description,
  actions,
  status,
  mode,
}: RecoveryActionProps) {
  const isFlyout = mode === "flyout";
  return (
    <Card size="small" styles={{ body: { padding: 12 } }}>
      <div
        style={{
          display: "grid",
          gap: isFlyout ? 10 : 12,
          gridTemplateColumns: isFlyout
            ? "minmax(0, 1fr)"
            : "minmax(0, 1fr) auto",
          alignItems: isFlyout ? "stretch" : "center",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              fontWeight: 600,
              marginBottom: 4,
            }}
          >
            <Icon name={icon} /> {title}
          </div>
          <Text type="secondary">{description}</Text>
        </div>
        <Space
          wrap
          style={{ justifyContent: isFlyout ? "flex-start" : "flex-end" }}
        >
          {actions}
        </Space>
      </div>
      {status}
    </Card>
  );
}

export function RecoveryPanel({
  project_id,
  mode,
  showDatastore,
  datastoreReload,
}: Props) {
  const runtime = useProjectRuntimeCapabilities();
  return (
    <Space
      vertical
      size={mode === "flyout" ? 10 : 14}
      style={{ width: "100%" }}
    >
      {runtime.snapshots && (
        <RecoveryAction
          mode={mode}
          icon="disk-snapshot"
          title="Snapshots"
          description="Fast point-in-time project filesystem checkpoints. Restore creates a safety snapshot before changing files."
          actions={
            <>
              <CreateSnapshot />
              <RestoreSnapshot />
            </>
          }
          status={
            <ProjectRecoveryStatus project_id={project_id} kind="snapshot" />
          }
        />
      )}
      {runtime.backups && (
        <RecoveryAction
          mode={mode}
          icon="cloud-upload"
          title="Backups"
          description="Host-independent archives for project files, rootfs state, and TimeTravel history."
          actions={<CreateBackup />}
          status={
            <ProjectRecoveryStatus project_id={project_id} kind="backup" />
          }
        />
      )}
      <RecoveryAction
        mode={mode}
        icon="copy"
        title="Clone or Copy"
        description="Create a separate project copy without changing the current project."
        actions={<CloneProject project_id={project_id} />}
      />
      {showDatastore && (
        <Datastore
          project_id={project_id}
          mode={mode}
          reloadTrigger={datastoreReload}
        />
      )}
    </Space>
  );
}
