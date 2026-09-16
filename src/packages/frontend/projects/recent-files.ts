/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { EventRecordMap } from "@cocalc/frontend/project/history/types";
import { projectLogTimeValue } from "@cocalc/frontend/project/log-state";

export interface OpenedFile {
  filename: string;
  time: Date;
  account_id: string;
}

// Shared with Quick Navigation when combining already loaded project logs.
export function recentFilesFromLog(
  project_log: any,
  max = 100,
  searchTerm = "",
): OpenedFile[] {
  if (project_log == null || max === 0) return [];

  const dedupe: string[] = [];

  return project_log
    .valueSeq()
    .filter(
      (entry: EventRecordMap) =>
        entry.getIn(["event", "filename"]) &&
        entry.getIn(["event", "event"]) === "open",
    )
    .sort((a, b) => projectLogTimeValue(b) - projectLogTimeValue(a))
    .filter((entry: EventRecordMap) => {
      const fn = entry.getIn(["event", "filename"]);
      if (dedupe.includes(fn)) return false;
      dedupe.push(fn);
      return true;
    })
    .filter((entry: EventRecordMap) =>
      entry
        .getIn(["event", "filename"], "")
        .toLowerCase()
        .includes(searchTerm.toLowerCase()),
    )
    .slice(0, max)
    .map((entry: EventRecordMap) => ({
      filename: entry.getIn(["event", "filename"]),
      time: entry.get("time"),
      account_id: entry.get("account_id"),
    }))
    .toJS() as OpenedFile[];
}
