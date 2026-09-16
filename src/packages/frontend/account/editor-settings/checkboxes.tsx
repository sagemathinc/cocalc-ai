/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// cSpell:ignore codebar

import { useIntl } from "react-intl";

import { Panel, Switch } from "@cocalc/frontend/antd-bootstrap";
import { Rendered } from "@cocalc/frontend/app-framework";
import { Icon, IconName } from "@cocalc/frontend/components";
import { BUILD_ON_SAVE_ICON_ENABLED } from "@cocalc/frontend/frame-editors/frame-tree/commands/const";
import { IntlMessage, isIntlMessage } from "@cocalc/frontend/i18n";

import { EDITOR_SETTINGS_CHECKBOXES, editorCheckboxName } from "./labels";

// Type for valid checkbox keys
type CheckboxKey = keyof typeof EDITOR_SETTINGS_CHECKBOXES;

// Group checkboxes into logical panels
const DISPLAY_SETTINGS: readonly CheckboxKey[] = [
  "line_wrapping",
  "line_numbers",
  "jupyter_line_numbers",
  "show_trailing_whitespace",
  "show_my_other_cursors",
  "show_symbol_bar_labels",
] as const;

const EDITING_BEHAVIOR: readonly CheckboxKey[] = [
  "code_folding",
  "smart_indent",
  "electric_chars",
  "spaces_instead_of_tabs",
  "strip_trailing_whitespace",
] as const;

const AUTOCOMPLETION: readonly CheckboxKey[] = [
  "match_brackets",
  "auto_close_brackets",
  "match_xml_tags",
  "auto_close_xml_tags",
  "auto_close_latex",
] as const;

const FILE_OPERATIONS: readonly CheckboxKey[] = [
  "build_on_save",
  "show_exec_warning",
] as const;

const JUPYTER_SETTINGS: readonly CheckboxKey[] = [
  "ask_jupyter_kernel",
] as const;

const UI_ELEMENTS: readonly CheckboxKey[] = [
  "extra_button_bar",
  "disable_markdown_codebar",
] as const;

// Settings that come from other_settings instead of editor_settings
const OTHER_SETTINGS_KEYS: readonly CheckboxKey[] = [
  "disable_markdown_codebar",
  "show_symbol_bar_labels",
] as const;

function isOtherSetting(name: CheckboxKey): boolean {
  return OTHER_SETTINGS_KEYS.includes(name);
}

interface Props {
  editor_settings;
  other_settings?;
  email_address?: string;
  on_change: Function;
  on_change_other_settings?: Function;
}

export function EditorSettingsCheckboxes(props: Props) {
  const intl = useIntl();

  function renderName(name: CheckboxKey) {
    if (isOtherSetting(name)) return;
    return <strong>{editorCheckboxName(name) + ": "}</strong>;
  }

  function label_checkbox(
    name: CheckboxKey,
    desc: IntlMessage | Rendered | string,
  ): Rendered {
    return (
      <span>
        {renderName(name)}
        {isIntlMessage(desc) ? intl.formatMessage(desc) : desc}
      </span>
    );
  }

  function render_checkbox(
    name: CheckboxKey,
    desc: IntlMessage | Rendered | string,
  ): Rendered {
    // Special handling for settings that are in other_settings
    const is_other_setting = isOtherSetting(name);
    const checked = is_other_setting
      ? !!props.other_settings?.get(name)
      : !!props.editor_settings.get(name);
    const onChange = is_other_setting
      ? (e) => props.on_change_other_settings?.(name, e.target.checked)
      : (e) => props.on_change(name, e.target.checked);

    return (
      <Switch checked={checked} key={name} onChange={onChange}>
        {label_checkbox(name, desc)}
      </Switch>
    );
  }

  function renderPanel(
    header: string,
    icon: IconName,
    settingNames: readonly CheckboxKey[],
  ) {
    return (
      <Panel
        size="small"
        header={
          <>
            <Icon name={icon} /> {header}
          </>
        }
      >
        {settingNames.map((name) =>
          render_checkbox(name, EDITOR_SETTINGS_CHECKBOXES[name]),
        )}
      </Panel>
    );
  }

  return (
    <>
      {renderPanel("Display Settings", "eye", DISPLAY_SETTINGS)}
      {renderPanel("Editing Behavior", "edit", EDITING_BEHAVIOR)}
      {renderPanel("Auto-completion", "code", AUTOCOMPLETION)}
      {renderPanel(
        "File Operations",
        BUILD_ON_SAVE_ICON_ENABLED,
        FILE_OPERATIONS,
      )}
      {renderPanel("Jupyter Settings", "jupyter", JUPYTER_SETTINGS)}
      {renderPanel("UI Elements", "desktop", UI_ELEMENTS)}
    </>
  );
}
