/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { DStream } from "@cocalc/conat/sync/dstream";
import type {
  ProjectLogCursor,
  ProjectLogPage,
  ProjectLogRow,
} from "@cocalc/conat/hub/api/projects";

export function normalizeProjectLogTime(value: unknown): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(`${value}`);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function normalizeProjectLogCursor(
  cursor?: ProjectLogCursor,
): ProjectLogCursor | undefined {
  if (!cursor?.id) return;
  return {
    id: `${cursor.id}`,
    time: normalizeProjectLogTime(cursor.time),
  };
}

export function compareProjectLogRows(
  a: ProjectLogRow,
  b: ProjectLogRow,
): number {
  const at = normalizeProjectLogTime(a.time)?.getTime() ?? 0;
  const bt = normalizeProjectLogTime(b.time)?.getTime() ?? 0;
  if (at !== bt) return bt - at;
  return `${b.id}`.localeCompare(`${a.id}`);
}

export function projectLogCursorKey(
  cursor?: ProjectLogCursor,
): [number, string] | null {
  if (!cursor?.id) return null;
  return [normalizeProjectLogTime(cursor.time)?.getTime() ?? 0, `${cursor.id}`];
}

export function filterProjectLogRows(
  rows: ProjectLogRow[],
  opts: {
    newer_than?: ProjectLogCursor;
    older_than?: ProjectLogCursor;
  },
): ProjectLogRow[] {
  const newerKey = projectLogCursorKey(
    normalizeProjectLogCursor(opts.newer_than),
  );
  const olderKey = projectLogCursorKey(
    normalizeProjectLogCursor(opts.older_than),
  );
  return rows.filter((row) => {
    const key: [number, string] = [
      normalizeProjectLogTime(row.time)?.getTime() ?? 0,
      `${row.id}`,
    ];
    if (
      newerKey != null &&
      (key[0] < newerKey[0] ||
        (key[0] === newerKey[0] && key[1] <= newerKey[1]))
    ) {
      return false;
    }
    if (
      olderKey != null &&
      (key[0] > olderKey[0] ||
        (key[0] === olderKey[0] && key[1] >= olderKey[1]))
    ) {
      return false;
    }
    return true;
  });
}

export function buildProjectLogRowsFromStream(
  stream: Pick<DStream<ProjectLogRow>, "getAll" | "time">,
  project_id: string,
): ProjectLogRow[] {
  const seen: Record<string, true> = {};
  return stream
    .getAll()
    .map(
      (row, index): ProjectLogRow => ({
        id: `${row?.id ?? ""}`,
        project_id: `${row?.project_id ?? project_id}`,
        account_id: `${row?.account_id ?? ""}`,
        time: normalizeProjectLogTime(row?.time) ?? stream.time(index) ?? null,
        event: row?.event ?? {},
      }),
    )
    .filter((row) => row.id && row.account_id)
    .sort(compareProjectLogRows)
    .filter((row) => {
      if (seen[row.id]) {
        return false;
      }
      seen[row.id] = true;
      return true;
    });
}

export function pageProjectLogRows(
  rows: ProjectLogRow[],
  opts: {
    limit: number;
    newer_than?: ProjectLogCursor;
    older_than?: ProjectLogCursor;
  },
): ProjectLogPage {
  const entries = filterProjectLogRows(rows, opts);
  return {
    entries: entries.slice(0, opts.limit),
    has_more: entries.length > opts.limit,
  };
}
