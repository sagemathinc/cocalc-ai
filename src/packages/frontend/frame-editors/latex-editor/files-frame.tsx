/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { List, Map } from "immutable";
import { useEffect } from "react";
import { useRedux } from "@cocalc/frontend/app-framework";
import type { Actions } from "./actions";
import { OutputFiles } from "./output-files";

const EMPTY_FILES = List<string>();

// Shared by the standalone Files frame and the Output panel's Files tab.
export function LatexFiles({
  actions,
  font_size,
}: {
  actions: Actions;
  font_size: number;
}) {
  const files: List<string> =
    useRedux([actions.name, "switch_to_files"]) ?? EMPTY_FILES;
  const summaries = useRedux([actions.name, "file_summaries"]);
  const loading: boolean =
    useRedux([actions.name, "file_summaries_loading"]) ?? false;
  useEffect(() => {
    void actions.updateFileSummaries();
  }, [actions, files]);
  // Redux deep-converts nested values to Immutable Maps.
  const fileSummaries: Record<string, string> = Map.isMap(summaries)
    ? summaries.toJS()
    : (summaries ?? {});
  return (
    <OutputFiles
      switch_to_files={files}
      path={actions.path}
      actions={actions}
      uiFontSize={font_size}
      fileSummaries={fileSummaries}
      summariesLoading={loading}
      refreshSummaries={() => {
        void actions.updateFileSummaries(true);
      }}
    />
  );
}
