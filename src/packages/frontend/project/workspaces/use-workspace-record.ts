/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useMemo, useState } from "react";
import type { WorkspaceRecord } from "./types";
import {
  resolveRuntimeWorkspaceForPath,
  WORKSPACE_RECORDS_EVENT,
} from "./records-runtime";

export function useWorkspaceRecordForPath(
  project_id?: string,
  path?: string | null,
): WorkspaceRecord | null {
  const normalizedProjectId = `${project_id ?? ""}`.trim();
  const normalizedPath = `${path ?? ""}`.trim();
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onChange = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          project_id?: string;
        }>
      ).detail;
      if (
        normalizedProjectId &&
        `${detail?.project_id ?? ""}` !== normalizedProjectId
      ) {
        return;
      }
      setVersion((current) => current + 1);
    };
    window.addEventListener(WORKSPACE_RECORDS_EVENT, onChange as EventListener);
    return () => {
      window.removeEventListener(
        WORKSPACE_RECORDS_EVENT,
        onChange as EventListener,
      );
    };
  }, [normalizedProjectId]);

  return useMemo(() => {
    if (!normalizedProjectId || !normalizedPath) {
      return null;
    }
    return resolveRuntimeWorkspaceForPath(normalizedProjectId, normalizedPath);
  }, [normalizedProjectId, normalizedPath, version]);
}
