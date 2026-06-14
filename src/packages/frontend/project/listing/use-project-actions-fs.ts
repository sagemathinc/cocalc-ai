/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { redux } from "@cocalc/frontend/app-framework";
import type { FilesystemClient } from "@cocalc/conat/files/fs";

type ProjectActionsWithFilesystem =
  | {
      fs?: () => FilesystemClient;
    }
  | null
  | undefined;

export default function useProjectActionsFilesystem({
  actions,
  project_id,
}: {
  actions: ProjectActionsWithFilesystem;
  project_id: string;
}): FilesystemClient | null {
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const [retry, setRetry] = useState(0);
  const ref = useRef<{
    project_id: string;
    fs: FilesystemClient | null;
  } | null>(null);

  const fs = useMemo(() => {
    if (ref.current?.project_id === project_id && ref.current.fs != null) {
      return ref.current.fs;
    }
    const source =
      actionsRef.current?.fs != null
        ? actionsRef.current
        : redux.getProjectActions(project_id);
    const fs = source?.fs?.() ?? null;
    ref.current = { project_id, fs };
    return fs;
  }, [project_id, retry]);

  useEffect(() => {
    if (fs != null) {
      return;
    }
    const timer = setTimeout(() => setRetry((value) => value + 1), 250);
    return () => clearTimeout(timer);
  }, [fs, project_id, retry]);

  return fs;
}
