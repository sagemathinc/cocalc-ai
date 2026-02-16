/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Space, Tag, Typography } from "antd";
import { useMemo, useState } from "react";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon, SettingBox, Paragraph } from "@cocalc/frontend/components";
import type { IconName } from "@cocalc/frontend/components/icon";
import type { Project } from "./types";
import {
  LAUNCHER_GLOBAL_DEFAULTS,
  LAUNCHER_SITE_REMOVE_APPS_KEY,
  LAUNCHER_SITE_REMOVE_QUICK_KEY,
  LAUNCHER_SITE_DEFAULTS_APPS_KEY,
  LAUNCHER_SITE_DEFAULTS_QUICK_KEY,
  getProjectLauncherDefaults,
  getSiteLauncherDefaults,
  mergeLauncherSettings,
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
  const site_launcher_quick = useTypedRedux(
    "customize",
    LAUNCHER_SITE_DEFAULTS_QUICK_KEY,
  );
  const site_launcher_apps = useTypedRedux(
    "customize",
    LAUNCHER_SITE_DEFAULTS_APPS_KEY,
  );
  const site_remove_quick = useTypedRedux(
    "customize",
    LAUNCHER_SITE_REMOVE_QUICK_KEY,
  );
  const site_remove_apps = useTypedRedux(
    "customize",
    LAUNCHER_SITE_REMOVE_APPS_KEY,
  );
  const siteLauncherDefaults = getSiteLauncherDefaults({
    quickCreate: site_launcher_quick,
    apps: site_launcher_apps,
    hiddenQuickCreate: site_remove_quick,
    hiddenApps: site_remove_apps,
  });

  const launcher_settings = project.get("launcher");
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
  const effectiveApps = effective.apps;

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
        projectBaseQuickCreate={inheritedForProjectDefaults.quickCreate}
        projectBaseApps={inheritedForProjectDefaults.apps as NamedServerName[]}
        globalDefaults={siteLauncherDefaults}
        onSaveProject={(prefs) =>
          redux
            .getActions("projects")
            .set_project_launcher(project_id, prefs)
        }
        saveMode="project"
        contributions={[
          {
            key: "built-in",
            title: "Built-in defaults",
            quickCreateAdd: LAUNCHER_GLOBAL_DEFAULTS.quickCreate,
            appsAdd: LAUNCHER_GLOBAL_DEFAULTS.apps,
          },
          {
            key: "site",
            title: "Site defaults",
            quickCreateAdd: siteLauncherDefaults.quickCreate,
            quickCreateRemove: siteLauncherDefaults.hiddenQuickCreate,
            appsAdd: siteLauncherDefaults.apps,
            appsRemove: siteLauncherDefaults.hiddenApps,
          },
          {
            key: "workspace",
            title: "Workspace defaults",
            quickCreateAdd: projectDefaults.quickCreate,
            quickCreateRemove: projectDefaults.hiddenQuickCreate,
            appsAdd: projectDefaults.apps,
            appsRemove: projectDefaults.hiddenApps,
          },
        ]}
      />
    </SettingBox>
  );
}
