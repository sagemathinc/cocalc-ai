/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { Space, Switch } from "antd";
import { useId } from "react";
import { redux, useAccountOtherSetting } from "@cocalc/frontend/app-framework";
import { CLAUDE_USAGE_REFRESH_SETTING } from "@cocalc/util/ai/claude-usage-probe";

/** The opt-in to periodic limit checks for Auto, off by default: each check
 * is a request through the user's subscription. */
export function ClaudeUsageRefreshSetting() {
  const enabled =
    useAccountOtherSetting<boolean>(CLAUDE_USAGE_REFRESH_SETTING) === true;
  const id = useId();
  return (
    <Space align="start">
      <Switch
        id={id}
        size="small"
        checked={enabled}
        onChange={(checked) =>
          // Looked up on change: where no account is loaded (tests, some
          // embeddings) the switch still renders.
          redux
            .getActions("account")
            ?.set_other_settings(CLAUDE_USAGE_REFRESH_SETTING, checked)
        }
      />
      <label htmlFor={id}>
        Check my Claude subscriptions' limits for Auto. When on, CoCalc sends a
        small request (a one-word reply) through each connected Claude
        subscription whose limit reading is more than 4 hours old, which uses a
        little of that subscription's allowance. Off by default.
      </label>
    </Space>
  );
}
