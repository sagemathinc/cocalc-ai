/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Persisted preferences for the notebook minimap.  The mechanics live in
// @cocalc/frontend/components/minimap/settings; this module only pins down the
// notebook's storage keys, events and defaults.

import {
  createMinimapSettings,
  type MinimapKind,
  type MinimapSettings,
  type MinimapSettingsApi,
} from "@cocalc/frontend/components/minimap/settings";
import type { MinimapLabels } from "@cocalc/frontend/components/minimap/settings-ui";

export const NOTEBOOK_MINIMAP_LABELS: MinimapLabels = {
  title: "Notebook Minimap",
};

export type { MinimapKind, MinimapSettings };

export const MINIMAP_SETTINGS_CHANGED_EVENT =
  "cocalc-jupyter-minimap-settings-changed";
export const MINIMAP_OPEN_SETTINGS_EVENT =
  "cocalc-jupyter-open-minimap-settings";
export const STUDIO_MINIMAP_SETTINGS_CHANGED_EVENT =
  "cocalc-jupyter-studio-minimap-settings-changed";
export const STUDIO_MINIMAP_OPEN_SETTINGS_EVENT =
  "cocalc-jupyter-studio-open-minimap-settings";

export const MINIMAP_DEFAULT_ENABLED = true;

const WIDTHS = {
  text: { default: 120, min: 48, max: 220 },
  // no text to render, so a narrow column of bars is plenty
  stylized: { default: 40, min: 16, max: 120 },
};

// The classic notebook has always shown the text minimap and Studio the
// stylized one, so the two views keep separate preferences with those
// defaults; either can still be switched to the other style.
export const minimapSettings = createMinimapSettings({
  enabledKey: "cocalc_jupyter_minimap",
  kindKey: "cocalc_jupyter_minimap_kind",
  widthKeys: {
    text: "cocalc_jupyter_minimap_width",
    stylized: "cocalc_jupyter_minimap_stylized_width",
  },
  changedEvent: MINIMAP_SETTINGS_CHANGED_EVENT,
  openSettingsEvent: MINIMAP_OPEN_SETTINGS_EVENT,
  defaultEnabled: MINIMAP_DEFAULT_ENABLED,
  defaultKind: "text",
  widths: WIDTHS,
});

export const studioMinimapSettings = createMinimapSettings({
  enabledKey: "cocalc_jupyter_studio_minimap",
  kindKey: "cocalc_jupyter_studio_minimap_kind",
  widthKeys: {
    text: "cocalc_jupyter_studio_minimap_width",
    stylized: "cocalc_jupyter_studio_minimap_stylized_width",
  },
  changedEvent: STUDIO_MINIMAP_SETTINGS_CHANGED_EVENT,
  openSettingsEvent: STUDIO_MINIMAP_OPEN_SETTINGS_EVENT,
  defaultEnabled: MINIMAP_DEFAULT_ENABLED,
  defaultKind: "stylized",
  widths: WIDTHS,
});

/** The preferences of whichever notebook view is on screen. */
export function minimapSettingsFor(
  cellViewMode: "default" | "studio" | undefined,
): MinimapSettingsApi {
  return cellViewMode === "studio" ? studioMinimapSettings : minimapSettings;
}
