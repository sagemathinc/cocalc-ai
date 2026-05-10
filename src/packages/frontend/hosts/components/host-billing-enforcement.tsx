/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Space, Tag, Typography } from "antd";
import { React } from "@cocalc/frontend/app-framework";
import type {
  Host,
  HostBillingEnforcement,
  HostBillingEnforcementState,
  HostBillingRecoveryAction,
} from "@cocalc/conat/hub/api/hosts";

type BillingDisplay = {
  label: string;
  tagColor: string;
  alertType: "info" | "warning" | "error";
  description: string;
  blocksStart: boolean;
};

const BILLING_STATE_DISPLAY: Record<
  Exclude<HostBillingEnforcementState, "ok">,
  BillingDisplay
> = {
  at_risk: {
    label: "Billing at risk",
    tagColor: "orange",
    alertType: "warning",
    description:
      "Billing is close to a limit. This host may be backed up and stopped unless billing is resolved.",
    blocksStart: false,
  },
  draining: {
    label: "Final backup running",
    tagColor: "blue",
    alertType: "info",
    description:
      "Projects are being backed up before the host is stopped for billing.",
    blocksStart: true,
  },
  stopped_billing_blocked: {
    label: "Stopped: billing required",
    tagColor: "red",
    alertType: "error",
    description:
      "Compute is stopped. Fix billing or contact support before starting this host.",
    blocksStart: true,
  },
  deprovision_pending: {
    label: "Disk removal scheduled",
    tagColor: "red",
    alertType: "error",
    description:
      "Persistent disk removal is scheduled. Project data remains recoverable from backups after deprovision.",
    blocksStart: true,
  },
  deprovisioned_recoverable: {
    label: "Provider disk removed",
    tagColor: "purple",
    alertType: "warning",
    description:
      "The provider disk has been removed. Project data can be restored from backups to another host.",
    blocksStart: true,
  },
};

const RECOVERY_ACTION_LABELS: Record<HostBillingRecoveryAction, string> = {
  add_funds: "Add funds",
  fix_payment: "Fix payment",
  support_limit_increase: "Contact support for a limit increase",
};

export function getHostBillingEnforcement(
  host: Pick<Host, "billing_enforcement">,
): HostBillingEnforcement | undefined {
  const enforcement = host.billing_enforcement;
  if (!enforcement || enforcement.state === "ok") return undefined;
  if (!(enforcement.state in BILLING_STATE_DISPLAY)) return undefined;
  return enforcement;
}

export function hostBillingEnforcementBlocksStart(
  host: Pick<Host, "billing_enforcement">,
): boolean {
  const enforcement = getHostBillingEnforcement(host);
  if (!enforcement) return false;
  return BILLING_STATE_DISPLAY[enforcement.state].blocksStart;
}

export function hostBillingEnforcementSearchText(
  host: Pick<Host, "billing_enforcement">,
): string {
  const enforcement = getHostBillingEnforcement(host);
  if (!enforcement) return "";
  const display = BILLING_STATE_DISPLAY[enforcement.state];
  return [
    display.label,
    enforcement.state,
    enforcement.reason_code,
    enforcement.reason,
    ...(enforcement.recovery_actions ?? []).map(
      (action) => RECOVERY_ACTION_LABELS[action] ?? action,
    ),
  ]
    .filter(Boolean)
    .join(" ");
}

function formatDateTime(value?: string): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return undefined;
  return new Date(timestamp).toLocaleString();
}

function formatRunway(hours?: number): string | undefined {
  if (hours == null || !Number.isFinite(hours)) return undefined;
  if (hours < 1) return `${Math.max(0, Math.round(hours * 60))} min runway`;
  if (hours < 24) return `${hours.toFixed(1)} hr runway`;
  return `${(hours / 24).toFixed(1)} day runway`;
}

function detailLines(enforcement: HostBillingEnforcement): React.ReactNode[] {
  const lines: React.ReactNode[] = [];
  const runway = formatRunway(enforcement.limiting_runway_hours);
  if (enforcement.reason) {
    lines.push(enforcement.reason);
  }
  if (runway) {
    lines.push(runway);
  }
  const deprovisionAfter = formatDateTime(enforcement.deprovision_after);
  const graceUntil = formatDateTime(enforcement.grace_until);
  if (deprovisionAfter) {
    lines.push(`Disk removal after ${deprovisionAfter}`);
  } else if (graceUntil) {
    lines.push(`Disk grace until ${graceUntil}`);
  }
  if (enforcement.final_backup_status) {
    lines.push(`Final backup: ${enforcement.final_backup_status}`);
  }
  if (enforcement.recovery_actions?.length) {
    lines.push(
      `Recovery: ${enforcement.recovery_actions
        .map((action) => RECOVERY_ACTION_LABELS[action] ?? action)
        .join(", ")}`,
    );
  }
  return lines;
}

export function HostBillingEnforcementStatus({
  host,
  compact,
}: {
  host: Pick<Host, "billing_enforcement">;
  compact?: boolean;
}) {
  const enforcement = getHostBillingEnforcement(host);
  if (!enforcement) return null;
  const display = BILLING_STATE_DISPLAY[enforcement.state];
  const details = detailLines(enforcement);

  if (compact) {
    return (
      <Space orientation="vertical" size={0}>
        <Tag color={display.tagColor}>{display.label}</Tag>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {details[0] ?? display.description}
        </Typography.Text>
      </Space>
    );
  }

  return (
    <Alert
      showIcon
      type={display.alertType}
      title={display.label}
      description={
        <Space orientation="vertical" size={2}>
          <Typography.Text>{display.description}</Typography.Text>
          {details.map((line, index) => (
            <Typography.Text key={index} type="secondary">
              {line}
            </Typography.Text>
          ))}
        </Space>
      }
    />
  );
}
