/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createProjectFieldState, useProjectField } from "./use-project-field";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { ProjectLauncherSettings } from "@cocalc/conat/hub/api/projects";

const launcherFieldState =
  createProjectFieldState<ProjectLauncherSettings>("launcher");

export function useProjectLauncher(
  project_id: string,
  initialLauncher?: unknown,
) {
  const {
    value: launcher,
    refresh,
    setValue: setLauncher,
  } = useProjectField({
    state: launcherFieldState,
    project_id,
    projectMapField: "launcher",
    initialValue: initialLauncher,
    fetch: async (project_id0) =>
      await webapp_client.conat_client.hub.projects.getProjectLauncher({
        project_id: project_id0,
      }),
  });

  return {
    launcher,
    refresh,
    setLauncher,
  };
}
