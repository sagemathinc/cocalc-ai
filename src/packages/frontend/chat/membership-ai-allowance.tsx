/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// What is left of the membership's AI allowance (5 hours and 7 days, shared
// with Codex): what included Claude (CoCalc Membership) is paid from, shown
// the way a Claude subscription's limits are.

import { Progress, Typography } from "antd";
import { useEffect, useState } from "react";
import type {
  AIUsageStatus,
  AIUsageWindowStatus,
} from "@cocalc/conat/hub/api/purchases";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { TimeAgo } from "@cocalc/frontend/components/time-ago";
import { getWarningAIUsage } from "@cocalc/frontend/account/membership-usage-cache";

export interface AllowanceWindow {
  key: "5h" | "7d";
  name: string;
  short: string;
  usedPercent: number;
  resetsAt?: Date;
}

/** The windows with a limit, as percentages used. */
export function allowanceWindows(
  status: AIUsageStatus | null | undefined,
): AllowanceWindow[] {
  return (status?.windows ?? []).flatMap((window: AIUsageWindowStatus) => {
    const limit = window.limit;
    if (typeof limit !== "number" || !(limit > 0)) return [];
    const used = Number(window.used) || 0;
    const reset = window.reset_at ?? window.resets_at;
    const resetsAt = reset ? new Date(reset) : undefined;
    return [
      {
        key: window.window,
        name: window.window === "5h" ? "5-hour limit" : "7-day limit",
        short: window.window === "5h" ? "5-hour" : "Week",
        usedPercent: Math.max(
          0,
          Math.min(100, Math.round((100 * used) / limit)),
        ),
        resetsAt:
          resetsAt && Number.isFinite(resetsAt.getTime())
            ? resetsAt
            : undefined,
      },
    ];
  });
}

/** The account's allowance, loaded (and cached briefly) on mount. */
export function useMembershipAIAllowance(reload = 0): {
  windows: AllowanceWindow[];
  loaded: boolean;
} {
  const accountId = useTypedRedux("account", "account_id") as
    | string
    | undefined;
  const [state, setState] = useState<{
    windows: AllowanceWindow[];
    loaded: boolean;
  }>({ windows: [], loaded: false });
  useEffect(() => {
    if (!accountId) {
      // Nothing to load: the description alone.
      setState({ windows: [], loaded: true });
      return;
    }
    let live = true;
    void getWarningAIUsage(accountId)
      .then((status) => {
        if (live) setState({ windows: allowanceWindows(status), loaded: true });
      })
      .catch(() => {
        if (live) setState({ windows: [], loaded: true });
      });
    return () => {
      live = false;
    };
  }, [accountId, reload]);
  return state;
}

/** One line per window: name, bar, percent used and when it resets. */
export function MembershipAIAllowance({
  variant = "compact",
  reload,
}: {
  /** compact: rows for a payment option; full: the footer's details. */
  variant?: "compact" | "full";
  reload?: number;
}) {
  const { windows, loaded } = useMembershipAIAllowance(reload);
  if (!loaded)
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        Loading your allowance...
      </Typography.Text>
    );
  if (!windows.length)
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        Included in your CoCalc membership's AI allowance
      </Typography.Text>
    );
  if (variant === "full")
    return (
      <>
        {windows.map((window) => (
          <div key={window.key} style={{ marginTop: 12 }}>
            <div>
              {window.name}: {window.usedPercent}% used
            </div>
            <Progress
              percent={window.usedPercent}
              status="normal"
              showInfo={false}
              size="small"
              aria-label={`${window.name}: ${window.usedPercent}% used`}
            />
            {window.resetsAt ? (
              <Typography.Text type="secondary">
                Resets <TimeAgo date={window.resetsAt} />
              </Typography.Text>
            ) : null}
          </div>
        ))}
        <div style={{ marginTop: 8 }}>
          <Typography.Text type="secondary">
            Included in your CoCalc membership: the same AI allowance as Codex.
          </Typography.Text>
        </div>
      </>
    );
  return (
    <div style={{ fontSize: 12 }}>
      {windows.map((window) => (
        <div
          key={window.key}
          style={{ display: "flex", alignItems: "center", gap: 8 }}
        >
          <span style={{ width: 48, flex: "0 0 auto" }}>{window.short}</span>
          <Progress
            percent={window.usedPercent}
            status="normal"
            showInfo={false}
            size="small"
            style={{ flex: "1 1 60px", margin: 0, minWidth: 40 }}
            aria-label={`${window.name}: ${window.usedPercent}% used`}
          />
          <span style={{ flex: "0 0 auto" }}>{window.usedPercent}%</span>
          {window.resetsAt ? (
            <Typography.Text
              type="secondary"
              style={{ fontSize: 12, flex: "0 1 auto", whiteSpace: "nowrap" }}
            >
              resets <TimeAgo date={window.resetsAt} />
            </Typography.Text>
          ) : null}
        </div>
      ))}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        Included in your CoCalc membership's AI allowance
      </Typography.Text>
    </div>
  );
}
