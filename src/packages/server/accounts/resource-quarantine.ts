/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { listClusterBayInfos } from "@cocalc/server/bay-registry";
import { listHosts, stopHost } from "@cocalc/server/conat/api/hosts";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";
import { cancelUsageSubscription } from "@cocalc/server/purchases/stripe-usage-based-subscription";
import { cancelPaymentIntent } from "@cocalc/server/purchases/stripe/create-payment-intent";
import { getAllOpenPayments } from "@cocalc/server/purchases/stripe/get-payments";
import getPaymentMethods from "@cocalc/server/purchases/stripe/get-payment-methods";
import deletePaymentMethod from "@cocalc/server/purchases/stripe/delete-payment-method";
import type { ProjectRuntimeSlotReportSlot } from "@cocalc/conat/hub/api/system";
import { recordAccountResourceQuarantineAuditEvent } from "./resource-quarantine-audit";

const logger = getLogger("accounts:resource-quarantine");

export interface AccountResourceQuarantineResult {
  account_id: string;
  home_bay_id: string;
  auto_balance_disabled: boolean;
  checkout_session_cleared: boolean;
  usage_subscription_canceled: boolean;
  local_subscriptions_canceled: number;
  payment_intents_canceled: number;
  payment_methods_detached: number;
  hosts_stop_requested: number;
  host_ids: string[];
  projects_stop_requested: number;
  project_ids: string[];
  errors: string[];
}

function normalizeReason(reason?: string | null): string {
  return `${reason ?? ""}`.trim().slice(0, 4000);
}

async function cancelLocalSubscriptions({
  account_id,
  reason,
}: {
  account_id: string;
  reason: string;
}): Promise<number> {
  const { rowCount } = await getPool().query(
    `
      UPDATE subscriptions
      SET status='canceled',
          canceled_at=NOW(),
          canceled_reason=$2,
          payment=NULL,
          resume_payment_intent=NULL
      WHERE account_id=$1
        AND status != 'canceled'
    `,
    [account_id, reason],
  );
  return rowCount ?? 0;
}

async function disableAutomaticBillingState(account_id: string): Promise<{
  auto_balance_disabled: boolean;
  checkout_session_cleared: boolean;
}> {
  const { rows } = await getPool().query(
    `
      UPDATE accounts
      SET auto_balance=NULL,
          stripe_checkout_session='{}'::jsonb,
          balance_alert=false
      WHERE account_id=$1
      RETURNING auto_balance, stripe_checkout_session
    `,
    [account_id],
  );
  if (rows.length === 0) {
    throw Error(`account ${account_id} not found`);
  }
  return {
    auto_balance_disabled: true,
    checkout_session_cleared: true,
  };
}

async function cancelOpenPaymentIntents(account_id: string): Promise<number> {
  const payments = await getAllOpenPayments(account_id);
  let count = 0;
  for (const intent of payments.data ?? []) {
    if (!intent?.id) {
      continue;
    }
    await cancelPaymentIntent({ id: intent.id, reason: "fraudulent" });
    count += 1;
  }
  return count;
}

async function detachPaymentMethods(account_id: string): Promise<number> {
  let count = 0;
  let starting_after: string | undefined = undefined;
  do {
    const methods = await getPaymentMethods({
      account_id,
      starting_after,
      limit: 100,
    });
    for (const method of methods.data ?? []) {
      if (!method?.id) {
        continue;
      }
      await deletePaymentMethod({ account_id, payment_method: method.id });
      count += 1;
      starting_after = method.id;
    }
    if (!methods.has_more) {
      break;
    }
  } while (starting_after);
  return count;
}

async function stopOwnedDedicatedHosts({
  account_id,
  actor_account_id,
}: {
  account_id: string;
  actor_account_id?: string | null;
}): Promise<{ count: number; host_ids: string[] }> {
  const actor = actor_account_id ?? account_id;
  const rows = await listHosts({
    account_id: actor,
    admin_view: true,
    trusted_admin_view: true,
    show_all: true,
  });
  const host_ids: string[] = [];
  for (const { billing_owner_account_id, id, status } of rows) {
    if (
      billing_owner_account_id !== account_id ||
      ["off", "stopping", "deleted"].includes(`${status ?? ""}`)
    ) {
      continue;
    }
    await stopHost({
      account_id: actor,
      id,
    });
    host_ids.push(id);
  }
  return { count: host_ids.length, host_ids };
}

type RuntimeSlotProjectRow = {
  project_id: string;
  owning_bay_id: string;
};

async function listRuntimeSlotProjects(
  account_id: string,
): Promise<RuntimeSlotProjectRow[]> {
  const { rows } = await getPool().query<RuntimeSlotProjectRow>(
    `
      SELECT DISTINCT ON (project_id)
             project_id,
             owning_bay_id
        FROM project_runtime_slots
       WHERE sponsor_account_id=$1
         AND state IN ('starting', 'running')
       ORDER BY project_id, heartbeat_at DESC
    `,
    [account_id],
  );
  return rows;
}

async function listRemoteRuntimeSlotProjects({
  account_id,
  actor_account_id,
  bay_id,
}: {
  account_id: string;
  actor_account_id?: string | null;
  bay_id: string;
}): Promise<RuntimeSlotProjectRow[]> {
  if (!actor_account_id) {
    throw new Error(
      "actor_account_id is required to enumerate remote runtime slots",
    );
  }
  const report = await getInterBayBridge()
    .bayOps(bay_id, { timeout_ms: 15_000 })
    .getProjectRuntimeSlotReport({
      account_id: actor_account_id,
      sponsor_account_id: account_id,
      active_only: true,
      limit: 1000,
    });
  return (report.slots ?? []).map((slot: ProjectRuntimeSlotReportSlot) => ({
    project_id: slot.project_id,
    owning_bay_id: slot.owning_bay_id || bay_id,
  }));
}

async function listClusterRuntimeSlotProjects({
  account_id,
  actor_account_id,
}: {
  account_id: string;
  actor_account_id?: string | null;
}): Promise<{ projects: RuntimeSlotProjectRow[]; errors: string[] }> {
  const currentBayId = getConfiguredBayId();
  const bays = await listClusterBayInfos();
  const projects = new Map<string, RuntimeSlotProjectRow>();
  const errors: string[] = [];
  for (const bay of bays.length > 0 ? bays : [{ bay_id: currentBayId }]) {
    const bay_id = `${bay.bay_id ?? ""}`.trim() || currentBayId;
    try {
      const rows =
        bay_id === currentBayId
          ? await listRuntimeSlotProjects(account_id)
          : await listRemoteRuntimeSlotProjects({
              account_id,
              actor_account_id,
              bay_id,
            });
      for (const row of rows) {
        projects.set(row.project_id, row);
      }
    } catch (err) {
      const message = `list runtime slot projects on ${bay_id}: ${err}`;
      errors.push(message);
      logger.warn(message);
    }
  }
  return { projects: [...projects.values()], errors };
}

async function stopRuntimeSlotProjects({
  account_id,
  actor_account_id,
}: {
  account_id: string;
  actor_account_id?: string | null;
}): Promise<{ count: number; project_ids: string[]; errors: string[] }> {
  const stopped: string[] = [];
  const { projects, errors } = await listClusterRuntimeSlotProjects({
    account_id,
    actor_account_id,
  });
  for (const { project_id, owning_bay_id } of projects) {
    try {
      await getInterBayBridge()
        .projectControl(owning_bay_id)
        .stop({ project_id });
      stopped.push(project_id);
    } catch (err) {
      const message = `stop runtime slot project ${project_id}: ${err}`;
      errors.push(message);
      logger.warn(message);
    }
  }
  return { count: stopped.length, project_ids: stopped, errors };
}

async function attempt<T>({
  errors,
  label,
  fn,
  fallback,
}: {
  errors: string[];
  label: string;
  fn: () => Promise<T>;
  fallback: T;
}): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const message = `${label}: ${err}`;
    errors.push(message);
    logger.warn(message);
    return fallback;
  }
}

export async function quarantineAccountBillingResourcesLocal({
  account_id,
  actor_account_id,
  reason,
  home_bay_id,
}: {
  account_id: string;
  actor_account_id?: string | null;
  reason?: string | null;
  home_bay_id: string;
}): Promise<AccountResourceQuarantineResult> {
  const normalizedReason =
    normalizeReason(reason) || "admin billing/resource quarantine";
  const errors: string[] = [];

  const automaticBilling = await disableAutomaticBillingState(account_id);
  const local_subscriptions_canceled = await cancelLocalSubscriptions({
    account_id,
    reason: normalizedReason,
  });
  const usage_subscription_canceled = await attempt({
    errors,
    label: "cancel Stripe usage subscription",
    fallback: false,
    fn: async () => {
      await cancelUsageSubscription(account_id);
      await getPool().query(
        "UPDATE accounts SET stripe_usage_subscription='' WHERE account_id=$1",
        [account_id],
      );
      return true;
    },
  });
  const payment_intents_canceled = await attempt({
    errors,
    label: "cancel open Stripe payment intents",
    fallback: 0,
    fn: async () => await cancelOpenPaymentIntents(account_id),
  });
  const payment_methods_detached = await attempt({
    errors,
    label: "detach Stripe payment methods",
    fallback: 0,
    fn: async () => await detachPaymentMethods(account_id),
  });
  const stoppedHosts = await attempt({
    errors,
    label: "stop owned dedicated hosts",
    fallback: { count: 0, host_ids: [] },
    fn: async () =>
      await stopOwnedDedicatedHosts({ account_id, actor_account_id }),
  });
  const stoppedProjects = await attempt({
    errors,
    label: "stop projects using account runtime slots",
    fallback: { count: 0, project_ids: [], errors: [] },
    fn: async () =>
      await stopRuntimeSlotProjects({ account_id, actor_account_id }),
  });
  errors.push(...stoppedProjects.errors);

  const result: AccountResourceQuarantineResult = {
    account_id,
    home_bay_id,
    ...automaticBilling,
    usage_subscription_canceled,
    local_subscriptions_canceled,
    payment_intents_canceled,
    payment_methods_detached,
    hosts_stop_requested: stoppedHosts.count,
    host_ids: stoppedHosts.host_ids,
    projects_stop_requested: stoppedProjects.count,
    project_ids: stoppedProjects.project_ids,
    errors,
  };

  await recordAccountResourceQuarantineAuditEvent({
    account_id,
    actor_account_id,
    reason: normalizedReason,
    result: result as unknown as Record<string, unknown>,
  });
  return result;
}
