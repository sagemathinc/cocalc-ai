/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { ActiveFileSort } from "@cocalc/frontend/project_store";

const VALID_SORT_COLUMNS = new Set(["name", "time", "size", "type"]);

export const DEFAULT_ACTIVE_FILE_SORT: ActiveFileSort = {
  column_name: "name",
  is_descending: false,
};

export function normalizeActiveFileSort(value: unknown): ActiveFileSort {
  const sort = (value as any)?.toJS?.() ?? value;
  const column_name = (sort as any)?.column_name;
  if (!VALID_SORT_COLUMNS.has(column_name)) {
    return DEFAULT_ACTIVE_FILE_SORT;
  }
  return {
    column_name,
    is_descending: !!(sort as any)?.is_descending,
  };
}
