/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Space, Tag, Typography } from "antd";
import { useMemo, useState } from "react";
import { redux } from "@cocalc/frontend/app-framework";
import { Icon, SettingBox, Paragraph } from "@cocalc/frontend/components";
import type { IconName } from "@cocalc/frontend/components/icon";
import type { Project } from "./types";
import {
  getProjectLauncherDefaults,
  LAUNCHER_GLOBAL_DEFAULTS,
} from "../new/launcher-preferences";
import { LauncherCustomizeModal } from "../new/launcher-customize-modal";
import type { NamedServerName } from "@cocalc/util/types/servers";
import { APP_CATALOG, QUICK_CREATE_MAP } from "../new/launcher-catalog";
import { file_options } from "@cocalc/frontend/editor-tmp";

interface Props {
  project_id: string;
  project: Project;
}

export function LauncherDefaults({ project_id, project }: Props) {
  const [showProjectModal, setShowProjectModal] = useState(false);

  const launcher_settings = project.get("launcher");
  const projectDefaults = useMemo(
    () => getProjectLauncherDefaults(launcher_settings),
    [launcher_settings],
  );

  const effectiveQuickCreate =
    projectDefaults.quickCreate && projectDefaults.quickCreate.length > 0
      ? projectDefaults.quickCreate
      : LAUNCHER_GLOBAL_DEFAULTS.quickCreate;
  const effectiveApps =
    projectDefaults.apps && projectDefaults.apps.length > 0
      ? projectDefaults.apps
      : LAUNCHER_GLOBAL_DEFAULTS.apps;

  const quickCreateSpecs = useMemo((): { id: string; label: string; icon: IconName }[] => {
    return effectiveQuickCreate.map((id) => {
      const spec = QUICK_CREATE_MAP[id];
      if (spec) {
        return { id, label: spec.label, icon: spec.icon };
      }
      const data = file_options(`x.${id}`);
      return {
        id,
        label: data.name ?? id,
        icon: (data.icon ?? "file") as IconName,
      };
    });
  }, [effectiveQuickCreate]);

  const appSpecs = useMemo((): { id: string; label: string; icon: IconName }[] => {
    return effectiveApps
      .map((id) => {
        const spec = APP_CATALOG.find((item) => item.id === id);
        if (spec) {
          return { id, label: spec.label, icon: spec.icon };
        }
        return null;
      })
      .filter(Boolean) as { id: string; label: string; icon: IconName }[];
  }, [effectiveApps]);

  return (
    <SettingBox title="Project Launcher Defaults" icon="rocket">
      <Paragraph style={{ marginBottom: "12px" }}>
        These are the default Quick Create buttons for everyone in this
        workspace. Each user can still further customize their buttons on their
        +New page.
      </Paragraph>
      <Space direction="vertical" style={{ width: "100%" }}>
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <Typography.Text strong style={{ display: "block" }}>
              Quick Create Defaults
            </Typography.Text>
            <Button size="small" onClick={() => setShowProjectModal(true)}>
              Customize
            </Button>
          </div>
          <Space style={{ flexWrap: "wrap" }}>
            {quickCreateSpecs.map((spec) => (
              <Tag key={`proj-qc-${spec.id}`}>
                <Icon name={spec.icon} /> {spec.label}
              </Tag>
            ))}
          </Space>
        </div>
        <div style={{ marginTop: "12px" }}>
          <Typography.Text strong style={{ display: "block" }}>
            Apps
          </Typography.Text>
          <Space style={{ flexWrap: "wrap" }}>
            {appSpecs.map((spec) => (
              <Tag key={`proj-app-${spec.id}`}>
                <Icon name={spec.icon} /> {spec.label}
              </Tag>
            ))}
          </Space>
        </div>
      </Space>
      <LauncherCustomizeModal
        open={showProjectModal}
        onClose={() => setShowProjectModal(false)}
        initialQuickCreate={effectiveQuickCreate}
        initialApps={effectiveApps as NamedServerName[]}
        onSaveProject={(prefs) =>
          redux
            .getActions("projects")
            .set_project_launcher(project_id, prefs)
        }
        saveMode="project"
      />
    </SettingBox>
  );
}
