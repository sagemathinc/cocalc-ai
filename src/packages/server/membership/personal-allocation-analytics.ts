/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { PoolClient } from "@cocalc/database/pool";
import { toDecimal, type MoneyValue } from "@cocalc/util/money";
import type {
  Interval,
  MembershipMetadata,
  PendingMembershipPlanChange,
} from "@cocalc/util/db-schema/subscriptions";
import {
  recordMembershipAllocationFact,
  type MembershipAllocationBillingInterval,
  type MembershipAllocationLifecycle,
  type MembershipAllocationTierChange,
} from "./allocation-analytics";

type Queryable = Pick<PoolClient, "query">;

interface PersonalMembershipAllocationIdentity {
  membership_class: string;
  billing_interval: "trial" | Interval;
}

interface PersonalMembershipSubscriptionRow {
  interval: Interval;
  latest_purchase_id?: number | null;
  metadata: MembershipMetadata;
}

export interface PersonalMembershipPeriodOptions {
  account_id: string;
  subscription_id: number;
  purchase_id?: number;
  occurred_at?: Date;
  membership_class: string;
  billing_interval: Interval;
  lifecycle: MembershipAllocationLifecycle;
  allocation_start: Date;
  allocation_end: Date;
  revenue: MoneyValue;
  previous_membership_class?: string | null;
  previous_billing_interval?: MembershipAllocationBillingInterval | null;
  tier_change?: MembershipAllocationTierChange;
  client: Queryable;
}

function factIdentity({
  subscription_id,
  purchase_id,
  lifecycle,
}: Pick<
  PersonalMembershipPeriodOptions,
  "subscription_id" | "purchase_id" | "lifecycle"
>): string {
  return purchase_id == null
    ? `personal:subscription:${subscription_id}:${lifecycle}`
    : `personal:purchase:${purchase_id}:${lifecycle}`;
}

function nextUtcDay(value: Date): Date {
  const date = new Date(value);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

function allocationEndAfterStart(start: Date, end: Date): Date {
  return start.toISOString().slice(0, 10) < end.toISOString().slice(0, 10)
    ? end
    : nextUtcDay(start);
}

export async function getPersonalMembershipAllocationIdentity({
  subscription_id,
  client,
}: {
  subscription_id: number;
  client: Queryable;
}): Promise<PersonalMembershipAllocationIdentity> {
  const { rows } = await client.query<PersonalMembershipSubscriptionRow>(
    `SELECT interval, latest_purchase_id, metadata
       FROM subscriptions
      WHERE id=$1
        AND metadata->>'type'='membership'`,
    [subscription_id],
  );
  const subscription = rows[0];
  if (!subscription?.metadata?.class) {
    throw Error(`membership subscription ${subscription_id} was not found`);
  }
  return {
    membership_class: subscription.metadata.class,
    billing_interval:
      subscription.metadata.trial === true &&
      subscription.latest_purchase_id == null
        ? "trial"
        : subscription.interval,
  };
}

export async function recordPersonalMembershipTrial({
  account_id,
  subscription_id,
  membership_class,
  allocation_start,
  allocation_end,
  client,
}: Omit<
  PersonalMembershipPeriodOptions,
  "billing_interval" | "lifecycle" | "revenue"
>): Promise<boolean> {
  return await recordMembershipAllocationFact({
    fact_key: `personal:subscription:${subscription_id}:trial`,
    occurred_at: allocation_start,
    account_id,
    channel: "personal",
    source_kind: "trial",
    membership_class,
    billing_interval: "trial",
    lifecycle: "trial",
    allocation_start,
    allocation_end,
    active_memberships: 1,
    subscription_id,
    client,
  });
}

export async function recordPersonalMembershipPeriod({
  account_id,
  subscription_id,
  purchase_id,
  occurred_at = new Date(),
  membership_class,
  billing_interval,
  lifecycle,
  allocation_start,
  allocation_end,
  revenue,
  previous_membership_class = null,
  previous_billing_interval = null,
  tier_change = "none",
  client,
}: PersonalMembershipPeriodOptions): Promise<boolean> {
  return await recordMembershipAllocationFact({
    fact_key: factIdentity({ subscription_id, purchase_id, lifecycle }),
    occurred_at,
    account_id,
    channel: "personal",
    source_kind: lifecycle === "plan_change" ? "plan-change" : "purchase",
    membership_class,
    billing_interval,
    lifecycle,
    previous_membership_class,
    previous_billing_interval,
    tier_change,
    allocation_start,
    allocation_end,
    active_memberships: 1,
    revenue,
    purchase_id,
    subscription_id,
    client,
  });
}

export async function recordPersonalMembershipUpgradeCredit({
  account_id,
  old_subscription_id,
  new_subscription_id,
  purchase_id,
  membership_class,
  billing_interval,
  allocation_start,
  allocation_end,
  credit,
  client,
}: {
  account_id: string;
  old_subscription_id: number;
  new_subscription_id: number;
  purchase_id?: number;
  membership_class: string;
  billing_interval: MembershipAllocationBillingInterval;
  allocation_start: Date;
  allocation_end: Date;
  credit: MoneyValue;
  client: Queryable;
}): Promise<boolean> {
  return await recordMembershipAllocationFact({
    fact_key: `personal:subscription:${new_subscription_id}:upgrade-credit:${old_subscription_id}`,
    occurred_at: allocation_start,
    account_id,
    channel: "personal",
    source_kind: "plan-change-credit",
    membership_class,
    billing_interval,
    lifecycle: "plan_change",
    tier_change: "upgrade",
    allocation_start,
    allocation_end: allocationEndAfterStart(allocation_start, allocation_end),
    active_memberships: -1,
    revenue: toDecimal(credit).neg(),
    purchase_id,
    subscription_id: old_subscription_id,
    client,
  });
}

export function getPendingMembershipPlanChange(
  metadata: MembershipMetadata,
): PendingMembershipPlanChange | undefined {
  const pending = metadata.pending_plan_change;
  if (
    pending?.kind !== "downgrade" ||
    !pending.previous_class ||
    !["trial", "month", "year"].includes(pending.previous_interval)
  ) {
    return;
  }
  return pending;
}

export function consumePendingMembershipPlanChange(
  metadata: MembershipMetadata,
): {
  metadata: MembershipMetadata;
  pending?: PendingMembershipPlanChange;
} {
  const pending = getPendingMembershipPlanChange(metadata);
  if (!pending) return { metadata };
  const { pending_plan_change: _, ...remaining } = metadata;
  return { metadata: remaining as MembershipMetadata, pending };
}
