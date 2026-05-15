/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Card, Space, Typography } from "antd";
import type { ReactNode } from "react";

import { useTypedRedux } from "@cocalc/frontend/app-framework";
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
}: RecoveryActionProps) {
  return (
    <Card size="small" styles={{ body: { padding: 12 } }}>
      <div
        style={{
          display: "grid",
          gap: 12,
          gridTemplateColumns: "minmax(0, 1fr) auto",
          alignItems: "center",
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
        <Space wrap>{actions}</Space>
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
  const projectMap = useTypedRedux("projects", "project_map");
  const lastBackup =
    projectMap?.getIn([project_id, "last_backup"]) ??
    project.get("last_backup");

  return (
    <Space
      direction="vertical"
      size={mode === "flyout" ? 10 : 14}
      style={{ width: "100%" }}
    >
      <RecoveryAction
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
