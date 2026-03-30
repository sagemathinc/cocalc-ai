/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// cSpell:words lehmer primality mersenne

import { capitalize } from "lodash";
import { useIntl } from "react-intl";

import { Button, Panel } from "@cocalc/frontend/antd-bootstrap";
import { CSS } from "@cocalc/frontend/app-framework";
import { Icon, LabeledRow, SelectorInput } from "@cocalc/frontend/components";
import { labels } from "@cocalc/frontend/i18n";
import { AsyncComponent } from "@cocalc/frontend/misc/async-component";
import { EDITOR_COLOR_SCHEMES } from "@cocalc/util/db-schema/accounts";

interface Props {
  theme: string;
  on_change: (selected: string) => void;
  editor_settings;
  font_size?: number;
  style?: CSS;
  size?: "small";
}

export function EditorSettingsColorScheme(props: Props): React.JSX.Element {
  const intl = useIntl();

  const title = intl.formatMessage({
    id: "account.editor-settings.color-schemes.panel_title",
    defaultMessage: "Editor Color Scheme",
  });

  return (
    <Panel
      size={props.size}
      header={
        <>
          <Icon name="file-alt" /> {title}
        </>
      }
      style={props.style}
    >
      <LabeledRow label={capitalize(title)}>
        <Button
          disabled={props.theme === "default"}
          style={{ float: "right" }}
          onClick={() => {
            props.on_change("default");
          }}
        >
          {intl.formatMessage(labels.reset)}
        </Button>
        <SelectorInput
          style={{ width: "250px" }}
          options={EDITOR_COLOR_SCHEMES}
          selected={props.theme}
          on_change={props.on_change}
          showSearch={true}
        />
      </LabeledRow>
      <CodeMirrorPreview
        editor_settings={props.editor_settings}
        font_size={props.font_size}
      />
    </Panel>
  );
}

const CodeMirrorPreview = AsyncComponent(async () => {
  return (await import("./color-schemes-preview")).default;
});
