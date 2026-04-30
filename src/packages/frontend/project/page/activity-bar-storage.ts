/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useMemo, useState } from "react";
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

const ACTIVITY_BAR_STORAGE_EVENT = "cocalc:activity-bar-storage";

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

function emitActivityBarStorageChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(ACTIVITY_BAR_STORAGE_EVENT));
}

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }
  const handle = () => listener();
  window.addEventListener(ACTIVITY_BAR_STORAGE_EVENT, handle);
  window.addEventListener("storage", handle);
  return () => {
    window.removeEventListener(ACTIVITY_BAR_STORAGE_EVENT, handle);
    window.removeEventListener("storage", handle);
  };
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
  return readActivityBarPreferences().collapsed;
}

export function setActivityBarCollapsed(value: boolean): void {
  LS.set(STORAGE_KEYS.collapsed, !!value);
  emitActivityBarStorageChanged();
}

export function setActivityBarLabels(value: boolean): void {
  LS.set(STORAGE_KEYS.labels, !!value);
  emitActivityBarStorageChanged();
}

export function setActivityBarTabOrder(
  value: readonly FixedTab[],
  opts?: { liteMode?: boolean },
): void {
  LS.set(
    STORAGE_KEYS.order,
    normalizeFixedTabOrder(value, { liteMode: opts?.liteMode === true }),
  );
  emitActivityBarStorageChanged();
}

export function setActivityBarHiddenTabs(
  value: readonly FixedTab[],
  opts?: { liteMode?: boolean },
): void {
  LS.set(
    STORAGE_KEYS.hidden,
    normalizeHiddenFixedTabs(value, { liteMode: opts?.liteMode === true }),
  );
  emitActivityBarStorageChanged();
}

export function useActivityBarPreferences(opts?: {
  liteMode?: boolean;
}): ActivityBarPreferences {
  const [version, setVersion] = useState(0);
  const liteMode = opts?.liteMode === true;

  useEffect(() => subscribe(() => setVersion((current) => current + 1)), []);

  return useMemo(
    () => readActivityBarPreferences({ liteMode }),
    [liteMode, version],
  );
}
