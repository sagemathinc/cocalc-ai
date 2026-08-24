/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Shared persistence layer for the minimaps.

Both the notebook minimap and the code-editor minimap store the same
preferences (enabled, kind, and a width per kind) in localStorage and broadcast
changes over custom window events, so the actual logic lives here once and each
caller only supplies its storage keys / event names / defaults.

"kind" selects between the two renderings:
  - "text"     : tiny rendering of the actual document text on a canvas
  - "stylized" : one bar per logical block (notebook cell / paragraph), i.e. an
                 outline of the document rather than its text

The two kinds keep separate widths: the stylized map carries no text, so it
wants to be much narrower than the text one.
*/

import { useEffect, useState } from "react";

/**
 * Fired in addition to each instance's own event, so UI that is not tied to
 * one particular minimap — the frame title bar, which has to re-render for its
 * Minimap menu to show the current state — can subscribe once.
 */
export const MINIMAP_ANY_SETTINGS_CHANGED_EVENT =
  "cocalc-minimap-settings-changed";

export type MinimapKind = "text" | "stylized";

export const MINIMAP_KINDS: MinimapKind[] = ["text", "stylized"];

export interface MinimapWidthSpec {
  default: number;
  min: number;
  max: number;
}

export interface MinimapSettings {
  enabled: boolean;
  kind: MinimapKind;
  // width of the currently selected kind — what a renderer should use
  width: number;
  widths: Record<MinimapKind, number>;
}

export interface MinimapSettingsSpec {
  // localStorage keys; kept distinct per minimap so notebooks and code
  // editors can be configured independently.
  enabledKey: string;
  kindKey: string;
  widthKeys: Record<MinimapKind, string>;
  changedEvent: string;
  openSettingsEvent: string;
  defaultEnabled: boolean;
  defaultKind: MinimapKind;
  widths: Record<MinimapKind, MinimapWidthSpec>;
}

export interface MinimapSettingsApi {
  spec: MinimapSettingsSpec;
  read(): MinimapSettings;
  clampWidth(width: number, kind?: MinimapKind): number;
  setEnabled(enabled: boolean): MinimapSettings;
  toggleEnabled(): MinimapSettings;
  /** Set the width of `kind`, defaulting to the kind currently in use. */
  setWidth(width: number, kind?: MinimapKind): MinimapSettings;
  adjustWidth(delta: number, kind?: MinimapKind): MinimapSettings;
  setKind(kind: MinimapKind): MinimapSettings;
  toggleKind(): MinimapSettings;
  openSettingsDialog(): void;
}

function parseBooleanOverride(raw: string | null): boolean | undefined {
  if (raw == null) return;
  const value = raw.trim().toLowerCase();
  if (value === "1" || value === "true" || value === "on" || value === "yes") {
    return true;
  }
  if (value === "0" || value === "false" || value === "off" || value === "no") {
    return false;
  }
}

function parseKindOverride(raw: string | null): MinimapKind | undefined {
  if (raw == null) return;
  const value = raw.trim().toLowerCase();
  if (value === "text" || value === "stylized") return value;
}

function getStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage ?? null;
  } catch {
    // e.g. storage disabled by browser settings
    return null;
  }
}

export function createMinimapSettings(
  spec: MinimapSettingsSpec,
): MinimapSettingsApi {
  function clampWidth(width: number, kind: MinimapKind = "text"): number {
    const range = spec.widths[kind];
    if (!Number.isFinite(width)) return range.default;
    return Math.max(range.min, Math.min(range.max, Math.round(width)));
  }

  function readWidth(storage: Storage | null, kind: MinimapKind): number {
    const raw = storage?.getItem(spec.widthKeys[kind]);
    if (raw == null) return spec.widths[kind].default;
    const n = Number(raw.trim());
    if (!Number.isFinite(n)) return spec.widths[kind].default;
    return clampWidth(n, kind);
  }

  function read(): MinimapSettings {
    const storage = getStorage();
    const enabled =
      parseBooleanOverride(storage?.getItem(spec.enabledKey) ?? null) ??
      spec.defaultEnabled;
    const kind =
      parseKindOverride(storage?.getItem(spec.kindKey) ?? null) ??
      spec.defaultKind;
    const widths = {
      text: readWidth(storage, "text"),
      stylized: readWidth(storage, "stylized"),
    };
    return { enabled, kind, width: widths[kind], widths };
  }

  function dispatchSettingsChanged(): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(spec.changedEvent));
    window.dispatchEvent(new CustomEvent(MINIMAP_ANY_SETTINGS_CHANGED_EVENT));
  }

  function write(key: string, value: string): MinimapSettings {
    const storage = getStorage();
    if (storage != null) {
      storage.setItem(key, value);
      dispatchSettingsChanged();
    }
    return read();
  }

  function writeWidth(width: number, kind?: MinimapKind): MinimapSettings {
    const target = kind ?? read().kind;
    return write(spec.widthKeys[target], String(clampWidth(width, target)));
  }

  return {
    spec,
    read,
    clampWidth,
    setEnabled: (enabled) => write(spec.enabledKey, enabled ? "1" : "0"),
    toggleEnabled: () => write(spec.enabledKey, read().enabled ? "0" : "1"),
    setWidth: (width, kind) => writeWidth(width, kind),
    adjustWidth: (delta, kind) => {
      const current = read();
      const target = kind ?? current.kind;
      return writeWidth(current.widths[target] + delta, target);
    },
    setKind: (kind) => write(spec.kindKey, kind),
    toggleKind: () =>
      write(spec.kindKey, read().kind === "text" ? "stylized" : "text"),
    openSettingsDialog: () => {
      if (typeof window === "undefined") return;
      window.dispatchEvent(new CustomEvent(spec.openSettingsEvent));
    },
  };
}

/** Subscribe to a minimap's settings, re-rendering whenever they change. */
export function useMinimapSettings(api: MinimapSettingsApi): MinimapSettings {
  const [settings, setSettings] = useState<MinimapSettings>(() => api.read());
  useEffect(() => {
    const sync = () => setSettings(api.read());
    sync();
    if (typeof window === "undefined") return;
    window.addEventListener(api.spec.changedEvent, sync);
    return () => window.removeEventListener(api.spec.changedEvent, sync);
  }, [api]);
  return settings;
}

/**
 * Re-render whenever any minimap preference changes.  Menus read the settings
 * straight from localStorage while they render, so without this their labels
 * and check marks would keep showing the state from the last unrelated render.
 */
export function useMinimapSettingsRevision(): number {
  const [revision, setRevision] = useState<number>(0);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const bump = () => setRevision((n) => n + 1);
    window.addEventListener(MINIMAP_ANY_SETTINGS_CHANGED_EVENT, bump);
    return () =>
      window.removeEventListener(MINIMAP_ANY_SETTINGS_CHANGED_EVENT, bump);
  }, []);
  return revision;
}
