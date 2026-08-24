/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Persisted preferences for the CodeMirror minimap.  The mechanics live in
// @cocalc/frontend/components/minimap/settings; this module only pins down the
// code editor's storage keys, events and defaults.

import {
  createMinimapSettings,
  type MinimapKind,
  type MinimapSettings,
} from "@cocalc/frontend/components/minimap/settings";
import type { MinimapLabels } from "@cocalc/frontend/components/minimap/settings-ui";

export const CODEMIRROR_MINIMAP_LABELS: MinimapLabels = {
  title: "Code Minimap",
};

export const CODEMIRROR_MINIMAP_SETTINGS_CHANGED_EVENT =
  "cocalc-codemirror-minimap-settings-changed";
export const CODEMIRROR_MINIMAP_OPEN_SETTINGS_EVENT =
  "cocalc-codemirror-open-minimap-settings";

export const CODEMIRROR_MINIMAP_DEFAULT_ENABLED = true;
export const CODEMIRROR_MINIMAP_DEFAULT_KIND: MinimapKind = "text";

export const codeMirrorMinimapSettings = createMinimapSettings({
  enabledKey: "cocalc_codemirror_minimap",
  kindKey: "cocalc_codemirror_minimap_kind",
  widthKeys: {
    text: "cocalc_codemirror_minimap_width",
    stylized: "cocalc_codemirror_minimap_stylized_width",
  },
  changedEvent: CODEMIRROR_MINIMAP_SETTINGS_CHANGED_EVENT,
  openSettingsEvent: CODEMIRROR_MINIMAP_OPEN_SETTINGS_EVENT,
  defaultEnabled: CODEMIRROR_MINIMAP_DEFAULT_ENABLED,
  defaultKind: CODEMIRROR_MINIMAP_DEFAULT_KIND,
  widths: {
    text: { default: 120, min: 56, max: 240 },
    // no text to render, so a narrow column of bars is plenty
    stylized: { default: 40, min: 16, max: 120 },
  },
});

export type { MinimapKind };
export type CodeMirrorMinimapSettings = MinimapSettings;

export const clampCodeMirrorMinimapWidth = codeMirrorMinimapSettings.clampWidth;
export const readCodeMirrorMinimapSettings = codeMirrorMinimapSettings.read;
export const setCodeMirrorMinimapEnabled = codeMirrorMinimapSettings.setEnabled;
export const toggleCodeMirrorMinimapEnabled =
  codeMirrorMinimapSettings.toggleEnabled;
export const setCodeMirrorMinimapWidth = codeMirrorMinimapSettings.setWidth;
export const adjustCodeMirrorMinimapWidth =
  codeMirrorMinimapSettings.adjustWidth;
export const setCodeMirrorMinimapKind = codeMirrorMinimapSettings.setKind;
export const toggleCodeMirrorMinimapKind = codeMirrorMinimapSettings.toggleKind;
export const openCodeMirrorMinimapSettingsDialog =
  codeMirrorMinimapSettings.openSettingsDialog;
