/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { TimeAgo } from "@cocalc/frontend/components/time-ago";
import { Tooltip } from "@cocalc/frontend/components/tip";

export function ActivityTime({ timestamp }: { timestamp?: number }) {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  return (
    <Tooltip title={date.toLocaleString()} trigger={["hover", "focus"]}>
      <span className="collaborators-row-time">
        <TimeAgo
          date={date}
          accessibleLabel={`Last activity: ${date.toLocaleString()}`}
        />
      </span>
    </Tooltip>
  );
}
