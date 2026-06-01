/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { labels } from "@cocalc/frontend/i18n";
import { defineMessage } from "react-intl";

import { EditorSettings } from "./editor-settings/editor-settings";
import type { SettingsPageDefinition } from "./settings-page";

export const ACCOUNT_PREFERENCES_EDITOR_PAGE = {
  component: AccountPreferencesEditor,
  description: defineMessage({
    id: "account.settings.overview.editor",
    defaultMessage:
      "Customize code editor behavior, indentation, and content options.",
  }),
  icon: "edit",
  key: "editor",
  label: labels.editor,
} satisfies SettingsPageDefinition;

export function AccountPreferencesEditor() {
  return <EditorSettings />;
}
