/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Modal, Progress, Space, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";

import {
  getWarningAccountUsageOverview,
  shouldPollUsageWarnings,
  warningPollInterval,
} from "@cocalc/frontend/account/membership-usage-cache";
import MembershipPurchaseModal from "@cocalc/frontend/account/membership-purchase-modal";
import {
  ACCOUNT_USAGE_OVERVIEW_REFRESHED_EVENT,
  getAccountUsageOverviewRefreshedEventDetail,
} from "@cocalc/frontend/account/membership-usage-events";
import { openAccountSettings } from "@cocalc/frontend/account/settings-routing";
import { React, useTypedRedux } from "@cocalc/frontend/app-framework";
import type { PageStyle } from "@cocalc/frontend/app/top-nav-consts";
import { TOP_BAR_ELEMENT_CLASS } from "@cocalc/frontend/app/top-nav-consts";
import { Tooltip } from "@cocalc/frontend/components";
import { Icon } from "@cocalc/frontend/components/icon";
import type {
  AccountUsageMeter,
  AccountUsageOverview,
} from "@cocalc/conat/hub/api/purchases";
import { COLORS } from "@cocalc/util/theme";

const { Text } = Typography;

const ACCOUNT_CPU_WARNING_THRESHOLD = 0.75;
const ACCOUNT_CPU_SEVERE_THRESHOLD = 0.9;
const ACCOUNT_CPU_WARNING_POLL_MS = 60_000;
const CPU_METER_IDS = new Set(["managed-cpu-5h", "managed-cpu-7d"]);

type AccountCpuWarningSeverity = "warning" | "severe" | "blocked";

export interface AccountCpuWarningState {
  meter: AccountUsageMeter;
  used: number;
  limit: number;
  ratio: number;
  percent: number;
  severity: AccountCpuWarningSeverity;
}

function getFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function getMeterRatio(meter: AccountUsageMeter): number | undefined {
  const ratio = getFiniteNumber(meter.ratio);
  if (ratio != null && ratio >= 0) return ratio;
  const percent = getFiniteNumber(meter.percent);
  if (percent != null && percent >= 0) return percent / 100;
  const used = getFiniteNumber(meter.used);
  const limit = getFiniteNumber(meter.limit);
  if (used == null || limit == null || !(limit > 0)) return;
  return used / limit;
}

function getMeterPercent(meter: AccountUsageMeter, ratio: number): number {
  const percent = getFiniteNumber(meter.percent);
  if (percent != null && percent >= 0) return Math.round(percent);
  return Math.round(ratio * 100);
}

function getSeverity(
  meter: AccountUsageMeter,
  ratio: number,
): AccountCpuWarningSeverity {
  if (meter.severity === "over" || ratio >= 1) return "blocked";
  if (meter.severity === "near" || ratio >= ACCOUNT_CPU_SEVERE_THRESHOLD) {
    return "severe";
  }
  return "warning";
}

export function getAccountCpuWarning(
  overview: AccountUsageOverview | null | undefined,
  threshold = ACCOUNT_CPU_WARNING_THRESHOLD,
): AccountCpuWarningState | undefined {
  const warnings: AccountCpuWarningState[] = [];
  for (const meter of overview?.meters ?? []) {
    if (!CPU_METER_IDS.has(meter.id)) continue;
    const used = getFiniteNumber(meter.used);
    const limit = getFiniteNumber(meter.limit);
    if (used == null || limit == null || !(limit > 0)) continue;
    const ratio = getMeterRatio(meter);
    if (ratio == null) continue;
    if (!(ratio >= threshold) && meter.severity !== "near") continue;
    warnings.push({
      meter,
      used,
      limit,
      ratio,
      percent: getMeterPercent(meter, ratio),
      severity: getSeverity(meter, ratio),
    });
  }
  warnings.sort((a, b) => {
    const order: Record<AccountCpuWarningSeverity, number> = {
      blocked: 0,
      severe: 1,
      warning: 2,
    };
    if (a.severity !== b.severity) {
      return order[a.severity] - order[b.severity];
    }
    return b.ratio - a.ratio;
  });
  return warnings[0];
}

function formatCpuHours(seconds: number): string {
  const hours = seconds / 3600;
  const digits = hours >= 10 || Number.isInteger(hours) ? 0 : 1;
  return `${hours.toFixed(digits)} CPU-h`;
}

function formatResetAt(resetAt?: Date | string): string | undefined {
  if (!resetAt) return;
  const date = new Date(resetAt);
  if (!Number.isFinite(date.getTime())) return;
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getWindowLabel(meter: AccountUsageMeter): string {
  if (meter.window === "5h") return "5-hour";
  if (meter.window === "7d") return "7-day";
  return meter.window;
}

function getSummaryLabel(
  warning: AccountCpuWarningState,
  isNarrow: boolean,
): string {
  if (warning.severity === "blocked") return "CPU over limit";
  if (isNarrow) return `CPU ${warning.percent}%`;
  return `CPU ${getWindowLabel(warning.meter)} ${warning.percent}%`;
}

function getSummaryTooltip(warning: AccountCpuWarningState): string {
  return `${warning.meter.label}: ${formatCpuHours(warning.used)} of ${formatCpuHours(
    warning.limit,
  )} used (${warning.percent}%).`;
}

export const AccountCpuWarning: React.FC<{
  pageStyle: PageStyle;
}> = React.memo(({ pageStyle }: { pageStyle: PageStyle }) => {
  const account_id = useTypedRedux("account", "account_id");
  const is_logged_in = useTypedRedux("account", "is_logged_in");
  const [overview, setOverview] = useState<AccountUsageOverview | null>(null);
  const [open, setOpen] = useState(false);
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const [dismissedWarningKey, setDismissedWarningKey] = useState<
    string | undefined
  >();

  useEffect(() => {
    if (!account_id || !is_logged_in) {
      setOverview(null);
      return;
    }
    let mounted = true;
    const load = async () => {
      if (!shouldPollUsageWarnings()) return;
      try {
        const next = await getWarningAccountUsageOverview();
        if (mounted) {
          setOverview(next ?? null);
        }
      } catch {
        if (mounted) {
          setOverview(null);
        }
      }
    };
    void load();
    const interval = setInterval(
      () => void load(),
      warningPollInterval(ACCOUNT_CPU_WARNING_POLL_MS),
    );
    const refresh = () => void load();
    const updateFromFreshOverview = (event: Event) => {
      const next = getAccountUsageOverviewRefreshedEventDetail(event);
      if (mounted && next) {
        setOverview(next);
      }
    };
    window.addEventListener("cocalc:membership-changed", refresh);
    window.addEventListener(
      ACCOUNT_USAGE_OVERVIEW_REFRESHED_EVENT,
      updateFromFreshOverview,
    );
    return () => {
      mounted = false;
      clearInterval(interval);
      window.removeEventListener("cocalc:membership-changed", refresh);
      window.removeEventListener(
        ACCOUNT_USAGE_OVERVIEW_REFRESHED_EVENT,
        updateFromFreshOverview,
      );
    };
  }, [account_id, is_logged_in]);

  const warning = useMemo(() => getAccountCpuWarning(overview), [overview]);
  const warningKey =
    warning?.severity === "warning"
      ? `${warning.meter.id}:${warning.severity}`
      : undefined;
  const dismissed = warningKey != null && dismissedWarningKey === warningKey;
  if (!account_id || !is_logged_in || warning == null || dismissed) {
    return null;
  }

  const outerStyle = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    padding: `${pageStyle.topPaddingIcons} ${pageStyle.sidePaddingIcons}`,
    height: `${pageStyle.height}px`,
  };

  const pillStyle = {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    borderRadius: "999px",
    padding: pageStyle.isNarrow ? "4px 8px" : "5px 10px",
    background:
      warning.severity === "blocked" || warning.severity === "severe"
        ? COLORS.ANTD_RED
        : COLORS.ANTD_ORANGE,
    color:
      warning.severity === "blocked" || warning.severity === "severe"
        ? "white"
        : COLORS.GRAY_DD,
    fontSize: pageStyle.isNarrow ? "11px" : "12px",
    fontWeight: 600,
    lineHeight: 1,
    whiteSpace: "nowrap",
  } as const;

  const resetAt = warning.meter.resets_at ?? warning.meter.reset_at;
  const modalTitle =
    warning.severity === "blocked"
      ? "CPU usage limit reached"
      : warning.severity === "severe"
        ? "CPU usage warning"
        : "CPU usage nearing limit";

  return (
    <>
      <Tooltip
        title={getSummaryTooltip(warning)}
        mouseEnterDelay={0.4}
        mouseLeaveDelay={0}
        placement="bottom"
      >
        <div
          style={outerStyle}
          onClick={() => setOpen(true)}
          className={TOP_BAR_ELEMENT_CLASS}
          data-cocalc-account-cpu-warning
        >
          <div style={pillStyle}>
            <Icon name="tachometer-alt" />
            <span>{getSummaryLabel(warning, pageStyle.isNarrow)}</span>
          </div>
        </div>
      </Tooltip>
      <Modal
        title={modalTitle}
        open={open}
        onCancel={() => setOpen(false)}
        footer={[
          ...(warning.severity === "warning"
            ? [
                <Button
                  key="dismiss"
                  onClick={() => {
                    setDismissedWarningKey(warningKey);
                    setOpen(false);
                  }}
                >
                  Dismiss for now
                </Button>,
              ]
            : []),
          <Button
            key="details"
            onClick={() => {
              setOpen(false);
              openAccountSettings({ page: "usage-limits" });
            }}
          >
            Open Usage & Limits
          </Button>,
          <Button
            key="upgrade"
            type="primary"
            onClick={() => setPurchaseOpen(true)}
          >
            Upgrade membership
          </Button>,
        ]}
        width={760}
      >
        <Space vertical size="middle" style={{ width: "100%" }}>
          <Text>
            Your account has used most or all of its managed CPU allocation for
            the current {getWindowLabel(warning.meter)} window. Existing
            projects are not automatically killed, but starting additional
            projects may be blocked until usage resets. Stop runaway processes,
            wait for the window reset, or upgrade membership for a higher CPU
            allocation.
          </Text>
          <div>
            <Space
              align="center"
              style={{ width: "100%", justifyContent: "space-between" }}
            >
              <Text strong>{warning.meter.label}</Text>
              <Text
                type={warning.severity === "blocked" ? "danger" : undefined}
              >
                {formatCpuHours(warning.used)} of{" "}
                {formatCpuHours(warning.limit)} ({warning.percent}%)
              </Text>
            </Space>
            {(resetAt || warning.meter.reset_in) && (
              <div style={{ marginTop: "4px" }}>
                <Text type="secondary">
                  {resetAt ? `Resets ${formatResetAt(resetAt)}` : ""}
                  {warning.meter.reset_in
                    ? ` · in ${warning.meter.reset_in}`
                    : ""}
                </Text>
              </div>
            )}
            <div style={{ marginTop: "6px" }}>
              <Progress
                percent={Math.min(100, warning.percent)}
                status={
                  warning.severity === "blocked" ||
                  warning.severity === "severe"
                    ? "exception"
                    : "active"
                }
              />
            </div>
          </div>
          {warning.meter.action_when_over ? (
            <Text type="secondary">{warning.meter.action_when_over}</Text>
          ) : null}
        </Space>
      </Modal>
      <MembershipPurchaseModal
        open={purchaseOpen}
        onClose={() => setPurchaseOpen(false)}
        onChanged={() => {
          setPurchaseOpen(false);
          window.dispatchEvent(new Event("cocalc:membership-changed"));
        }}
      />
    </>
  );
});
