/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { labels } from "@cocalc/frontend/i18n";
import { defineMessage } from "react-intl";

import {
  NavigationPreferences,
  NAVIGATION_CONTROL_LABELS,
} from "@cocalc/frontend/app/quick-navigation/configuration";
import { KeyboardSettings, KEYBOARD_SHORTCUTS } from "./keyboard-settings";
import type { SettingsPageDefinition } from "./settings-page";

export const ACCOUNT_PREFERENCES_KEYBOARD_PAGE = {
  component: AccountPreferencesKeyboard,
  description: defineMessage({
    id: "account.settings.overview.keyboard",
    defaultMessage: "Keyboard shortcuts.",
  }),
  controls: [
    ...Object.values(NAVIGATION_CONTROL_LABELS),
    ...KEYBOARD_SHORTCUTS.map(({ command }) => command),
  ],
  icon: "keyboard",
  key: "keyboard",
  label: labels.keyboard,
} satisfies SettingsPageDefinition;

export function AccountPreferencesKeyboard() {
  return (
    <>
      <NavigationPreferences />
      <KeyboardSettings />
    </>
  );
}
