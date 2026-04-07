/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect } from "react";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { ProjectRunQuota } from "@cocalc/conat/hub/api/projects";
import { createProjectFieldState, useProjectField } from "./use-project-field";

const runQuotaFieldState =
  createProjectFieldState<ProjectRunQuota>("run_quota");

export function useProjectRunQuota(project_id: string) {
  const projectStatus = useTypedRedux({ project_id }, "status");
  const projectState = `${projectStatus?.get("state") ?? ""}`.trim();
  const {
    value: runQuota,
    refresh,
    setValue: setRunQuota,
  } = useProjectField({
    state: runQuotaFieldState,
    project_id,
    projectMapField: "run_quota",
    fetch: async (project_id0) =>
      await webapp_client.conat_client.hub.projects.getProjectRunQuota({
        project_id: project_id0,
      }),
  });

  useEffect(() => {
    if (!project_id) {
      return;
    }
    refresh();
  }, [project_id, projectState, refresh]);

  return {
    runQuota,
    refresh,
    setRunQuota,
  };
}
