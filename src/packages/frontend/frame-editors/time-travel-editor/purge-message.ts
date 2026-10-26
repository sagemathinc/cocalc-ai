/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { PurgeHistoryResult } from "@cocalc/conat/hub/api/sync";

// What a purge reports. A history still being counted (H1c) gives only a
// lower bound, which must not read as the exact number.
export function purgeHistoryMessage({
  deleted,
  deletedExact,
}: Pick<PurgeHistoryResult, "deleted" | "deletedExact">): string {
  if (deletedExact === false) {
    return `Purged more than ${deleted.toLocaleString("en-US")} history entries.`;
  }
  return `Purged ${deleted} history entries.`;
}
