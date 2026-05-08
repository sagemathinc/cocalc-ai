/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { EDITOR_PREFIX, tab_to_path } from "@cocalc/util/misc";

type OpenFilesLike = {
  getIn?: (path: readonly string[]) => any;
  has?: (path: string) => boolean;
};

export function getRecoverableActiveEditorPath({
  isActive,
  activeTopTab,
  projectId,
  activeProjectTab,
  openFiles,
}: {
  isActive: boolean;
  activeTopTab?: string;
  projectId: string;
  activeProjectTab?: string;
  openFiles?: OpenFilesLike | null;
}): string | undefined {
  if (!isActive || activeTopTab !== projectId) {
    return undefined;
  }
  if (
    typeof activeProjectTab !== "string" ||
    !activeProjectTab.startsWith(EDITOR_PREFIX)
  ) {
    return undefined;
  }
  const path = tab_to_path(activeProjectTab);
  if (!path || openFiles?.has?.(path) !== true) {
    return undefined;
  }
  const component = openFiles?.getIn?.([path, "component"]);
  return component?.Editor == null ? path : undefined;
}
