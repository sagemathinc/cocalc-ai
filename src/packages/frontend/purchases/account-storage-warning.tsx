/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Modal, Progress, Space, Typography } from "antd";
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
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { MembershipDetails } from "@cocalc/conat/hub/api/purchases";
import { COLORS } from "@cocalc/util/theme";

const { Text } = Typography;

const ACCOUNT_STORAGE_WARNING_THRESHOLD = 0.75;
const ACCOUNT_STORAGE_SEVERE_THRESHOLD = 0.9;
const ACCOUNT_STORAGE_WARNING_POLL_MS = 60_000;

type AccountStorageWarningSeverity = "warning" | "severe" | "blocked";

export interface AccountStorageWarningState {
  used: number;
  soft_limit?: number;
  hard_limit?: number;
  compare_limit: number;
  compare_label: "soft cap" | "hard cap";
  ratio: number;
  percent: number;
  severity: AccountStorageWarningSeverity;
  over_soft: boolean;
  over_hard: boolean;
  partial_measurement: boolean;
}

function getPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
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

export function getAccountStorageWarning(
  details: MembershipDetails | null | undefined,
  threshold = ACCOUNT_STORAGE_WARNING_THRESHOLD,
): AccountStorageWarningState | undefined {
  const usage = details?.usage_status;
  if (!usage) return;
  const used =
    typeof usage.total_storage_bytes === "number" &&
    Number.isFinite(usage.total_storage_bytes) &&
    usage.total_storage_bytes >= 0
      ? usage.total_storage_bytes
      : undefined;
  if (used == null) return;
  const usageLimits =
    details?.selected?.effective_limits ??
    details?.selected?.entitlements?.usage_limits;
  const soft_limit =
    getPositiveNumber(usage.total_storage_soft_bytes) ??
    getPositiveNumber(usageLimits?.total_storage_soft_bytes);
  const hard_limit =
    getPositiveNumber(usage.total_storage_hard_bytes) ??
    getPositiveNumber(usageLimits?.total_storage_hard_bytes);
  if (soft_limit == null && hard_limit == null) return;
  const partial_measurement =
    (usage.unsampled_project_count ?? 0) > 0 ||
    (usage.measurement_error_count ?? 0) > 0;

  if (hard_limit != null && used >= hard_limit) {
    return {
      used,
      soft_limit,
      hard_limit,
      compare_limit: hard_limit,
      compare_label: "hard cap",
      ratio: used / hard_limit,
      percent: Math.round((used / hard_limit) * 100),
      severity: "blocked",
      over_soft: soft_limit != null ? used >= soft_limit : false,
      over_hard: true,
      partial_measurement,
    };
  }

  if (soft_limit != null && used >= soft_limit) {
    return {
      used,
      soft_limit,
      hard_limit,
      compare_limit: soft_limit,
      compare_label: "soft cap",
      ratio: used / soft_limit,
      percent: Math.round((used / soft_limit) * 100),
      severity: "severe",
      over_soft: true,
      over_hard: false,
      partial_measurement,
    };
  }

  const compare_limit = soft_limit ?? hard_limit;
  if (compare_limit == null || compare_limit <= 0) return;
  const ratio = used / compare_limit;
  if (!(ratio >= threshold)) return;
  return {
    used,
    soft_limit,
    hard_limit,
    compare_limit,
    compare_label: soft_limit != null ? "soft cap" : "hard cap",
    ratio,
    percent: Math.round(ratio * 100),
    severity: ratio >= ACCOUNT_STORAGE_SEVERE_THRESHOLD ? "severe" : "warning",
    over_soft: false,
    over_hard: false,
    partial_measurement,
  };
}

function getSummaryLabel(
  warning: AccountStorageWarningState,
  isNarrow: boolean,
): string {
  if (warning.severity === "blocked") {
    return isNarrow ? "Storage blocked" : "Storage blocked";
  }
  if (warning.over_soft) {
    return isNarrow ? "Storage soft cap" : "Storage soft cap";
  }
  if (isNarrow) {
    return `Storage ${warning.percent}%`;
  }
  return `Storage ${warning.percent}%`;
}

function getSummaryTooltip(warning: AccountStorageWarningState): string {
  const parts = [
    `Current: ${formatDecimalBytes(warning.used)}`,
    `${warning.compare_label}: ${formatDecimalBytes(warning.compare_limit)}`,
  ];
  if (warning.soft_limit != null && warning.compare_label !== "soft cap") {
    parts.push(`soft cap: ${formatDecimalBytes(warning.soft_limit)}`);
  }
  if (warning.hard_limit != null && warning.compare_label !== "hard cap") {
    parts.push(`hard cap: ${formatDecimalBytes(warning.hard_limit)}`);
  }
  return `Total account storage is nearing or over its limit. ${parts.join(" • ")}`;
}

export const AccountStorageWarning: React.FC<{
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
      ACCOUNT_STORAGE_WARNING_POLL_MS,
    );
    const refresh = () => void load();
    window.addEventListener("cocalc:membership-changed", refresh);
    return () => {
      mounted = false;
      clearInterval(interval);
      window.removeEventListener("cocalc:membership-changed", refresh);
    };
  }, [account_id, is_logged_in]);

  const warning = useMemo(() => getAccountStorageWarning(details), [details]);
  const warningKey =
    warning?.severity === "warning"
      ? `${warning.compare_label}:${warning.severity}`
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

  const modalTitle =
    warning.severity === "blocked"
      ? "Total account storage hard cap reached"
      : warning.over_soft
        ? "Total account storage soft cap reached"
        : "Total account storage warning";

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
          data-cocalc-account-storage-warning
        >
          <div style={pillStyle}>
            <Icon name="hdd" />
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
            Total account storage is the sum of current quota-used bytes across
            your owned provisioned projects. This includes retained
            snapshot/history data because project quota includes it. When the
            soft cap is reached, storage-increasing operations such as project
            creation, clone, copy, and restore are blocked. At the hard cap,
            those operations remain blocked until you delete data or upgrade
            membership.
          </Text>
          <div>
            <Space
              align="center"
              style={{ width: "100%", justifyContent: "space-between" }}
            >
              <Text strong>Current usage</Text>
              <Text
                type={
                  warning.severity === "blocked" || warning.over_soft
                    ? "danger"
                    : undefined
                }
              >
                {formatDecimalBytes(warning.used)}
              </Text>
            </Space>
          </div>
          {warning.soft_limit != null && (
            <div>
              <Space
                align="center"
                style={{ width: "100%", justifyContent: "space-between" }}
              >
                <Text strong>Soft cap</Text>
                <Text type={warning.over_soft ? "danger" : undefined}>
                  {formatDecimalBytes(warning.used)} of{" "}
                  {formatDecimalBytes(warning.soft_limit)} (
                  {Math.round((warning.used / warning.soft_limit) * 100)}%)
                </Text>
              </Space>
              <div style={{ marginTop: "6px" }}>
                <Progress
                  percent={Math.min(
                    100,
                    Math.round((warning.used / warning.soft_limit) * 100),
                  )}
                  status={
                    warning.over_soft || warning.severity === "severe"
                      ? "exception"
                      : "active"
                  }
                />
              </div>
            </div>
          )}
          {warning.hard_limit != null && (
            <div>
              <Space
                align="center"
                style={{ width: "100%", justifyContent: "space-between" }}
              >
                <Text strong>Hard cap</Text>
                <Text type={warning.over_hard ? "danger" : undefined}>
                  {formatDecimalBytes(warning.used)} of{" "}
                  {formatDecimalBytes(warning.hard_limit)} (
                  {Math.round((warning.used / warning.hard_limit) * 100)}%)
                </Text>
              </Space>
              <div style={{ marginTop: "6px" }}>
                <Progress
                  percent={Math.min(
                    100,
                    Math.round((warning.used / warning.hard_limit) * 100),
                  )}
                  status={warning.over_hard ? "exception" : "active"}
                />
              </div>
            </div>
          )}
          {warning.partial_measurement ? (
            <Text type="secondary">
              Current storage usage is only partially sampled from your
              projects, so totals may temporarily be incomplete.
            </Text>
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
