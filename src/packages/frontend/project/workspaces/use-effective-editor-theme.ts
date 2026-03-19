/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useMemo, useRedux } from "@cocalc/frontend/app-framework";
import { effectiveEditorThemeName } from "./editor-theme";
import { useWorkspaceRecordForPath } from "./use-workspace-record";

export function useEffectiveEditorThemeForPath(
  project_id?: string,
  path?: string | null,
): string | null {
  const editorSettings = useRedux(["account", "editor_settings"]);
  const workspaceRecord = useWorkspaceRecordForPath(project_id, path);
  return useMemo(
    () => effectiveEditorThemeName(editorSettings, workspaceRecord),
    [editorSettings, workspaceRecord],
  );
}
