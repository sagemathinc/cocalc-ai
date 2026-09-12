/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Select } from "antd";
import type { ReactElement } from "react";
import {
  defineMessages,
  FormattedMessage,
  defineMessage,
  useIntl,
} from "react-intl";

import { Panel, Switch } from "@cocalc/frontend/antd-bootstrap";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { A, HelpIcon, Icon, LabeledRow } from "@cocalc/frontend/components";
import { labels } from "@cocalc/frontend/i18n";
import { DEFAULT_EDITOR_THEME } from "@cocalc/util/db-schema/accounts";
import {
  AppearanceControl,
  APPEARANCE_CONTROL_LABELS,
} from "@cocalc/frontend/appearance/control";
import { EditorSettingsColorScheme } from "./editor-settings/color-schemes";
import { I18NSelector, I18N_MESSAGE, I18N_TITLE } from "./i18n-selector";
import { NavbarMembershipSetting } from "./navbar-membership-setting";
import { OtherSettings, OTHER_APPEARANCE_LABELS } from "./other-settings";
import type { SettingsPageDefinition } from "./settings-page";
import {
  TerminalSettings,
  TERMINAL_COLOR_SCHEME_LABEL,
} from "./terminal-settings";

export const APPEARANCE_SETTINGS_LABELS = defineMessages({
  userInterface: {
    id: "account.appearance.user_interface.title",
    defaultMessage: "User Interface",
  },
  filePopovers: {
    id: "account.other-settings.file_popovers",
    defaultMessage:
      "<strong>Hide File Tab Popovers:</strong>\n            do not show the popovers over file tabs",
  },
  tooltips: {
    id: "account.other-settings.button_tooltips",
    defaultMessage:
      "<strong>Hide Tooltips:</strong>\n            hides all tooltips",
  },
  timestamps: {
    id: "account.other-settings.time_ago_absolute",
    defaultMessage:
      "<strong>Display Timestamps as absolute points in time</strong>\n            instead of relative to the current time",
  },
  balance: {
    id: "account.other-settings.hide_navbar_balance",
    defaultMessage: "<strong>Hide Account Balance</strong> in navigation bar",
  },
  tabColors: {
    id: "account.other-settings.file_tab_accent_mode",
    defaultMessage: "File tab accent colors",
  },
});

export const ACCOUNT_PREFERENCES_APPEARANCE_PAGE = {
  component: AccountPreferencesAppearance,
  description: defineMessage({
    id: "account.settings.overview.appearance",
    defaultMessage: "Customize color themes, language, and visual settings.",
  }),
  controls: [
    ...Object.values(APPEARANCE_CONTROL_LABELS),
    ...Object.values(APPEARANCE_SETTINGS_LABELS),
    ...Object.values(OTHER_APPEARANCE_LABELS),
    TERMINAL_COLOR_SCHEME_LABEL,
    labels.language,
  ],
  icon: "eye",
  key: "appearance",
  label: labels.appearance,
} satisfies SettingsPageDefinition;

// See https://github.com/sagemathinc/cocalc/issues/5620
// There are weird bugs with relying only on mathjax, whereas our
// implementation of katex with a fallback to mathjax works very well.
// This makes it so katex can't be disabled.
const ALLOW_DISABLE_KATEX = false;

export function katexIsEnabled() {
  if (!ALLOW_DISABLE_KATEX) {
    return true;
  }
  return redux.getStore("account")?.getIn(["other_settings", "katex"]) ?? true;
}

export function AccountPreferencesAppearance() {
  const intl = useIntl();
  const projectLabel = intl.formatMessage(labels.project);
  const projectLabelLower = projectLabel.toLowerCase();
  const other_settings = useTypedRedux("account", "other_settings");
  const editor_settings = useTypedRedux("account", "editor_settings");
  const font_size = useTypedRedux("account", "font_size");
  const stripe_customer = useTypedRedux("account", "stripe_customer");

  function on_change(name: string, value: any): void {
    redux.getActions("account").set_other_settings(name, value);
  }

  function on_change_editor_settings(name: string, value: any): void {
    redux.getActions("account").set_editor_settings(name, value);
  }

  function render_katex() {
    if (!ALLOW_DISABLE_KATEX) {
      return null;
    }
    return (
      <Switch
        checked={!!other_settings.get("katex")}
        onChange={(e) => on_change("katex", e.target.checked)}
      >
        <FormattedMessage
          id="account.other-settings.katex"
          defaultMessage={`<strong>KaTeX:</strong> attempt to render formulas
              using {katex} (much faster, but missing context menu options)`}
          values={{ katex: <A href={"https://katex.org/"}>KaTeX</A> }}
        />
      </Switch>
    );
  }

  function renderDarkModePanel(): ReactElement {
    return (
      <Panel
        size="small"
        header={
          <>
            <Icon name="eye" /> {intl.formatMessage(labels.appearance)}
          </>
        }
      >
        <AppearanceControl />
      </Panel>
    );
  }

  function renderUserInterfacePanel(): ReactElement {
    const tabAccentMode =
      other_settings.get("file_tab_accent_mode") ?? "bright";
    return (
      <Panel
        size="small"
        header={
          <>
            <Icon name="desktop" />{" "}
            <FormattedMessage {...APPEARANCE_SETTINGS_LABELS.userInterface} />
          </>
        }
      >
        <LabeledRow
          label={
            <>
              <Icon name="translation-outlined" />{" "}
              {intl.formatMessage(labels.language)}
            </>
          }
        >
          <div>
            <I18NSelector />{" "}
            <HelpIcon title={intl.formatMessage(I18N_TITLE)}>
              {intl.formatMessage(I18N_MESSAGE)}
            </HelpIcon>
          </div>
        </LabeledRow>
        <Switch
          checked={!!other_settings.get("hide_file_popovers")}
          onChange={(e) => on_change("hide_file_popovers", e.target.checked)}
        >
          <FormattedMessage {...APPEARANCE_SETTINGS_LABELS.filePopovers} />
        </Switch>
        <Switch
          checked={!!other_settings.get("hide_project_popovers")}
          onChange={(e) => on_change("hide_project_popovers", e.target.checked)}
        >
          <FormattedMessage
            id="account.other-settings.project_popovers"
            defaultMessage={`<strong>Hide {projectLabel} Tab Popovers:</strong>
            do not show the popovers over the {projectLabelLower} tabs`}
            values={{ projectLabel, projectLabelLower }}
          />
        </Switch>
        <Switch
          checked={!!other_settings.get("hide_button_tooltips")}
          onChange={(e) => on_change("hide_button_tooltips", e.target.checked)}
        >
          <FormattedMessage {...APPEARANCE_SETTINGS_LABELS.tooltips} />
        </Switch>
        <Switch
          checked={!!other_settings.get("time_ago_absolute")}
          onChange={(e) => on_change("time_ago_absolute", e.target.checked)}
        >
          <FormattedMessage {...APPEARANCE_SETTINGS_LABELS.timestamps} />
        </Switch>
        <Switch
          checked={!!other_settings.get("hide_navbar_balance")}
          onChange={(e) => on_change("hide_navbar_balance", e.target.checked)}
        >
          <FormattedMessage {...APPEARANCE_SETTINGS_LABELS.balance} />
        </Switch>
        <NavbarMembershipSetting />
        <LabeledRow
          label={<FormattedMessage {...APPEARANCE_SETTINGS_LABELS.tabColors} />}
        >
          <Select
            aria-label="File tab accent colors"
            size="small"
            style={{ minWidth: 200 }}
            value={tabAccentMode}
            onChange={(value) => on_change("file_tab_accent_mode", value)}
            options={[
              {
                label: intl.formatMessage(labels.off),
                value: "off",
              },
              {
                label: intl.formatMessage({
                  id: "account.other-settings.file_tab_accent_mode.pastels",
                  defaultMessage: "Pastels",
                }),
                value: "pastel",
              },
              {
                label: intl.formatMessage({
                  id: "account.other-settings.file_tab_accent_mode.bright",
                  defaultMessage: "Bold",
                }),
                value: "bright",
              },
            ]}
          />
        </LabeledRow>
        {render_katex()}
      </Panel>
    );
  }

  return (
    <>
      {renderUserInterfacePanel()}
      <OtherSettings
        other_settings={other_settings}
        is_stripe_customer={
          !!stripe_customer?.getIn(["subscriptions", "total_count"])
        }
        mode="appearance"
      />
      {renderDarkModePanel()}
      <EditorSettingsColorScheme
        size="small"
        theme={editor_settings?.get("theme") ?? DEFAULT_EDITOR_THEME}
        on_change={(value) => on_change_editor_settings("theme", value)}
        editor_settings={editor_settings}
        font_size={font_size}
      />
      <TerminalSettings />
    </>
  );
}
