/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export function retainTab<T extends string>(
  tabs: readonly T[],
  tab: T | null | undefined,
): readonly T[] {
  if (tab == null || tabs.includes(tab)) {
    return tabs;
  }
  return [...tabs, tab];
}
