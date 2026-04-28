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
import type { AIUsageStatus as AIUsageStatusResponse } from "@cocalc/conat/hub/api/purchases";
import { COLORS } from "@cocalc/util/theme";
import {
  MANAGED_EGRESS_SEVERE_THRESHOLD,
  MANAGED_EGRESS_WARNING_THRESHOLD,
} from "./managed-egress-warning";

const { Text } = Typography;

const AI_USAGE_WARNING_POLL_MS = 60_000;

type WarningSeverity = "warning" | "severe" | "blocked";

export interface AIWindowWarning {
  window: "5h" | "7d";
  used: number;
  limit: number;
  remaining?: number;
  reset_at?: Date | string;
  reset_in?: string;
  ratio: number;
  percent: number;
  severity: WarningSeverity;
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

export function getAIWindowWarnings(
  status: AIUsageStatusResponse | null | undefined,
  threshold = MANAGED_EGRESS_WARNING_THRESHOLD,
): AIWindowWarning[] {
  const warnings: AIWindowWarning[] = [];
  for (const window of status?.windows ?? []) {
    if (
      typeof window.limit !== "number" ||
      !Number.isFinite(window.limit) ||
      !(window.limit > 0)
    ) {
      continue;
    }
    const ratio = window.used / window.limit;
    if (!(ratio >= threshold)) continue;
    warnings.push({
      ...window,
      limit: window.limit,
      ratio,
      percent: Math.round(ratio * 100),
      severity:
        ratio >= 1
          ? "blocked"
          : ratio >= MANAGED_EGRESS_SEVERE_THRESHOLD
            ? "severe"
            : "warning",
    });
  }
  warnings.sort((a, b) => {
    const order: Record<WarningSeverity, number> = {
      blocked: 0,
      severe: 1,
      warning: 2,
    };
    if (a.severity !== b.severity) return order[a.severity] - order[b.severity];
    return b.ratio - a.ratio;
  });
  return warnings;
}

function getSummaryLabel(warning: AIWindowWarning, isNarrow: boolean): string {
  if (warning.severity === "blocked") {
    return isNarrow ? "AI blocked" : "AI blocked";
  }
  if (isNarrow) {
    return `AI ${warning.window} ${warning.percent}%`;
  }
  return `AI ${warning.window} ${warning.percent}%`;
}

function getSummaryTooltip(warnings: AIWindowWarning[]): string {
  if (warnings.length === 0) return "";
  return warnings
    .map(
      (warning) =>
        `${warning.window}: ${warning.used} of ${warning.limit} units (${warning.percent}%)`,
    )
    .join(" • ");
}

export const AIUsageWarning: React.FC<{
  pageStyle: PageStyle;
}> = React.memo(({ pageStyle }: { pageStyle: PageStyle }) => {
  const account_id = useTypedRedux("account", "account_id");
  const is_logged_in = useTypedRedux("account", "is_logged_in");
  const page_actions = useActions("page");
  const [status, setStatus] = useState<AIUsageStatusResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const [dismissedWarningKey, setDismissedWarningKey] = useState<
    string | undefined
  >();

  useEffect(() => {
    if (!account_id || !is_logged_in) {
      setStatus(null);
      return;
    }
    let mounted = true;
    const load = async () => {
      try {
        const next = await webapp_client.conat_client.hub.purchases.getAIUsage(
          {},
        );
        if (mounted) {
          setStatus((next as AIUsageStatusResponse) ?? null);
        }
      } catch {
        if (mounted) {
          setStatus(null);
        }
      }
    };
    void load();
    const interval = setInterval(() => void load(), AI_USAGE_WARNING_POLL_MS);
    const refresh = () => void load();
    window.addEventListener("cocalc:membership-changed", refresh);
    return () => {
      mounted = false;
      clearInterval(interval);
      window.removeEventListener("cocalc:membership-changed", refresh);
    };
  }, [account_id, is_logged_in]);

  const warnings = useMemo(() => getAIWindowWarnings(status), [status]);
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

  const modalTitle =
    primary.severity === "blocked"
      ? "AI usage limit reached"
      : primary.severity === "severe"
        ? "AI usage warning"
        : "AI usage nearing limit";

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
          data-cocalc-ai-usage-warning
        >
          <div style={pillStyle}>
            <Icon name="robot" />
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
        width={720}
      >
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Text>
            AI API usage is limited by both a 5-hour window and a 7-day window.
            When a limit is hit, AI features stop until usage rolls out of the
            window.
          </Text>
          {warnings.map((warning) => (
            <div key={warning.window}>
              <Space
                align="center"
                style={{ width: "100%", justifyContent: "space-between" }}
              >
                <Text strong>{warning.window} window</Text>
                <Text
                  type={warning.severity === "blocked" ? "danger" : undefined}
                >
                  {warning.used} of {warning.limit} units ({warning.percent}%)
                </Text>
              </Space>
              {(warning.reset_at || warning.reset_in) && (
                <div style={{ marginTop: "4px" }}>
                  <Text type="secondary">
                    {warning.reset_at
                      ? `Next reset ${formatResetAt(warning.reset_at)}`
                      : ""}
                    {warning.reset_in ? ` · in ${warning.reset_in}` : ""}
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
          ))}
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
