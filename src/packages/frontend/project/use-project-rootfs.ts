/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ProjectRootfsConfig } from "@cocalc/conat/hub/api/projects";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { createProjectFieldState, useProjectField } from "./use-project-field";

const rootfsFieldState = createProjectFieldState<ProjectRootfsConfig>("rootfs");

export function useProjectRootfs(project_id: string, initialRootfs?: unknown) {
  const {
    value: rootfs,
    refresh,
    setValue: setRootfs,
  } = useProjectField({
    state: rootfsFieldState,
    project_id,
    projectMapField: "__rootfs__",
    initialValue: initialRootfs,
    fetch: async (project_id0) =>
      await webapp_client.conat_client.hub.projects.getProjectRootfs({
        project_id: project_id0,
      }),
  });

  return {
    rootfs,
    refresh,
    setRootfs,
  };
}
