/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Space, Tag, Typography } from "antd";
import { useMemo, useState } from "react";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon, SettingBox, Paragraph } from "@cocalc/frontend/components";
import type { IconName } from "@cocalc/frontend/components/icon";
import {
  LAUNCHER_GLOBAL_DEFAULTS,
  LAUNCHER_SITE_REMOVE_QUICK_KEY,
  LAUNCHER_SITE_DEFAULTS_QUICK_KEY,
  getProjectLauncherDefaults,
  getSiteLauncherDefaults,
  mergeLauncherSettings,
} from "../new/launcher-preferences";
import { LauncherCustomizeModal } from "../new/launcher-customize-modal";
import { QUICK_CREATE_MAP } from "../new/launcher-catalog";
import { file_options } from "@cocalc/frontend/editor-tmp";
import { useProjectLauncher } from "../use-project-launcher";

interface Props {
  project_id: string;
}

export function LauncherDefaults({ project_id }: Props) {
  const [showProjectModal, setShowProjectModal] = useState(false);
  const site_launcher_quick = useTypedRedux(
    "customize",
    LAUNCHER_SITE_DEFAULTS_QUICK_KEY,
  );
  const site_remove_quick = useTypedRedux(
    "customize",
    LAUNCHER_SITE_REMOVE_QUICK_KEY,
  );
  const siteLauncherDefaults = getSiteLauncherDefaults({
    quickCreate: site_launcher_quick,
    hiddenQuickCreate: site_remove_quick,
  });

  const { launcher: launcher_settings, setLauncher } =
    useProjectLauncher(project_id);
  const projectDefaults = useMemo(
    () => getProjectLauncherDefaults(launcher_settings),
    [launcher_settings],
  );

  const inheritedForProjectDefaults = mergeLauncherSettings({
    globalDefaults: siteLauncherDefaults,
  });
  const effective = mergeLauncherSettings({
    globalDefaults: siteLauncherDefaults,
    projectDefaults,
  });
  const effectiveQuickCreate = effective.quickCreate;

  const quickCreateSpecs = useMemo((): {
    id: string;
    label: string;
    icon: IconName;
  }[] => {
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

  return (
    <SettingBox title="Project Launcher Defaults" icon="rocket">
      <Paragraph style={{ marginBottom: "12px" }}>
        These are the default Quick Create buttons for everyone in this project.
        Each user can still further customize their buttons on their +New page.
      </Paragraph>
      <Space orientation="vertical" style={{ width: "100%" }}>
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
      </Space>
      <LauncherCustomizeModal
        open={showProjectModal}
        onClose={() => setShowProjectModal(false)}
        initialQuickCreate={effectiveQuickCreate}
        projectBaseQuickCreate={inheritedForProjectDefaults.quickCreate}
        onSaveProject={async (prefs) => {
          await redux
            .getActions("projects")
            .set_project_launcher(project_id, prefs);
          setLauncher(prefs);
        }}
        saveMode="project"
        contributions={[
          {
            key: "built-in",
            title: "Built-in defaults",
            quickCreateAdd: LAUNCHER_GLOBAL_DEFAULTS.quickCreate,
          },
          {
            key: "site",
            title: "Site defaults",
            quickCreateAdd: siteLauncherDefaults.quickCreate,
            quickCreateRemove: siteLauncherDefaults.hiddenQuickCreate,
          },
          {
            key: "project",
            title: "Project defaults",
            quickCreateAdd: projectDefaults.quickCreate,
            quickCreateRemove: projectDefaults.hiddenQuickCreate,
          },
        ]}
      />
    </SettingBox>
  );
}
