/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useCallback } from "react";

import { useTypedRedux } from "@cocalc/frontend/app-framework";
import {
  navigateBrowsingPath,
  normalizeBrowsingPath,
} from "@cocalc/frontend/project/explorer/navigate-browsing-path";
import {
  type NavigationHistory,
  useNavigationHistory,
} from "@cocalc/frontend/project/explorer/use-navigation-history";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { selectionForPathFollowThrough } from "@cocalc/frontend/project/workspaces/state";

interface FlyoutNavigation extends NavigationHistory {
  flyoutPath: string;
  flyoutHistory: string;
  navigateFlyout: (path: string) => void;
}

export function useFlyoutNavigation(project_id: string): FlyoutNavigation {
  const { workspaces } = useProjectContext();
  const current_path_abs =
    useTypedRedux({ project_id }, "current_path_abs") ?? "/";
  const history_path_abs =
    useTypedRedux({ project_id }, "history_path_abs") ?? current_path_abs;

  const flyoutPath = current_path_abs;
  const flyoutHistory = history_path_abs;

  const navigateFlyoutRaw = useCallback(
    (path: string) => {
      const normalizedPath = normalizeBrowsingPath(path);
      const nextSelection = selectionForPathFollowThrough(
        workspaces.selection,
        workspaces.records,
        normalizedPath,
      );
      workspaces.setSelection(nextSelection);
      setTimeout(() => workspaces.setSelection(nextSelection), 0);
      navigateBrowsingPath(project_id, normalizedPath);
    },
    [project_id, workspaces],
  );

  const navHistory = useNavigationHistory(
    project_id,
    flyoutPath,
    navigateFlyoutRaw,
    "flyout",
  );

  const navigateFlyout = useCallback(
    (path: string) => {
      const normalized = normalizeBrowsingPath(path);
      navigateFlyoutRaw(normalized);
      navHistory.recordNavigation(normalized);
    },
    [navHistory, navigateFlyoutRaw],
  );

  return {
    flyoutPath,
    flyoutHistory,
    navigateFlyout,
    ...navHistory,
  };
}
