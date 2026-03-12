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

interface FlyoutNavigation extends NavigationHistory {
  flyoutPath: string;
  flyoutHistory: string;
  navigateFlyout: (path: string) => void;
}

export function useFlyoutNavigation(project_id: string): FlyoutNavigation {
  const current_path_abs =
    useTypedRedux({ project_id }, "current_path_abs") ?? "/";
  const flyout_browsing_path_abs = useTypedRedux(
    { project_id },
    "flyout_browsing_path_abs",
  );
  const flyout_history_path_abs = useTypedRedux(
    { project_id },
    "flyout_history_path_abs",
  );

  const flyoutPath = flyout_browsing_path_abs ?? current_path_abs;
  const flyoutHistory = flyout_history_path_abs ?? flyoutPath;

  const navigateFlyoutRaw = useCallback(
    (path: string) => {
      navigateBrowsingPath(
        project_id,
        path,
        flyoutHistory,
        "flyout_browsing_path_abs",
        "flyout_history_path_abs",
      );
    },
    [flyoutHistory, project_id],
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
