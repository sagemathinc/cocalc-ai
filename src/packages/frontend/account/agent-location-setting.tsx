/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Space, Switch, Typography } from "antd";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import {
  agentLocationEnabled,
  OTHER_SETTINGS_AGENT_LOCATION_KEY,
} from "@cocalc/util/ai/agent-user-locale";

export const AGENT_LOCATION_LABEL = "Let agents use my approximate location";

/** Agents always get the person's local time and time zone; this switch
 * adds their approximate place (city and region, from the network). */
export function AgentLocationSetting() {
  const other_settings = useTypedRedux("account", "other_settings");
  const enabled = agentLocationEnabled(
    other_settings?.get?.(OTHER_SETTINGS_AGENT_LOCATION_KEY),
  );
  return (
    <Space orientation="vertical" size={6}>
      <Space align="center">
        <Switch
          aria-label={AGENT_LOCATION_LABEL}
          checked={enabled}
          onChange={(checked) =>
            redux
              .getActions("account")
              .set_other_settings(OTHER_SETTINGS_AGENT_LOCATION_KEY, checked)
          }
        />
        <Typography.Text>{AGENT_LOCATION_LABEL}</Typography.Text>
      </Space>
      <Typography.Text type="secondary">
        Agents always see your local time and time zone, so "today", "tonight"
        and "6am" mean your time. With this on they also see your approximate
        location (city and region, estimated from your network).
      </Typography.Text>
    </Space>
  );
}
