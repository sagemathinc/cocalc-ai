/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { useMemo } from "react";

import { useActions, useTypedRedux } from "@cocalc/frontend/app-framework";
import {
  ProjectContext,
  type ProjectContextState,
  emptyProjectContext,
} from "@cocalc/frontend/project/context";
import { LazyRootFilesystemImageModal } from "@cocalc/frontend/project/settings/lazy-root-filesystem-image-modal";

interface Props {
  onClose: () => void;
  open: boolean;
  project_id: string;
}

export function ProjectRootfsRuntimeModalContent({
  onClose,
  open,
  project_id,
}: Props) {
  const actions = useActions({ project_id });
  const project = useTypedRedux("projects", "project_map")?.get(project_id);
  const context = useMemo(
    (): ProjectContextState => ({
      ...emptyProjectContext,
      actions,
      project: project as ProjectContextState["project"],
      project_id,
    }),
    [actions, project, project_id],
  );

  return (
    <ProjectContext.Provider value={context}>
      <LazyRootFilesystemImageModal onClose={onClose} open={open} />
    </ProjectContext.Provider>
  );
}
