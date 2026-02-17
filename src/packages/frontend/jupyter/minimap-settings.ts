/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const MINIMAP_SETTINGS_CHANGED_EVENT =
  "cocalc-jupyter-minimap-settings-changed";
export const MINIMAP_OPEN_SETTINGS_EVENT = "cocalc-jupyter-open-minimap-settings";

export const MINIMAP_DEFAULT_ENABLED = true;
export const MINIMAP_DEFAULT_WIDTH = 120;
export const MINIMAP_MIN_WIDTH = 48;
export const MINIMAP_MAX_WIDTH = 220;

const MINIMAP_OVERRIDE_STORAGE_KEYS = [
  "cocalc_jupyter_minimap",
  "jupyter_minimap",
] as const;
const MINIMAP_WIDTH_OVERRIDE_STORAGE_KEYS = [
  "cocalc_jupyter_minimap_width",
  "jupyter_minimap_width",
] as const;

export interface MinimapSettings {
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
  return clampMinimapWidth(n);
}

export function clampMinimapWidth(width: number): number {
  return Math.max(MINIMAP_MIN_WIDTH, Math.min(MINIMAP_MAX_WIDTH, Math.round(width)));
}

function readEnabledFromStorage(): boolean {
  if (typeof window === "undefined") return MINIMAP_DEFAULT_ENABLED;
  const storage = window.localStorage;
  if (storage != null) {
    for (const key of MINIMAP_OVERRIDE_STORAGE_KEYS) {
      const override = parseBooleanOverride(storage.getItem(key));
      if (override != null) return override;
    }
  }
  return MINIMAP_DEFAULT_ENABLED;
}

function readWidthFromStorage(): number {
  if (typeof window === "undefined") return MINIMAP_DEFAULT_WIDTH;
  const storage = window.localStorage;
  if (storage != null) {
    for (const key of MINIMAP_WIDTH_OVERRIDE_STORAGE_KEYS) {
      const override = parseNumberOverride(storage.getItem(key));
      if (override != null) return override;
    }
  }
  return MINIMAP_DEFAULT_WIDTH;
}

function readEnabledFromUrl(): boolean | undefined {
  if (typeof window === "undefined") return;
  return parseBooleanOverride(
    new URLSearchParams(window.location.search).get("jupyter_minimap"),
  );
}

function readWidthFromUrl(): number | undefined {
  if (typeof window === "undefined") return;
  return parseNumberOverride(
    new URLSearchParams(window.location.search).get("jupyter_minimap_width"),
  );
}

export function readMinimapSettings(): MinimapSettings {
  const urlEnabled = readEnabledFromUrl();
  const urlWidth = readWidthFromUrl();
  const enabled =
    urlEnabled != null ? urlEnabled : readEnabledFromStorage();
  const width = urlWidth != null ? urlWidth : readWidthFromStorage();
  return { enabled, width };
}

function dispatchSettingsChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(MINIMAP_SETTINGS_CHANGED_EVENT));
}

export function setMinimapEnabled(enabled: boolean): MinimapSettings {
  if (typeof window !== "undefined") {
    const value = enabled ? "1" : "0";
    for (const key of MINIMAP_OVERRIDE_STORAGE_KEYS) {
      window.localStorage.setItem(key, value);
    }
    dispatchSettingsChanged();
  }
  return readMinimapSettings();
}

export function toggleMinimapEnabled(): MinimapSettings {
  const current = readMinimapSettings();
  return setMinimapEnabled(!current.enabled);
}

export function setMinimapWidth(width: number): MinimapSettings {
  if (typeof window !== "undefined") {
    const value = String(clampMinimapWidth(width));
    for (const key of MINIMAP_WIDTH_OVERRIDE_STORAGE_KEYS) {
      window.localStorage.setItem(key, value);
    }
    dispatchSettingsChanged();
  }
  return readMinimapSettings();
}

export function adjustMinimapWidth(delta: number): MinimapSettings {
  const current = readMinimapSettings();
  return setMinimapWidth(current.width + delta);
}

export function openMinimapSettingsDialog(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(MINIMAP_OPEN_SETTINGS_EVENT));
}
