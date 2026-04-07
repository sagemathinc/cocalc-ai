/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { ProjectCreated } from "@cocalc/conat/hub/api/projects";
import { createProjectFieldState, useProjectField } from "./use-project-field";

const createdFieldState = createProjectFieldState<ProjectCreated>();

export function useProjectCreated(
  project_id: string,
  initialCreated?: unknown,
) {
  const {
    value: created,
    refresh,
    setValue: setCreated,
  } = useProjectField({
    state: createdFieldState,
    project_id,
    projectMapField: "created",
    initialValue: initialCreated,
    fetch: async (project_id0) =>
      await webapp_client.conat_client.hub.projects.getProjectCreated({
        project_id: project_id0,
      }),
  });

  return {
    created,
    refresh,
    setCreated,
  };
}
