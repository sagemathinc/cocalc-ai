/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useRef } from "react";

export function newestFileTimestampMs(stat: any): number {
  let newest = 0;
  for (const field of [
    "mtimeMs",
    "ctimeMs",
    "birthtimeMs",
    "mtime",
    "ctime",
    "birthtime",
  ]) {
    const value = stat?.[field];
    const ms =
      value instanceof Date
        ? value.valueOf()
        : typeof value === "number"
          ? value
          : NaN;
    if (Number.isFinite(ms)) {
      newest = Math.max(newest, ms);
    }
  }
  return newest;
}

export function useReloadFileWhenVisible({
  is_visible,
  path,
  stat,
  reload,
}: {
  is_visible?: boolean;
  path: string;
  stat?: (path: string) => Promise<any>;
  reload: () => void;
}) {
  const lastTimestampRef = useRef<number | undefined>(undefined);
  const checkIdRef = useRef(0);

  useEffect(() => {
    if (!is_visible || typeof stat !== "function") return;
    const statFile = stat;
    const checkId = ++checkIdRef.current;

    async function check() {
      try {
        const timestamp = newestFileTimestampMs(await statFile(path));
        if (!timestamp || checkIdRef.current !== checkId) return;
        const lastTimestamp = lastTimestampRef.current;
        lastTimestampRef.current = timestamp;
        if (lastTimestamp != null && timestamp !== lastTimestamp) {
          reload();
        }
      } catch {
        // If stat is temporarily unavailable, keep the current rendered file.
      }
    }

    void check();
  }, [is_visible, path, reload, stat]);
}
