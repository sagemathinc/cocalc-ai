/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { defineMessage } from "react-intl";
import { capitalize } from "@cocalc/util/misc";

export const EDITOR_SETTINGS_CHECKBOXES = {
  extra_button_bar: defineMessage({
    id: "account.editor-setting.checkbox.extra_button_bar",
    defaultMessage:
      "customizable button bar below menu bar with shortcuts to menu items",
  }),
  line_wrapping: defineMessage({
    id: "account.editor-setting.checkbox.line_wrapping",
    defaultMessage: "wrap long lines",
  }),
  line_numbers: defineMessage({
    id: "account.editor-setting.checkbox.line_numbers",
    defaultMessage: "show line numbers",
  }),
  jupyter_line_numbers: defineMessage({
    id: "account.editor-setting.checkbox.jupyter_line_numbers",
    defaultMessage: "show line numbers in Jupyter Notebooks",
  }),
  code_folding: defineMessage({
    id: "account.editor-setting.checkbox.code_folding",
    defaultMessage: "fold code using control+Q",
  }),
  smart_indent: defineMessage({
    id: "account.editor-setting.checkbox.smart_indent",
    defaultMessage: "context sensitive indentation",
  }),
  electric_chars: defineMessage({
    id: "account.editor-setting.checkbox.electric_chars",
    defaultMessage: "sometimes re-indent current line",
  }),
  match_brackets: defineMessage({
    id: "account.editor-setting.checkbox.match_brackets",
    defaultMessage: "highlight matching brackets near cursor",
  }),
  auto_close_brackets: defineMessage({
    id: "account.editor-setting.checkbox.auto_close_brackets",
    defaultMessage: "automatically close brackets",
  }),
  match_xml_tags: defineMessage({
    id: "account.editor-setting.checkbox.match_xml_tags",
    defaultMessage: "automatically match XML tags",
  }),
  auto_close_xml_tags: defineMessage({
    id: "account.editor-setting.checkbox.auto_close_xml_tags",
    defaultMessage: "automatically close XML tags",
  }),
  auto_close_latex: defineMessage({
    id: "account.editor-setting.checkbox.auto_close_latex",
    defaultMessage: "automatically close LaTeX environments",
  }),
  strip_trailing_whitespace: defineMessage({
    id: "account.editor-setting.checkbox.strip_trailing_whitespace",
    defaultMessage: "remove whenever file is saved",
  }),
  show_trailing_whitespace: defineMessage({
    id: "account.editor-setting.checkbox.show_trailing_whitespace",
    defaultMessage: "show spaces at ends of lines",
  }),
  spaces_instead_of_tabs: defineMessage({
    id: "account.editor-setting.checkbox.spaces_instead_of_tabs",
    defaultMessage: "send spaces when the tab key is pressed",
  }),
  build_on_save: defineMessage({
    id: "account.editor-setting.checkbox.build_on_save",
    defaultMessage: "build LaTex/Rmd files whenever it is saved to disk",
  }),
  show_exec_warning: defineMessage({
    id: "account.editor-setting.checkbox.show_exec_warning",
    defaultMessage: "warn that certain files are not directly executable",
  }),
  ask_jupyter_kernel: defineMessage({
    id: "account.editor-setting.checkbox.ask_jupyter_kernel",
    defaultMessage: "ask which kernel to use for a new Jupyter Notebook",
  }),
  show_my_other_cursors: "when editing the same file in multiple browsers",
  disable_markdown_codebar: defineMessage({
    id: "account.other-settings.markdown_codebar",
    defaultMessage: `<strong>Disable the markdown code bar</strong> in all markdown documents.
      Checking this hides the extra run, copy, and explain buttons in fenced code blocks.`,
  }),
  show_symbol_bar_labels: defineMessage({
    id: "account.other-settings.symbol_bar_labels",
    defaultMessage:
      "<strong>Show Symbol Bar Labels:</strong> show labels in the frame editor symbol bar",
  }),
} as const;

export const FONT_SIZE_LABEL = defineMessage({
  id: "account.editor-settings.font-size.label",
  defaultMessage: "Default global font size",
});

export const AUTOSAVE_LABEL = defineMessage({
  id: "account.editor-settings-autosave-interval.label",
  defaultMessage: "Autosave interval",
});

export const INDENT_SIZE_LABEL = defineMessage({
  id: "account.editor-settings.indent-size.label",
  defaultMessage: "Indent size",
});

export const KEYBOARD_BINDINGS_LABEL = defineMessage({
  id: "account.editor-settings.keyboard-bindings.label",
  defaultMessage: "Editor keyboard bindings",
});

export const COLOR_SCHEME_LABEL = defineMessage({
  id: "account.editor-settings.color-schemes.panel_title",
  defaultMessage: "Editor Color Scheme",
});

// This name is also rendered before each checkbox description.
export function editorCheckboxName(name: string): string {
  return capitalize(
    name
      .replace(/_/g, " ")
      .replace(/-/g, " ")
      .replace("xml", "XML")
      .replace("latex", "LaTeX"),
  );
}
