/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ProjectSecretMetadata } from "@cocalc/conat/hub/api/projects";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { createProjectFieldState, useProjectField } from "./use-project-field";

const secretsFieldState =
  createProjectFieldState<ProjectSecretMetadata[]>("secrets");

export function useProjectSecrets(project_id: string) {
  const {
    value: secrets,
    refresh,
    setValue: setSecrets,
  } = useProjectField({
    state: secretsFieldState,
    project_id,
    projectMapField: "secrets",
    fetch: async (project_id0) =>
      await webapp_client.conat_client.hub.projects.listProjectSecrets({
        project_id: project_id0,
      }),
  });

  return {
    secrets,
    refresh,
    setSecrets,
  };
}
