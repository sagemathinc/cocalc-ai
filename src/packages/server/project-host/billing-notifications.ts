/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import sendSystemMessage from "@cocalc/server/messages/send";
import type {
  DedicatedHostBillingEnforcementState,
  DedicatedHostBillingRecoveryAction,
} from "./spend-enforcement";

const logger = getLogger("server:project-host:billing-notifications");

type StateDisplay = {
  title: (hostName: string) => string;
  body: string;
};

const STATE_DISPLAY: Record<
  DedicatedHostBillingEnforcementState,
  StateDisplay
> = {
  ok: {
    title: (hostName) => `Dedicated host ${hostName} billing recovered`,
    body: "Billing has recovered and the host can be started again.",
  },
  at_risk: {
    title: (hostName) => `Dedicated host ${hostName} billing needs attention`,
    body: "Billing is close to a limit. If it is not resolved, CoCalc will back up projects and stop the host.",
  },
  draining: {
    title: (hostName) =>
      `Dedicated host ${hostName} is backing up because billing needs attention`,
    body: "CoCalc is backing up projects and draining this host before stopping it for billing.",
  },
  stopped_billing_blocked: {
    title: (hostName) =>
      `Dedicated host ${hostName} was stopped because billing needs attention`,
    body: "Compute has been stopped. Fix billing or contact support before starting this host.",
  },
  deprovision_pending: {
    title: (hostName) => `Dedicated host ${hostName} disk removal is scheduled`,
    body: "The provider disk is scheduled for removal. Project data remains recoverable from backups after deprovision.",
  },
  deprovisioned_recoverable: {
    title: (hostName) => `Dedicated host ${hostName} provider disk was removed`,
    body: "The provider disk has been removed. Project data can be restored from backups to another host under normal backup retention.",
  },
};

const RECOVERY_ACTION_LABELS: Record<
  DedicatedHostBillingRecoveryAction,
  string
> = {
  add_funds: "add funds",
  fix_payment: "fix the payment method",
  support_limit_increase: "contact support and request a limit increase",
};

function hostLabel(host_name?: string | null): string {
  const name = `${host_name ?? ""}`.trim();
  return name || "Host";
}

function formatDateTime(value?: string): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return undefined;
  return new Date(timestamp).toLocaleString();
}

function bodyMarkdown(opts: {
  host_id: string;
  host_name?: string | null;
  state: DedicatedHostBillingEnforcementState;
  reason?: string;
  final_backup_status?: string;
  deprovision_after?: string;
  recovery_actions?: DedicatedHostBillingRecoveryAction[];
}): string {
  const display = STATE_DISPLAY[opts.state];
  const lines = [
    display.body,
    "",
    `Host: **${hostLabel(opts.host_name)}**`,
    `Host ID: \`${opts.host_id}\``,
  ];
  if (opts.reason) {
    lines.push(`Reason: ${opts.reason}`);
  }
  if (opts.final_backup_status) {
    lines.push(`Final backup: ${opts.final_backup_status}`);
  }
  const deprovisionAfter = formatDateTime(opts.deprovision_after);
  if (deprovisionAfter) {
    lines.push(`Provider disk removal after: ${deprovisionAfter}`);
  }
  if (opts.recovery_actions?.length) {
    lines.push(
      `Recovery options: ${opts.recovery_actions
        .map((action) => RECOVERY_ACTION_LABELS[action] ?? action)
        .join(", ")}.`,
    );
  }
  return lines.join("\n");
}

export async function notifyDedicatedHostBillingEnforcement(opts: {
  owner_account_id: string;
  host_id: string;
  host_name?: string | null;
  state: DedicatedHostBillingEnforcementState;
  previous_state?: DedicatedHostBillingEnforcementState;
  reason?: string;
  final_backup_status?: string;
  deprovision_after?: string;
  recovery_actions?: DedicatedHostBillingRecoveryAction[];
}) {
  const owner = `${opts.owner_account_id ?? ""}`.trim();
  if (!owner) return;
  if (opts.previous_state === opts.state) return;
  const display = STATE_DISPLAY[opts.state];
  const title = display.title(hostLabel(opts.host_name));
  const body_markdown = bodyMarkdown(opts);
  await sendSystemMessage({
    to_ids: [owner],
    subject: title,
    body: `${body_markdown}\n\nOpen dedicated hosts: [/hosts](/hosts)`,
    dedupMinutes: 24 * 60,
  });
}

export async function notifyDedicatedHostBillingEnforcementBestEffort(
  opts: Parameters<typeof notifyDedicatedHostBillingEnforcement>[0],
) {
  try {
    await notifyDedicatedHostBillingEnforcement(opts);
  } catch (err) {
    logger.warn("failed to create dedicated host billing notification", {
      host_id: opts.host_id,
      owner_account_id: opts.owner_account_id,
      state: opts.state,
      err: `${err}`,
    });
  }
}
