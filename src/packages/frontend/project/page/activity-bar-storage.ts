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

export interface ActivityBarLegacySettings {
  collapsed?: any;
  labels?: any;
  order?: any;
  hidden?: any;
}

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

function hasStoredValue(key: ActivityBarStorageKey): boolean {
  return LS.exists(STORAGE_KEYS[key]);
}

function normalizeBoolean(value: any, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

export function readActivityBarPreferences(opts?: {
  liteMode?: boolean;
  legacy?: ActivityBarLegacySettings;
}): ActivityBarPreferences {
  const liteMode = opts?.liteMode === true;
  const legacy = opts?.legacy;
  const orderSource = hasStoredValue("order")
    ? getStoredValue<any>("order")
    : legacy?.order;
  const hiddenSource = hasStoredValue("hidden")
    ? getStoredValue<any>("hidden")
    : legacy?.hidden;
  const collapsedSource = hasStoredValue("collapsed")
    ? getStoredValue<any>("collapsed")
    : legacy?.collapsed;
  const labelsSource = hasStoredValue("labels")
    ? getStoredValue<any>("labels")
    : legacy?.labels;

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

function migrateLegacyPreferences(opts?: {
  liteMode?: boolean;
  legacy?: ActivityBarLegacySettings;
}): boolean {
  const liteMode = opts?.liteMode === true;
  const legacy = opts?.legacy;
  if (legacy == null) return false;
  let changed = false;

  if (!hasStoredValue("collapsed") && legacy.collapsed != null) {
    LS.set(STORAGE_KEYS.collapsed, normalizeBoolean(legacy.collapsed, false));
    changed = true;
  }
  if (!hasStoredValue("labels") && legacy.labels != null) {
    LS.set(
      STORAGE_KEYS.labels,
      normalizeBoolean(legacy.labels, ACTIVITY_BAR_LABELS_DEFAULT),
    );
    changed = true;
  }
  if (!hasStoredValue("order") && legacy.order != null) {
    LS.set(
      STORAGE_KEYS.order,
      normalizeFixedTabOrder(legacy.order, { liteMode }),
    );
    changed = true;
  }
  if (!hasStoredValue("hidden") && legacy.hidden != null) {
    LS.set(
      STORAGE_KEYS.hidden,
      normalizeHiddenFixedTabs(legacy.hidden, { liteMode }),
    );
    changed = true;
  }
  if (changed) {
    emitActivityBarStorageChanged();
  }
  return changed;
}

export function getActivityBarCollapsed(opts?: { legacy?: any }): boolean {
  return readActivityBarPreferences({
    legacy: { collapsed: opts?.legacy },
  }).collapsed;
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
  legacy?: ActivityBarLegacySettings;
}): ActivityBarPreferences {
  const [version, setVersion] = useState(0);
  const liteMode = opts?.liteMode === true;
  const legacyCollapsed = opts?.legacy?.collapsed;
  const legacyLabels = opts?.legacy?.labels;
  const legacyOrder = opts?.legacy?.order;
  const legacyHidden = opts?.legacy?.hidden;

  useEffect(() => subscribe(() => setVersion((current) => current + 1)), []);

  useEffect(() => {
    if (
      migrateLegacyPreferences({
        liteMode,
        legacy: {
          collapsed: legacyCollapsed,
          labels: legacyLabels,
          order: legacyOrder,
          hidden: legacyHidden,
        },
      })
    ) {
      setVersion((current) => current + 1);
    }
  }, [legacyCollapsed, legacyHidden, legacyLabels, legacyOrder, liteMode]);

  return useMemo(
    () =>
      readActivityBarPreferences({
        liteMode,
        legacy: {
          collapsed: legacyCollapsed,
          labels: legacyLabels,
          order: legacyOrder,
          hidden: legacyHidden,
        },
      }),
    [
      legacyCollapsed,
      legacyHidden,
      legacyLabels,
      legacyOrder,
      liteMode,
      version,
    ],
  );
}
