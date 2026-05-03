/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useMemo } from "react";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import * as LS from "@cocalc/frontend/misc/local-storage-typed";
import {
  ACTIVITY_BAR_COLLAPSED,
  ACTIVITY_BAR_HIDDEN_TABS,
  ACTIVITY_BAR_LABELS,
  ACTIVITY_BAR_LABELS_DEFAULT,
  ACTIVITY_BAR_TAB_ORDER,
} from "./activity-bar-consts";
import {
  getDefaultHiddenFixedTabs,
  normalizeFixedTabOrder,
  normalizeHiddenFixedTabs,
} from "./activity-bar-preferences";
import type { FixedTab } from "./file-tab";

const STORAGE_KEYS = {
  collapsed: new LS.CustomKey(ACTIVITY_BAR_COLLAPSED),
  labels: new LS.CustomKey(ACTIVITY_BAR_LABELS),
  order: new LS.CustomKey(ACTIVITY_BAR_TAB_ORDER),
  hidden: new LS.CustomKey(ACTIVITY_BAR_HIDDEN_TABS),
} as const;

type ActivityBarStorageKey = keyof typeof STORAGE_KEYS;

export interface ActivityBarPreferences {
  collapsed: boolean;
  labels: boolean;
  order: FixedTab[];
  hidden: FixedTab[];
}

function getStoredValue<T>(key: ActivityBarStorageKey): T | undefined {
  return LS.get<T>(STORAGE_KEYS[key]);
}

function normalizeBoolean(value: any, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function setPagePreferenceState(
  patch: Partial<{
    activity_bar_collapsed: boolean;
    activity_bar_labels: boolean;
    activity_bar_order: FixedTab[];
    activity_bar_hidden: FixedTab[];
  }>,
): void {
  redux.getStore("page")?.setState(patch);
}

export function readActivityBarPreferences(opts?: {
  liteMode?: boolean;
}): ActivityBarPreferences {
  const liteMode = opts?.liteMode === true;
  const orderSource = getStoredValue<any>("order");
  const hiddenSource = getStoredValue<any>("hidden");
  const collapsedSource = getStoredValue<any>("collapsed");
  const labelsSource = getStoredValue<any>("labels");

  return {
    collapsed: normalizeBoolean(collapsedSource, false),
    labels: normalizeBoolean(labelsSource, ACTIVITY_BAR_LABELS_DEFAULT),
    order: normalizeFixedTabOrder(orderSource, { liteMode }),
    hidden:
      hiddenSource == null
        ? getDefaultHiddenFixedTabs({ liteMode })
        : normalizeHiddenFixedTabs(hiddenSource, { liteMode }),
  };
}

export function getActivityBarCollapsed(): boolean {
  const pageValue = redux.getStore("page")?.get("activity_bar_collapsed");
  if (typeof pageValue === "boolean") {
    return pageValue;
  }
  return readActivityBarPreferences().collapsed;
}

export function setActivityBarCollapsed(value: boolean): void {
  const next = !!value;
  LS.set(STORAGE_KEYS.collapsed, next);
  setPagePreferenceState({ activity_bar_collapsed: next });
}

export function setActivityBarLabels(value: boolean): void {
  const next = !!value;
  LS.set(STORAGE_KEYS.labels, next);
  setPagePreferenceState({ activity_bar_labels: next });
}

export function setActivityBarTabOrder(
  value: readonly FixedTab[],
  opts?: { liteMode?: boolean },
): void {
  const next = normalizeFixedTabOrder(value, {
    liteMode: opts?.liteMode === true,
  });
  LS.set(STORAGE_KEYS.order, next);
  setPagePreferenceState({ activity_bar_order: next });
}

export function setActivityBarHiddenTabs(
  value: readonly FixedTab[],
  opts?: { liteMode?: boolean },
): void {
  const next = normalizeHiddenFixedTabs(value, {
    liteMode: opts?.liteMode === true,
  });
  LS.set(STORAGE_KEYS.hidden, next);
  setPagePreferenceState({ activity_bar_hidden: next });
}

export function useActivityBarPreferences(opts?: {
  liteMode?: boolean;
}): ActivityBarPreferences {
  const liteMode = opts?.liteMode === true;
  const collapsedSource = useTypedRedux("page", "activity_bar_collapsed");
  const labelsSource = useTypedRedux("page", "activity_bar_labels");
  const orderSource = useTypedRedux("page", "activity_bar_order");
  const hiddenSource = useTypedRedux("page", "activity_bar_hidden");

  return useMemo(() => {
    const persisted = readActivityBarPreferences({ liteMode });
    return {
      collapsed: normalizeBoolean(collapsedSource, persisted.collapsed),
      labels: normalizeBoolean(labelsSource, persisted.labels),
      order: normalizeFixedTabOrder(orderSource ?? persisted.order, {
        liteMode,
      }),
      hidden:
        hiddenSource == null
          ? persisted.hidden
          : normalizeHiddenFixedTabs(hiddenSource, { liteMode }),
    };
  }, [collapsedSource, hiddenSource, labelsSource, liteMode, orderSource]);
}
