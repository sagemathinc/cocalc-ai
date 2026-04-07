/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fromJS, type Map } from "immutable";
import type { ProjectQuotaSettings } from "@cocalc/conat/hub/api/projects";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { createProjectFieldState, useProjectField } from "./use-project-field";

export type ProjectSettingsMap = Map<string, any>;

const settingsFieldState =
  createProjectFieldState<ProjectSettingsMap>("settings");

function normalizeSettings(
  settings?: ProjectQuotaSettings | null,
): ProjectSettingsMap {
  return fromJS(settings ?? {}) as ProjectSettingsMap;
}

export function useProjectSettings(
  project_id: string,
  initialSettings?: unknown,
) {
  const {
    value: settings,
    refresh,
    setValue: setSettings,
  } = useProjectField({
    state: settingsFieldState,
    project_id,
    projectMapField: "settings",
    initialValue: initialSettings,
    fetch: async (project_id0) =>
      normalizeSettings(
        await webapp_client.conat_client.hub.projects.getProjectSettings({
          project_id: project_id0,
        }),
      ),
  });

  return {
    settings,
    refresh,
    setSettings,
  };
}
