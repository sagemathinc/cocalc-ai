/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { labels } from "@cocalc/frontend/i18n";
import { defineMessage } from "react-intl";

import { EditorSettings } from "./editor-settings/editor-settings";
import type { SettingsPageDefinition } from "./settings-page";

import { EDITOR_BINDINGS } from "@cocalc/util/db-schema/accounts";
import {
  FONT_SIZE_LABEL,
  AUTOSAVE_LABEL,
  INDENT_SIZE_LABEL,
  KEYBOARD_BINDINGS_LABEL,
  COLOR_SCHEME_LABEL,
  EDITOR_SETTINGS_CHECKBOXES,
  editorCheckboxName,
} from "./editor-settings/labels";

export const ACCOUNT_PREFERENCES_EDITOR_PAGE = {
  component: AccountPreferencesEditor,
  description: defineMessage({
    id: "account.settings.overview.editor",
    defaultMessage:
      "Customize code editor behavior, indentation, and content options.",
  }),
  controls: [
    FONT_SIZE_LABEL,
    AUTOSAVE_LABEL,
    INDENT_SIZE_LABEL,
    KEYBOARD_BINDINGS_LABEL,
    COLOR_SCHEME_LABEL,
    ...Object.values(EDITOR_BINDINGS),
    ...Object.keys(EDITOR_SETTINGS_CHECKBOXES).map(editorCheckboxName),
    ...Object.values(EDITOR_SETTINGS_CHECKBOXES),
  ],
  icon: "edit",
  key: "editor",
  label: labels.editor,
} satisfies SettingsPageDefinition;

export function AccountPreferencesEditor() {
  return <EditorSettings />;
}
