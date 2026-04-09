/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect } from "react";
import type { ProjectActiveOperationSummary } from "@cocalc/conat/hub/api/projects";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { createProjectFieldState, useProjectField } from "./use-project-field";

const POLL_MS = 4000;

const activeOpFieldState =
  createProjectFieldState<ProjectActiveOperationSummary>("active_op");

export function useProjectActiveOperation(project_id: string) {
  const {
    value: activeOp,
    refresh,
    setValue: setActiveOp,
  } = useProjectField({
    state: activeOpFieldState,
    project_id,
    projectMapField: "active_op",
    fetch: async (project_id0) =>
      await webapp_client.conat_client.hub.projects.getProjectActiveOperation({
        project_id: project_id0,
      }),
  });

  useEffect(() => {
    if (!project_id) {
      return;
    }
    const timer = window.setInterval(() => {
      refresh();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [project_id, refresh]);

  return {
    activeOp,
    refresh,
    setActiveOp,
  };
}
