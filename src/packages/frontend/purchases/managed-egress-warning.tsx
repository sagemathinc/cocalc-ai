/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Modal, Progress, Space, Tag, Typography } from "antd";
import type { ReactElement } from "react";
import { useEffect, useMemo, useState } from "react";

import MembershipPurchaseModal from "@cocalc/frontend/account/membership-purchase-modal";
import {
  React,
  useActions,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { Tooltip } from "@cocalc/frontend/components";
import { Icon } from "@cocalc/frontend/components/icon";
import type { PageStyle } from "@cocalc/frontend/app/top-nav-consts";
import { TOP_BAR_ELEMENT_CLASS } from "@cocalc/frontend/app/top-nav-consts";
import {
  ManagedEgressRecentEventsButton,
  formatManagedEgressCategory,
} from "@cocalc/frontend/purchases/managed-egress-recent-events";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { MembershipDetails } from "@cocalc/conat/hub/api/purchases";
import { COLORS } from "@cocalc/util/theme";

const { Text } = Typography;

export const MANAGED_EGRESS_WARNING_THRESHOLD = 0.75;
export const MANAGED_EGRESS_SEVERE_THRESHOLD = 0.9;
const MANAGED_EGRESS_WARNING_POLL_MS = 60_000;

type EgressWindow = "5h" | "7d";
type ManagedEgressWarningSeverity = "warning" | "severe" | "blocked";

export interface ManagedEgressWindowWarning {
  window: EgressWindow;
  used: number;
  limit: number;
  ratio: number;
  percent: number;
  over: boolean;
  severity: ManagedEgressWarningSeverity;
}

function formatDecimalBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = Number.isInteger(value) || value >= 10 || unit === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
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

function getManagedEgressLimit(
  details: MembershipDetails | null | undefined,
  window: EgressWindow,
): number | undefined {
  const usageLimits = details?.selected?.entitlements?.usage_limits;
  const key = window === "5h" ? "egress_5h_bytes" : "egress_7d_bytes";
  const value = usageLimits?.[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function getManagedEgressUsed(
  details: MembershipDetails | null | undefined,
  window: EgressWindow,
): number | undefined {
  const usageStatus = details?.usage_status;
  const key =
    window === "5h" ? "managed_egress_5h_bytes" : "managed_egress_7d_bytes";
  const value = usageStatus?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function getManagedEgressWindowWarnings(
  details: MembershipDetails | null | undefined,
  threshold = MANAGED_EGRESS_WARNING_THRESHOLD,
): ManagedEgressWindowWarning[] {
  const warnings: ManagedEgressWindowWarning[] = [];
  for (const window of ["5h", "7d"] as const) {
    const limit = getManagedEgressLimit(details, window);
    const used = getManagedEgressUsed(details, window);
    if (limit == null || used == null || limit <= 0) continue;
    const ratio = used / limit;
    if (!(ratio >= threshold)) continue;
    warnings.push({
      window,
      used,
      limit,
      ratio,
      percent: Math.round(ratio * 100),
      over: ratio >= 1,
      severity:
        ratio >= 1
          ? "blocked"
          : ratio >= MANAGED_EGRESS_SEVERE_THRESHOLD
            ? "severe"
            : "warning",
    });
  }
  warnings.sort((a, b) => {
    if (a.over !== b.over) return a.over ? -1 : 1;
    if (a.severity !== b.severity) {
      const order: Record<ManagedEgressWarningSeverity, number> = {
        blocked: 0,
        severe: 1,
        warning: 2,
      };
      return order[a.severity] - order[b.severity];
    }
    return b.ratio - a.ratio;
  });
  return warnings;
}

export function renderManagedEgressBreakdown(
  label: string,
  breakdown?: Record<string, number>,
): ReactElement | null {
  if (!breakdown || Object.keys(breakdown).length === 0) return null;
  const entries = Object.entries(breakdown).filter(
    ([, value]) =>
      typeof value === "number" && Number.isFinite(value) && value > 0,
  );
  if (entries.length === 0) return null;
  return (
    <div>
      <Text strong>{label}</Text>
      <div style={{ marginTop: "6px" }}>
        <Space wrap>
          {entries.map(([category, bytes]) => (
            <Tag key={category}>
              {formatManagedEgressCategory(category)}:{" "}
              {formatDecimalBytes(bytes)}
            </Tag>
          ))}
        </Space>
      </div>
    </div>
  );
}

function getSummaryLabel(
  warning: ManagedEgressWindowWarning,
  isNarrow: boolean,
): string {
  if (warning.over) {
    return isNarrow ? "Blocked" : "Network blocked";
  }
  if (isNarrow) {
    return `${warning.window} ${warning.percent}%`;
  }
  return `Network ${warning.window} ${warning.percent}%`;
}

function getSummaryTooltip(warnings: ManagedEgressWindowWarning[]): string {
  if (warnings.length === 0) return "";
  const windows = warnings
    .map(
      ({ window, used, limit, percent }) =>
        `${window}: ${formatDecimalBytes(used)} of ${formatDecimalBytes(limit)} (${percent}%)`,
    )
    .join(" • ");
  return `Managed network usage is close to its limit. ${windows}`;
}

function getManagedEgressResetInfo(
  details: MembershipDetails | null,
  window: EgressWindow,
): { resetAt?: Date | string; resetIn?: string } {
  const usage = details?.usage_status;
  if (window === "5h") {
    return {
      resetAt: usage?.managed_egress_5h_reset_at,
      resetIn: usage?.managed_egress_5h_reset_in,
    };
  }
  return {
    resetAt: usage?.managed_egress_7d_reset_at,
    resetIn: usage?.managed_egress_7d_reset_in,
  };
}

export const ManagedEgressWarning: React.FC<{
  pageStyle: PageStyle;
}> = React.memo(({ pageStyle }: { pageStyle: PageStyle }) => {
  const account_id = useTypedRedux("account", "account_id");
  const is_logged_in = useTypedRedux("account", "is_logged_in");
  const page_actions = useActions("page");
  const [details, setDetails] = useState<MembershipDetails | null>(null);
  const [open, setOpen] = useState(false);
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const [dismissedWarningKey, setDismissedWarningKey] = useState<
    string | undefined
  >();

  useEffect(() => {
    if (!account_id || !is_logged_in) {
      setDetails(null);
      return;
    }
    let mounted = true;
    const load = async () => {
      try {
        const next =
          await webapp_client.conat_client.hub.purchases.getMembershipDetails(
            {},
          );
        if (mounted) {
          setDetails((next as MembershipDetails) ?? null);
        }
      } catch {
        if (mounted) {
          setDetails(null);
        }
      }
    };
    void load();
    const interval = setInterval(
      () => void load(),
      MANAGED_EGRESS_WARNING_POLL_MS,
    );
    const refresh = () => void load();
    window.addEventListener("cocalc:membership-changed", refresh);
    return () => {
      mounted = false;
      clearInterval(interval);
      window.removeEventListener("cocalc:membership-changed", refresh);
    };
  }, [account_id, is_logged_in]);

  const warnings = useMemo(
    () => getManagedEgressWindowWarnings(details),
    [details],
  );
  const primary = warnings[0];
  const primaryWarningKey =
    primary?.severity === "warning"
      ? `${primary.window}:${primary.severity}`
      : undefined;
  const dismissed =
    primaryWarningKey != null && dismissedWarningKey === primaryWarningKey;
  if (!account_id || !is_logged_in || primary == null || dismissed) {
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
      primary.severity === "blocked" || primary.severity === "severe"
        ? COLORS.ANTD_RED
        : COLORS.ANTD_ORANGE,
    color:
      primary.severity === "blocked" || primary.severity === "severe"
        ? "white"
        : COLORS.GRAY_DD,
    fontSize: pageStyle.isNarrow ? "11px" : "12px",
    fontWeight: 600,
    lineHeight: 1,
    whiteSpace: "nowrap",
  } as const;

  const modalTitle = primary.over
    ? "Network usage limit reached"
    : primary.severity === "severe"
      ? "Network usage warning"
      : "Network usage nearing limit";

  return (
    <>
      <Tooltip
        title={getSummaryTooltip(warnings)}
        mouseEnterDelay={0.4}
        mouseLeaveDelay={0}
        placement="bottom"
      >
        <div
          style={outerStyle}
          onClick={() => setOpen(true)}
          className={TOP_BAR_ELEMENT_CLASS}
          data-cocalc-managed-egress-warning
        >
          <div style={pillStyle}>
            <Icon name="warning" />
            <span>{getSummaryLabel(primary, pageStyle.isNarrow)}</span>
          </div>
        </div>
      </Tooltip>
      <Modal
        title={modalTitle}
        open={open}
        onCancel={() => setOpen(false)}
        footer={[
          ...(primary.severity === "warning"
            ? [
                <Button
                  key="dismiss"
                  onClick={() => {
                    setDismissedWarningKey(primaryWarningKey);
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
              page_actions.set_active_tab("account");
            }}
          >
            Open membership details
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
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Text>
            Metered shared-host traffic includes downloads, app traffic,
            interactive sessions, SSH, and outbound project network traffic.
            When these limits are hit, transfers or projects may be blocked.
          </Text>
          {warnings.map((warning) => (
            <div key={warning.window}>
              <Space
                align="center"
                style={{ width: "100%", justifyContent: "space-between" }}
              >
                <Text strong>{warning.window} window</Text>
                <Text type={warning.over ? "danger" : undefined}>
                  {formatDecimalBytes(warning.used)} of{" "}
                  {formatDecimalBytes(warning.limit)} ({warning.percent}%)
                </Text>
              </Space>
              {(() => {
                const { resetAt, resetIn } = getManagedEgressResetInfo(
                  details,
                  warning.window,
                );
                if (!resetAt && !resetIn) return null;
                return (
                  <div style={{ marginTop: "4px" }}>
                    <Text type="secondary">
                      {resetAt ? `Next reset ${formatResetAt(resetAt)}` : ""}
                      {resetIn ? ` · in ${resetIn}` : ""}
                    </Text>
                  </div>
                );
              })()}
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
          ))}
          {renderManagedEgressBreakdown(
            "Managed egress by category (5 hours)",
            details?.usage_status?.managed_egress_categories_5h_bytes,
          )}
          {renderManagedEgressBreakdown(
            "Managed egress by category (7 days)",
            details?.usage_status?.managed_egress_categories_7d_bytes,
          )}
          {details?.usage_status?.managed_egress_recent_events?.length ? (
            <div>
              <Text strong>Recent managed egress events</Text>
              <div style={{ marginTop: "8px" }}>
                <ManagedEgressRecentEventsButton
                  events={details?.usage_status?.managed_egress_recent_events}
                />
              </div>
            </div>
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
