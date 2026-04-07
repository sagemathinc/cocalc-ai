/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createProjectFieldState, useProjectField } from "./use-project-field";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { ProjectRegion } from "@cocalc/conat/hub/api/projects";

const regionFieldState = createProjectFieldState<ProjectRegion>("region");

export function useProjectRegion(project_id: string) {
  const {
    value: region,
    refresh,
    setValue: setRegion,
  } = useProjectField({
    state: regionFieldState,
    project_id,
    projectMapField: "region",
    fetch: async (project_id0) =>
      await webapp_client.conat_client.hub.projects.getProjectRegion({
        project_id: project_id0,
      }),
  });

  return {
    region,
    refresh,
    setRegion,
  };
}
