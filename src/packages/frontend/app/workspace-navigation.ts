/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import {
  normalizeWorkspaceNavigation,
  WORKSPACE_NAVIGATION_SETTING,
  type WorkspaceNavigation,
} from "@cocalc/util/workspace-navigation";

export function useWorkspaceNavigation(): WorkspaceNavigation {
  const otherSettings = useTypedRedux("account", "other_settings");
  return normalizeWorkspaceNavigation(
    otherSettings?.get?.(WORKSPACE_NAVIGATION_SETTING),
  );
}

export function setWorkspaceNavigation(value: WorkspaceNavigation): void {
  redux
    .getActions("account")
    .set_other_settings(WORKSPACE_NAVIGATION_SETTING, value);
}
