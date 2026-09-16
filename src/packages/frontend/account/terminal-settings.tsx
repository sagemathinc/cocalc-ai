/*
 *  This file is part of CoCalc: Copyright © 2020-2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button } from "antd";
import { defineMessage, useIntl } from "react-intl";

import { Panel } from "@cocalc/frontend/antd-bootstrap";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import {
  Icon,
  LabeledRow,
  Loading,
  SelectorInput,
} from "@cocalc/frontend/components";
import {
  example,
  getThemeName,
  theme_desc,
} from "@cocalc/frontend/frame-editors/terminal-editor/theme-data";
import { labels } from "@cocalc/frontend/i18n";
import { set_account_table } from "./util";
import { useAppearance } from "@cocalc/frontend/appearance/use-appearance";
import {
  FOLLOW_APPEARANCE,
  resolveAppearanceEditorTheme,
} from "@cocalc/util/appearance-editor";

declare global {
  interface Window {
    Terminal: any;
  }
}

export const TERMINAL_COLOR_SCHEME_LABEL = defineMessage({
  id: "account.terminal-settings.label-row.label",
  defaultMessage: "Terminal color scheme",
});

export function TerminalSettings() {
  const intl = useIntl();

  const terminal = useTypedRedux("account", "terminal");
  const { resolved } = useAppearance();
  const selected = terminal?.get("color_scheme");
  const color_scheme =
    selected === FOLLOW_APPEARANCE ? selected : getThemeName(selected);

  if (terminal == null) {
    return <Loading />;
  }

  function setTerminalColorScheme(color_scheme: string): void {
    set_account_table({ terminal: { color_scheme } });
  }

  const label = intl.formatMessage(TERMINAL_COLOR_SCHEME_LABEL);

  return (
    <Panel
      size="small"
      header={
        <>
          <Icon name="terminal" /> Terminal Settings
        </>
      }
    >
      <LabeledRow label={label}>
        <Button
          disabled={color_scheme === FOLLOW_APPEARANCE}
          style={{ float: "right" }}
          onClick={() => setTerminalColorScheme(FOLLOW_APPEARANCE)}
        >
          {intl.formatMessage(labels.reset)}
        </Button>
        <SelectorInput
          ariaLabel={label}
          style={{ width: "250px" }}
          selected={color_scheme}
          options={theme_desc}
          on_change={setTerminalColorScheme}
          showSearch={true}
        />
      </LabeledRow>
      <TerminalPreview
        color_scheme={resolveAppearanceEditorTheme(color_scheme, resolved)}
      />
    </Panel>
  );
}

function TerminalPreview({ color_scheme }: { color_scheme: string }) {
  const html = example(getThemeName(color_scheme));
  return (
    <div
      style={{
        marginTop: "10px",
        border: "1px solid #ccc",
        borderRadius: "4px",
        overflow: "hidden",
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
