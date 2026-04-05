/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Map, fromJS } from "immutable";

import type {
  EventRecordMap,
  ProjectLogMap,
} from "@cocalc/frontend/project/history/types";
import type {
  ProjectLogCursor,
  ProjectLogRow,
} from "@cocalc/conat/hub/api/projects";

export function projectLogTimeValue(entry: EventRecordMap): number {
  const time = entry.get("time");
  return time instanceof Date ? time.getTime() : 0;
}

export function compareProjectLogEntries(
  a: EventRecordMap,
  b: EventRecordMap,
): number {
  const timeDiff = projectLogTimeValue(a) - projectLogTimeValue(b);
  if (timeDiff !== 0) return timeDiff;
  const aid = `${a.get("id") ?? ""}`;
  const bid = `${b.get("id") ?? ""}`;
  if (aid < bid) return -1;
  if (aid > bid) return 1;
  return 0;
}

export function buildProjectLogEntry(row: ProjectLogRow): EventRecordMap {
  return fromJS({
    id: row.id,
    project_id: row.project_id,
    account_id: row.account_id,
    time: row.time,
    event: row.event ?? {},
  }) as unknown as EventRecordMap;
}

export function buildProjectLogMap(rows: ProjectLogRow[]): ProjectLogMap {
  let next = Map<string, EventRecordMap>().asMutable();
  for (const row of rows) {
    next = next.set(row.id, buildProjectLogEntry(row));
  }
  return next.asImmutable();
}

export function mergeProjectLogMap(
  existing: ProjectLogMap | undefined,
  rows: ProjectLogRow[],
): ProjectLogMap {
  let next = (existing ?? Map<string, EventRecordMap>()).asMutable();
  for (const row of rows) {
    next = next.set(row.id, buildProjectLogEntry(row));
  }
  return next.asImmutable();
}

export function newestProjectLogCursor(
  log?: ProjectLogMap,
): ProjectLogCursor | undefined {
  if (log == null || log.size === 0) return undefined;
  let newest: EventRecordMap | undefined;
  log.forEach((entry) => {
    if (newest == null || compareProjectLogEntries(entry, newest) > 0) {
      newest = entry;
    }
  });
  if (newest == null) return undefined;
  return {
    id: newest.get("id"),
    time: newest.get("time") ?? null,
  };
}

export function oldestProjectLogCursor(
  log?: ProjectLogMap,
): ProjectLogCursor | undefined {
  if (log == null || log.size === 0) return undefined;
  let oldest: EventRecordMap | undefined;
  log.forEach((entry) => {
    if (oldest == null || compareProjectLogEntries(entry, oldest) < 0) {
      oldest = entry;
    }
  });
  if (oldest == null) return undefined;
  return {
    id: oldest.get("id"),
    time: oldest.get("time") ?? null,
  };
}
