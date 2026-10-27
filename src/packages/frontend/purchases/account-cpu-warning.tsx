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
import { UI_COLORS } from "@cocalc/util/appearance-palette";

const { Text } = Typography;

const ACCOUNT_USAGE_WARNING_POLL_MS = 60_000;

type AccountCpuWarningSeverity = "warning" | "severe" | "blocked";

// One kind of windowed account limit the top bar warns about.
interface UsageWarningKind {
  id: "cpu" | "ai";
  meterIds: Set<string>;
  warningThreshold: number;
  severeThreshold: number;
  // Whether the meter's own "near" severity (75%) counts as severe.
  meterNearIsSevere: boolean;
  name: string;
  formatAmount: (value: number) => string;
  titles: Record<AccountCpuWarningSeverity, string>;
  description: (windowLabel: string) => string;
}

function formatCpuHours(seconds: number): string {
  const hours = seconds / 3600;
  const digits = hours >= 10 || Number.isInteger(hours) ? 0 : 1;
  return `${hours.toFixed(digits)} CPU-h`;
}

function formatAiUnits(units: number): string {
  return `${Math.round(units).toLocaleString()} AI units`;
}

const CPU_WARNING: UsageWarningKind = {
  id: "cpu",
  meterIds: new Set(["managed-cpu-5h", "managed-cpu-7d"]),
  warningThreshold: 0.75,
  severeThreshold: 0.9,
  meterNearIsSevere: true,
  name: "CPU",
  formatAmount: formatCpuHours,
  titles: {
    blocked: "CPU usage limit reached",
    severe: "CPU usage warning",
    warning: "CPU usage nearing limit",
  },
  description: (windowLabel) =>
    `Your account has used most or all of its managed CPU allocation for the current ${windowLabel} window. Existing projects are not automatically killed, but starting additional projects may be blocked until usage resets. Stop runaway processes, wait for the window reset, or upgrade membership for a higher CPU allocation.`,
};

// The included AI allowance that site-funded agent turns draw on; the same
// 80% and 95% levels as the warning shown on agent turns.
const AI_WARNING: UsageWarningKind = {
  id: "ai",
  meterIds: new Set(["ai-5h", "ai-7d"]),
  warningThreshold: 0.8,
  severeThreshold: 0.95,
  meterNearIsSevere: false,
  name: "AI",
  formatAmount: formatAiUnits,
  titles: {
    blocked: "Included AI allowance used up",
    severe: "Included AI allowance almost used up",
    warning: "Included AI allowance nearing limit",
  },
  description: (windowLabel) =>
    `Your account has used most or all of its included AI allowance for the current ${windowLabel} window. When it runs out, AI requests and agent turns that use it are refused until the window resets. Wait for the reset, use your own API key, or upgrade membership for a larger allowance.`,
};

export interface AccountCpuWarningState {
  kind: UsageWarningKind;
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
  kind: UsageWarningKind,
  meter: AccountUsageMeter,
  ratio: number,
): AccountCpuWarningSeverity {
  if (meter.severity === "over" || ratio >= 1) return "blocked";
  if (
    (kind.meterNearIsSevere && meter.severity === "near") ||
    ratio >= kind.severeThreshold
  ) {
    return "severe";
  }
  return "warning";
}

function getAccountUsageWarning(
  kind: UsageWarningKind,
  overview: AccountUsageOverview | null | undefined,
  threshold = kind.warningThreshold,
): AccountCpuWarningState | undefined {
  const warnings: AccountCpuWarningState[] = [];
  for (const meter of overview?.meters ?? []) {
    if (!kind.meterIds.has(meter.id)) continue;
    const used = getFiniteNumber(meter.used);
    const limit = getFiniteNumber(meter.limit);
    if (used == null || limit == null || !(limit > 0)) continue;
    const ratio = getMeterRatio(meter);
    if (ratio == null) continue;
    if (
      !(ratio >= threshold) &&
      !(kind.meterNearIsSevere && meter.severity === "near")
    ) {
      continue;
    }
    warnings.push({
      kind,
      meter,
      used,
      limit,
      ratio,
      percent: getMeterPercent(meter, ratio),
      severity: getSeverity(kind, meter, ratio),
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

export function getAccountCpuWarning(
  overview: AccountUsageOverview | null | undefined,
  threshold?: number,
): AccountCpuWarningState | undefined {
  return getAccountUsageWarning(CPU_WARNING, overview, threshold);
}

export function getAccountAiWarning(
  overview: AccountUsageOverview | null | undefined,
): AccountCpuWarningState | undefined {
  return getAccountUsageWarning(AI_WARNING, overview);
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
  const { name } = warning.kind;
  if (warning.severity === "blocked") return `${name} over limit`;
  if (isNarrow) return `${name} ${warning.percent}%`;
  return `${name} ${getWindowLabel(warning.meter)} ${warning.percent}%`;
}

function getSummaryTooltip(warning: AccountCpuWarningState): string {
  const { formatAmount } = warning.kind;
  return `${warning.meter.label}: ${formatAmount(warning.used)} of ${formatAmount(
    warning.limit,
  )} used (${warning.percent}%).`;
}

// The top-bar warnings for the account's windowed CPU and included-AI limits.
export const AccountCpuWarning: React.FC<{
  pageStyle: PageStyle;
}> = React.memo(({ pageStyle }: { pageStyle: PageStyle }) => {
  const account_id = useTypedRedux("account", "account_id");
  const is_logged_in = useTypedRedux("account", "is_logged_in");
  const [overview, setOverview] = useState<AccountUsageOverview | null>(null);

  useEffect(() => {
    if (!account_id || !is_logged_in) {
      setOverview(null);
      return;
    }
    let mounted = true;
    const load = async () => {
      if (!shouldPollUsageWarnings()) return;
      try {
        const next = await getWarningAccountUsageOverview(account_id);
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
      warningPollInterval(ACCOUNT_USAGE_WARNING_POLL_MS),
    );
    const refresh = () => void load();
    const updateFromFreshOverview = (event: Event) => {
      const next = getAccountUsageOverviewRefreshedEventDetail(
        event,
        account_id,
      );
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

  const warnings = useMemo(
    () =>
      [getAccountCpuWarning(overview), getAccountAiWarning(overview)].filter(
        (warning): warning is AccountCpuWarningState => warning != null,
      ),
    [overview],
  );
  if (!account_id || !is_logged_in || warnings.length === 0) {
    return null;
  }
  return (
    <>
      {warnings.map((warning) => (
        <UsageWarningPill
          key={warning.kind.id}
          warning={warning}
          pageStyle={pageStyle}
        />
      ))}
    </>
  );
});

export function UsageWarningPill({
  warning,
  pageStyle,
}: {
  warning: AccountCpuWarningState;
  pageStyle: PageStyle;
}) {
  const [open, setOpen] = useState(false);
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const [dismissedWarningKey, setDismissedWarningKey] = useState<
    string | undefined
  >();
  const warningKey =
    warning?.severity === "warning"
      ? `${warning.meter.id}:${warning.severity}`
      : undefined;
  const dismissed = warningKey != null && dismissedWarningKey === warningKey;
  if (dismissed) return null;

  const severe =
    warning.severity === "blocked" || warning.severity === "severe";
  const outerStyle = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    border: "none",
    background: "transparent",
    font: "inherit",
    padding: `${pageStyle.topPaddingIcons} ${pageStyle.sidePaddingIcons}`,
    height: `${pageStyle.height}px`,
  };

  const pillStyle = {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    borderRadius: "999px",
    padding: pageStyle.isNarrow ? "4px 8px" : "5px 10px",
    background: severe ? UI_COLORS.dangerBg : UI_COLORS.warningBg,
    color: severe ? UI_COLORS.danger : UI_COLORS.warning,
    border: `1px solid ${severe ? UI_COLORS.danger : UI_COLORS.warning}`,
    fontSize: pageStyle.isNarrow ? "11px" : "12px",
    fontWeight: 600,
    lineHeight: 1,
    whiteSpace: "nowrap",
  } as const;

  const resetAt = warning.meter.resets_at ?? warning.meter.reset_at;
  const modalTitle = warning.kind.titles[warning.severity];

  return (
    <>
      <Tooltip
        title={getSummaryTooltip(warning)}
        mouseEnterDelay={0.4}
        mouseLeaveDelay={0}
        placement="bottom"
      >
        <button
          type="button"
          style={outerStyle}
          onClick={() => setOpen(true)}
          className={TOP_BAR_ELEMENT_CLASS}
          aria-haspopup="dialog"
          aria-label={`${modalTitle}. ${getSummaryTooltip(warning)}`}
          data-cocalc-account-usage-warning={warning.kind.id}
        >
          <span style={pillStyle}>
            <Icon name="tachometer-alt" />
            <span>{getSummaryLabel(warning, pageStyle.isNarrow)}</span>
          </span>
        </button>
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
          <Text>{warning.kind.description(getWindowLabel(warning.meter))}</Text>
          <div>
            <Space
              align="center"
              style={{ width: "100%", justifyContent: "space-between" }}
            >
              <Text strong>{warning.meter.label}</Text>
              <Text
                type={warning.severity === "blocked" ? "danger" : undefined}
              >
                {warning.kind.formatAmount(warning.used)} of{" "}
                {warning.kind.formatAmount(warning.limit)} ({warning.percent}%)
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
}
