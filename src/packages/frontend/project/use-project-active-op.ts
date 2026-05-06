/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProjectActiveOperationSummary } from "@cocalc/conat/hub/api/projects";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  createProjectFieldState,
  getCachedProjectFieldValue,
  useProjectField,
} from "./use-project-field";

const POLL_MS = 4000;

const activeOpFieldState =
  createProjectFieldState<ProjectActiveOperationSummary>("active_op");

export function useProjectActiveOperation(
  project_id: string,
  opts?: {
    pollWhile?: boolean;
  },
) {
  const [isVisible, setIsVisible] = useState<boolean>(() =>
    typeof document === "undefined"
      ? true
      : document.visibilityState === "visible",
  );
  const fetchActiveOp = useCallback(async (project_id0: string) => {
    try {
      return await webapp_client.conat_client.hub.projects.getProjectActiveOperation(
        {
          project_id: project_id0,
        },
      );
    } catch {
      return (
        getCachedProjectFieldValue({
          state: activeOpFieldState,
          project_id: project_id0,
        }) ?? null
      );
    }
  }, []);
  const {
    value: activeOp,
    refresh,
    setValue: setActiveOp,
  } = useProjectField({
    state: activeOpFieldState,
    project_id,
    projectMapField: "active_op",
    fetch: fetchActiveOp,
  });
  const shouldPoll = useMemo(
    () =>
      isVisible &&
      !!project_id &&
      !!(
        opts?.pollWhile ||
        (activeOp != null &&
          (activeOp.status === "queued" || activeOp.status === "running"))
      ),
    [activeOp, isVisible, opts?.pollWhile, project_id],
  );

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    const updateVisibility = () => {
      const visible = document.visibilityState === "visible";
      setIsVisible(visible);
      if (visible && project_id) {
        refresh();
      }
    };
    document.addEventListener("visibilitychange", updateVisibility);
    return () => {
      document.removeEventListener("visibilitychange", updateVisibility);
    };
  }, [project_id, refresh]);

  useEffect(() => {
    if (!shouldPoll) {
      return;
    }
    const timer = window.setInterval(() => {
      refresh();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh, shouldPoll]);

  useEffect(() => {
    if (!project_id || !isVisible) {
      return;
    }
    const handleReconnect = () => {
      refresh();
    };
    webapp_client.conat_client.on?.("connected", handleReconnect);
    return () => {
      webapp_client.conat_client.removeListener?.("connected", handleReconnect);
    };
  }, [isVisible, project_id, refresh]);

  return {
    activeOp,
    refresh,
    setActiveOp,
  };
}
