import { useSyncExternalStore } from "react";

export interface DiffViewPreferences {
  split: boolean;
  wrap: boolean;
  treeVisible: boolean;
  treeWidth: number;
}

const KEY = "cocalc:diff-view-preferences:v1";
const EVENT = "cocalc:diff-view-preferences";
const DEFAULTS: DiffViewPreferences = {
  split: false,
  wrap: true,
  treeVisible: true,
  treeWidth: 260,
};
const DEFAULT_SNAPSHOT = JSON.stringify(DEFAULTS);
let unavailableStorageSnapshot = DEFAULT_SNAPSHOT;
let pendingSnapshot: string | undefined;

export function readDiffViewPreferences(
  raw: string | null,
): DiffViewPreferences {
  try {
    const value = JSON.parse(raw ?? "null");
    return {
      split: typeof value?.split === "boolean" ? value.split : DEFAULTS.split,
      wrap: typeof value?.wrap === "boolean" ? value.wrap : DEFAULTS.wrap,
      treeVisible:
        typeof value?.treeVisible === "boolean"
          ? value.treeVisible
          : DEFAULTS.treeVisible,
      treeWidth:
        typeof value?.treeWidth === "number" && Number.isFinite(value.treeWidth)
          ? Math.max(180, Math.min(400, Math.round(value.treeWidth / 20) * 20))
          : DEFAULTS.treeWidth,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function snapshot(): string {
  if (typeof window === "undefined") return DEFAULT_SNAPSHOT;
  if (pendingSnapshot != null) return pendingSnapshot;
  try {
    return localStorage.getItem(KEY) ?? DEFAULT_SNAPSHOT;
  } catch {
    return unavailableStorageSnapshot;
  }
}

function subscribe(notify: () => void): () => void {
  const storage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) {
      pendingSnapshot = undefined;
      notify();
    }
  };
  window.addEventListener("storage", storage);
  window.addEventListener(EVENT, notify);
  return () => {
    window.removeEventListener("storage", storage);
    window.removeEventListener(EVENT, notify);
  };
}

export function setDiffViewPreference<K extends keyof DiffViewPreferences>(
  key: K,
  value: DiffViewPreferences[K],
): void {
  const next = { ...readDiffViewPreferences(snapshot()), [key]: value };
  unavailableStorageSnapshot = JSON.stringify(next);
  try {
    localStorage.setItem(KEY, unavailableStorageSnapshot);
    pendingSnapshot = undefined;
  } catch {
    pendingSnapshot = unavailableStorageSnapshot;
    /* Keep preferences usable in memory when storage is unavailable. */
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT));
}

// One device-level view preference across diff surfaces; never part of a review
// record. Updating another mounted surface must not recreate its editor session.
export function useDiffViewPreferences(): DiffViewPreferences {
  return readDiffViewPreferences(
    useSyncExternalStore(subscribe, snapshot, () => DEFAULT_SNAPSHOT),
  );
}
