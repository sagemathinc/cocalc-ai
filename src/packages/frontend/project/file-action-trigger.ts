/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { FileAction } from "@cocalc/frontend/project_actions";

type ProjectActionLike = {
  set_active_tab?: (tab: string) => void;
  set_file_action: (action: FileAction) => void;
  set_all_files_unchecked: () => void;
  set_file_list_checked: (paths: string[]) => void;
  showFileActionPanel?: (opts: { path: string; action: FileAction }) => void;
};

export function triggerFileAction({
  actions,
  action,
  path,
  multiple,
  activateFilesTab = false,
}: {
  actions?: ProjectActionLike | null;
  action: FileAction;
  path: string;
  multiple: boolean;
  activateFilesTab?: boolean;
}): void {
  if (!actions) return;
  if (!multiple && typeof actions.showFileActionPanel === "function") {
    actions.showFileActionPanel({ path, action });
    return;
  }
  actions.set_all_files_unchecked();
  actions.set_file_list_checked([path]);
  if (activateFilesTab) {
    actions.set_active_tab?.("files");
  }
  actions.set_file_action(action);
}
