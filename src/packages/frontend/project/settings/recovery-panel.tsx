/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Card, Space, Typography } from "antd";
import type { ReactNode } from "react";

import { useProjectMapField } from "@cocalc/frontend/app-framework";
import { Icon, TimeAgo, type IconName } from "@cocalc/frontend/components";
import CreateBackup from "@cocalc/frontend/project/backups/create";
import CloneProject from "@cocalc/frontend/project/explorer/clone";
import CreateSnapshot from "@cocalc/frontend/project/snapshots/create";
import RestoreSnapshot from "@cocalc/frontend/project/snapshots/restore";
import { COLORS } from "@cocalc/util/theme";

import { Datastore } from "./datastore";
import type { Project } from "./types";

const { Text } = Typography;

interface RecoveryActionProps {
  icon: IconName;
  title: string;
  description: ReactNode;
  actions: ReactNode;
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
    </Card>
  );
}

export function RecoveryPanel({
  project_id,
  project,
  mode,
  showDatastore,
  datastoreReload,
}: Props) {
  const projectLastBackup = useProjectMapField(project_id, "last_backup");
  const lastBackup = projectLastBackup ?? project.get("last_backup");

  return (
    <Space
      direction="vertical"
      size={mode === "flyout" ? 10 : 14}
      style={{ width: "100%" }}
    >
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
      />
      <RecoveryAction
        mode={mode}
        icon="cloud-upload"
        title="Backups"
        description={
          <>
            Host-independent archives for project files, rootfs state, and
            TimeTravel history.
            {lastBackup ? (
              <>
                {" "}
                Last backup: <TimeAgo date={lastBackup as any} />.
              </>
            ) : (
              <span style={{ color: COLORS.GRAY_M }}> No backup recorded.</span>
            )}
          </>
        }
        actions={<CreateBackup />}
      />
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
