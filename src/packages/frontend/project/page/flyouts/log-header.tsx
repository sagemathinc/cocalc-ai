/*
 *  This file is part of CoCalc: Copyright © 2023 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Radio } from "antd";
import { useIntl } from "react-intl";

import {
  useActions,
  useEffect,
  useState,
} from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import { labels } from "@cocalc/frontend/i18n";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { FIXED_PROJECT_TABS } from "../file-tab";
import { FlyoutLogMode, getFlyoutLogMode, isFlyoutLogMode } from "./state";

const MODE_TOGGLE_STYLE = {
  alignItems: "center",
  display: "inline-flex",
  fontSize: 13,
  fontWeight: 500,
  lineHeight: "22px",
} as const;

const MODE_TOGGLE_BUTTON_STYLE = {
  lineHeight: "22px",
} as const;

export function LogHeader(): React.JSX.Element {
  const intl = useIntl();
  const { project_id } = useProjectContext();

  const [mode, setModeState] = useState<FlyoutLogMode>(
    getFlyoutLogMode(project_id),
  );

  function setMode(mode: FlyoutLogMode) {
    if (isFlyoutLogMode(mode)) {
      setModeState(mode);
    } else {
      console.warn(`Invalid flyout log mode: ${mode}`);
    }
  }

  // any mode change triggers an action to compute it
  const actions = useActions({ project_id });
  useEffect(() => actions?.setFlyoutLogMode(mode), [mode]);

  function renderToggle() {
    return (
      <Radio.Group
        value={mode}
        onChange={(val) => setMode(val.target.value)}
        size="small"
        style={MODE_TOGGLE_STYLE}
      >
        <Radio.Button value="files" style={MODE_TOGGLE_BUTTON_STYLE}>
          {intl.formatMessage(labels.files)}
        </Radio.Button>
        <Radio.Button value="history" style={MODE_TOGGLE_BUTTON_STYLE}>
          {intl.formatMessage(labels.activity)}
        </Radio.Button>
      </Radio.Group>
    );
  }

  return (
    <div
      style={{
        alignItems: "center",
        display: "flex",
        flex: "1 1 0",
        gap: 8,
        minWidth: 0,
        overflow: "hidden",
      }}
    >
      <span
        style={{
          flex: "1 1 0",
          fontWeight: "bold",
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        <Icon name={FIXED_PROJECT_TABS.log.icon} />{" "}
        {intl.formatMessage(labels.recent)}
      </span>
      <span style={{ flex: "0 0 auto" }}>{renderToggle()}</span>
    </div>
  );
}
