/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { FIXED_PROJECT_TABS, type FixedTab } from "./file-tab";

const DEFAULT_ORDER: readonly FixedTab[] = [
  "workspaces",
  "agents",
  "files",
  "new",
  "search",
  "users",
  "settings",
  "active",
  "log",
  "servers",
  "info",
] as const;

const DEFAULT_HIDDEN: readonly FixedTab[] = [
  "active",
  "log",
  "servers",
  "info",
] as const;

function toTabNames(value: any): string[] {
  if (Array.isArray(value)) return value.map((item) => `${item ?? ""}`);
  if (typeof value?.valueSeq === "function") {
    return value
      .valueSeq()
      .toArray()
      .map((item) => `${item ?? ""}`);
  }
  if (typeof value?.toArray === "function") {
    return value.toArray().map((item) => `${item ?? ""}`);
  }
  if (value != null && typeof value === "object") {
    return Object.values(value).map((item) => `${item ?? ""}`);
  }
  return [];
}

function filterAvailable(
  tabs: readonly FixedTab[],
  liteMode: boolean,
): FixedTab[] {
  return tabs.filter((name) => !(liteMode && FIXED_PROJECT_TABS[name].noLite));
}

export function getDefaultFixedTabOrder(opts?: {
  liteMode?: boolean;
}): FixedTab[] {
  return filterAvailable(DEFAULT_ORDER, opts?.liteMode === true);
}

export function getDefaultHiddenFixedTabs(opts?: {
  liteMode?: boolean;
}): FixedTab[] {
  return filterAvailable(DEFAULT_HIDDEN, opts?.liteMode === true);
}

export function normalizeFixedTabOrder(
  value: any,
  opts?: { liteMode?: boolean },
): FixedTab[] {
  const available = getDefaultFixedTabOrder(opts);
  const allowed = new Set<FixedTab>(available);
  const raw = toTabNames(value);
  const ordered: FixedTab[] = [];
  for (const name of raw) {
    if (!allowed.has(name as FixedTab)) continue;
    const tab = name as FixedTab;
    if (ordered.includes(tab)) continue;
    ordered.push(tab);
  }
  for (const tab of available) {
    if (!ordered.includes(tab)) {
      ordered.push(tab);
    }
  }
  return ordered;
}

export function normalizeHiddenFixedTabs(
  value: any,
  opts?: { liteMode?: boolean },
): FixedTab[] {
  const available = new Set(getDefaultFixedTabOrder(opts));
  const raw = toTabNames(value);
  if (raw.length === 0) {
    return getDefaultHiddenFixedTabs(opts);
  }
  const hidden: FixedTab[] = [];
  for (const name of raw) {
    if (!available.has(name as FixedTab)) continue;
    const tab = name as FixedTab;
    if (hidden.includes(tab)) continue;
    hidden.push(tab);
  }
  return hidden;
}

export function splitRailTabs(
  order: readonly FixedTab[],
  hidden: readonly FixedTab[],
): {
  visible: FixedTab[];
  overflow: FixedTab[];
} {
  const hiddenSet = new Set(hidden);
  return {
    visible: order.filter((name) => !hiddenSet.has(name)),
    overflow: order.filter((name) => hiddenSet.has(name)),
  };
}

export function moveFixedTab(
  order: readonly FixedTab[],
  oldIndex: number,
  newIndex: number,
): FixedTab[] {
  if (
    oldIndex < 0 ||
    newIndex < 0 ||
    oldIndex >= order.length ||
    newIndex >= order.length ||
    oldIndex === newIndex
  ) {
    return order.slice();
  }
  const next = order.slice();
  const [item] = next.splice(oldIndex, 1);
  next.splice(newIndex, 0, item);
  return next;
}
