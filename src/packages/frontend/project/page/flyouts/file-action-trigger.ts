/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { FileAction } from "@cocalc/frontend/project_actions";
import { triggerFileAction } from "@cocalc/frontend/project/file-action-trigger";

export function triggerFlyoutFileAction({
  actions,
  action,
  path,
  multiple,
}: {
  actions?: {
    set_active_tab: (tab: string) => void;
    set_file_action: (action: FileAction) => void;
    set_all_files_unchecked: () => void;
    set_file_list_checked: (paths: string[]) => void;
    showFileActionPanel?: (opts: { path: string; action: FileAction }) => void;
  } | null;
  action: FileAction;
  path: string;
  multiple: boolean;
}): void {
  triggerFileAction({
    actions,
    action,
    path,
    multiple,
    activateFilesTab: true,
  });
}
