/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const CODEMIRROR_MINIMAP_SETTINGS_CHANGED_EVENT =
  "cocalc-codemirror-minimap-settings-changed";
export const CODEMIRROR_MINIMAP_OPEN_SETTINGS_EVENT =
  "cocalc-codemirror-open-minimap-settings";

export const CODEMIRROR_MINIMAP_DEFAULT_ENABLED = true;
export const CODEMIRROR_MINIMAP_DEFAULT_WIDTH = 120;
export const CODEMIRROR_MINIMAP_MIN_WIDTH = 56;
export const CODEMIRROR_MINIMAP_MAX_WIDTH = 240;

const CODEMIRROR_MINIMAP_ENABLED_STORAGE_KEY = "cocalc_codemirror_minimap";
const CODEMIRROR_MINIMAP_WIDTH_STORAGE_KEY = "cocalc_codemirror_minimap_width";

export interface CodeMirrorMinimapSettings {
  enabled: boolean;
  width: number;
}

function parseBooleanOverride(raw: string | null): boolean | undefined {
  if (raw == null) return;
  const value = raw.trim().toLowerCase();
  if (
    value === "1" ||
    value === "true" ||
    value === "on" ||
    value === "yes"
  ) {
    return true;
  }
  if (
    value === "0" ||
    value === "false" ||
    value === "off" ||
    value === "no"
  ) {
    return false;
  }
}

function parseNumberOverride(raw: string | null): number | undefined {
  if (raw == null) return;
  const n = Number(raw.trim());
  if (!Number.isFinite(n)) return;
  return clampCodeMirrorMinimapWidth(n);
}

export function clampCodeMirrorMinimapWidth(width: number): number {
  return Math.max(
    CODEMIRROR_MINIMAP_MIN_WIDTH,
    Math.min(CODEMIRROR_MINIMAP_MAX_WIDTH, Math.round(width)),
  );
}

function readEnabledFromStorage(): boolean {
  if (typeof window === "undefined") return CODEMIRROR_MINIMAP_DEFAULT_ENABLED;
  const storage = window.localStorage;
  if (storage == null) return CODEMIRROR_MINIMAP_DEFAULT_ENABLED;
  const override = parseBooleanOverride(
    storage.getItem(CODEMIRROR_MINIMAP_ENABLED_STORAGE_KEY),
  );
  if (override != null) return override;
  return CODEMIRROR_MINIMAP_DEFAULT_ENABLED;
}

function readWidthFromStorage(): number {
  if (typeof window === "undefined") return CODEMIRROR_MINIMAP_DEFAULT_WIDTH;
  const storage = window.localStorage;
  if (storage == null) return CODEMIRROR_MINIMAP_DEFAULT_WIDTH;
  const override = parseNumberOverride(
    storage.getItem(CODEMIRROR_MINIMAP_WIDTH_STORAGE_KEY),
  );
  if (override != null) return override;
  return CODEMIRROR_MINIMAP_DEFAULT_WIDTH;
}

export function readCodeMirrorMinimapSettings(): CodeMirrorMinimapSettings {
  return {
    enabled: readEnabledFromStorage(),
    width: readWidthFromStorage(),
  };
}

function dispatchSettingsChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(CODEMIRROR_MINIMAP_SETTINGS_CHANGED_EVENT),
  );
}

export function setCodeMirrorMinimapEnabled(
  enabled: boolean,
): CodeMirrorMinimapSettings {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(
      CODEMIRROR_MINIMAP_ENABLED_STORAGE_KEY,
      enabled ? "1" : "0",
    );
    dispatchSettingsChanged();
  }
  return readCodeMirrorMinimapSettings();
}

export function toggleCodeMirrorMinimapEnabled(): CodeMirrorMinimapSettings {
  const current = readCodeMirrorMinimapSettings();
  return setCodeMirrorMinimapEnabled(!current.enabled);
}

export function setCodeMirrorMinimapWidth(
  width: number,
): CodeMirrorMinimapSettings {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(
      CODEMIRROR_MINIMAP_WIDTH_STORAGE_KEY,
      String(clampCodeMirrorMinimapWidth(width)),
    );
    dispatchSettingsChanged();
  }
  return readCodeMirrorMinimapSettings();
}

export function adjustCodeMirrorMinimapWidth(
  delta: number,
): CodeMirrorMinimapSettings {
  const current = readCodeMirrorMinimapSettings();
  return setCodeMirrorMinimapWidth(current.width + delta);
}

export function openCodeMirrorMinimapSettingsDialog(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CODEMIRROR_MINIMAP_OPEN_SETTINGS_EVENT));
}
