/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ProjectEnv } from "@cocalc/conat/hub/api/projects";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { createProjectFieldState, useProjectField } from "./use-project-field";

const envFieldState = createProjectFieldState<ProjectEnv>("env");

export function useProjectEnv(project_id: string, initialEnv?: unknown) {
  const {
    value: env,
    refresh,
    setValue: setEnv,
  } = useProjectField({
    state: envFieldState,
    project_id,
    projectMapField: "env",
    initialValue: initialEnv,
    fetch: async (project_id0) =>
      await webapp_client.conat_client.hub.projects.getProjectEnv({
        project_id: project_id0,
      }),
  });

  return {
    env,
    refresh,
    setEnv,
  };
}
