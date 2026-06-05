/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export function normalizeMentionSearch(value: string): string {
  let search = value.trim();
  while (search.startsWith("@")) {
    search = search.slice(1).trimStart();
  }
  return search.toLowerCase();
}
