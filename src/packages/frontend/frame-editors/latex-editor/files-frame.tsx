/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { List } from "immutable";
import { useEffect, useState } from "react";

import { useRedux } from "@cocalc/frontend/app-framework";
import { project_api } from "@cocalc/frontend/frame-editors/generic/client";
import { getLogger } from "@cocalc/frontend/logger";

import type { Actions } from "./actions";
import { OutputFiles } from "./output-files";
import { useTexSummaries } from "./use-summarize";

const logger = getLogger("latex-files");
const EMPTY_FILES = List<string>();

// Shared by the standalone Files frame and the Output panel's Files tab.
export function LatexFiles({
  actions,
  font_size,
  reload,
}: {
  actions: Actions;
  font_size: number;
  reload?: number;
}) {
  const files: List<string> =
    useRedux([actions.name, "switch_to_files"]) ?? EMPTY_FILES;
  const [homeDir, setHomeDir] = useState<string | null>(null);
  const { project_id, path } = actions;

  useEffect(() => {
    let active = true;
    setHomeDir(null);
    async function loadHomeDirectory() {
      try {
        const api = await project_api(project_id);
        const dir = await api.getHomeDirectory();
        if (active) setHomeDir(dir);
      } catch (error) {
        logger.warn("Unable to load home directory for file summaries", error);
      }
    }
    void loadHomeDirectory();
    return () => {
      active = false;
    };
  }, [project_id]);

  const summaries = useTexSummaries(files, project_id, path, homeDir, reload);
  return (
    <OutputFiles
      switch_to_files={files}
      path={path}
      actions={actions}
      uiFontSize={font_size}
      {...summaries}
    />
  );
}
