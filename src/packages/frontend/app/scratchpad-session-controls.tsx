/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Popover, Space, Typography } from "antd";
import type { JSX } from "react";
import { AppearanceControl } from "@cocalc/frontend/appearance/control";
import { Icon } from "@cocalc/frontend/components/icon";
import { TimeAgo } from "@cocalc/frontend/components/time-ago";
import { COLORS } from "@cocalc/util/theme";

export function ScratchpadSessionControls({
  deleteAt,
}: {
  deleteAt?: string;
}): JSX.Element {
  const deadline = new Date(`${deleteAt ?? ""}`);
  const validDeadline = Number.isFinite(deadline.valueOf());

  const reminder = (
    <Space vertical size={4} style={{ maxWidth: 320 }}>
      <Typography.Text strong>Temporary scratchpad</Typography.Text>
      <Typography.Text>
        This project and all of its files will be permanently erased{" "}
        {validDeadline ? (
          <TimeAgo
            date={deadline}
            live
            click_to_toggle={false}
            time_ago_absolute={false}
          />
        ) : (
          "at the configured deletion time"
        )}
        . Nothing from this project is retained.
      </Typography.Text>
      {validDeadline && (
        <Typography.Text type="secondary">
          {deadline.toLocaleString()}
        </Typography.Text>
      )}
    </Space>
  );

  return (
    <div
      style={{
        alignItems: "center",
        display: "flex",
        gap: 6,
        position: "fixed",
        right: 8,
        top: 6,
        zIndex: 1000,
      }}
    >
      <AppearanceControl />
      <Popover content={reminder} trigger="click" placement="bottomRight">
        <Button
          size="small"
          shape="round"
          icon={<Icon name="stopwatch" />}
          style={{
            background: COLORS.ANTD_ORANGE,
            borderColor: COLORS.FEATURE_ORANGE,
          }}
        >
          Temporary
        </Button>
      </Popover>
    </div>
  );
}
