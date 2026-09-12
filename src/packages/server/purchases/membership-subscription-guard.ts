/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { PoolClient } from "@cocalc/database/pool";
import type { Status } from "@cocalc/util/db-schema/subscriptions";

type Queryable = Pick<PoolClient, "query">;

const LOCK_PREFIX = "membership-subscription-account:";

export class MembershipSubscriptionConflictError extends Error {
  code = "membership_subscription_conflict";

  constructor({
    account_id,
    competingIds,
  }: {
    account_id: string;
    competingIds: number[];
  }) {
    super(
      `account ${account_id} already has a conflicting personal ` +
        `membership subscription (id=${competingIds.join(",")})`,
    );
    this.name = "MembershipSubscriptionConflictError";
  }
}

export class MembershipRenewalInProgressError extends Error {
  code = "membership_renewal_in_progress";

  constructor({
    account_id,
    subscription_id,
  }: {
    account_id: string;
    subscription_id: number;
  }) {
    super(
      `membership subscription ${subscription_id} for account ${account_id} ` +
        "is renewing; wait for the renewal to finish before changing it",
    );
    this.name = "MembershipRenewalInProgressError";
  }
}

export async function lockMembershipSubscriptionAccount({
  account_id,
  client,
}: {
  account_id: string;
  client: PoolClient;
}): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `${LOCK_PREFIX}${account_id}`,
  ]);
}

export async function getRenewableMembershipSubscriptions({
  account_id,
  client,
  forUpdate = false,
}: {
  account_id: string;
  client: Queryable;
  forUpdate?: boolean;
}): Promise<{ id: number; current_period_end: Date; status: Status }[]> {
  const { rows } = await client.query<{
    id: number;
    current_period_end: Date;
    status: Status;
  }>(
    `SELECT id, current_period_end, status
       FROM subscriptions
      WHERE account_id=$1
        AND metadata->>'type'='membership'
        AND status='active'
      ORDER BY id
      ${forUpdate ? "FOR UPDATE" : ""}`,
    [account_id],
  );
  return rows;
}

export async function assertNoCompetingMembershipSubscription({
  account_id,
  subscription_id,
  client,
}: {
  account_id: string;
  subscription_id?: number;
  client: Queryable;
}): Promise<void> {
  const rows = await getRenewableMembershipSubscriptions({
    account_id,
    client,
  });
  const competing = rows.filter(({ id }) => id !== subscription_id);
  if (competing.length > 0) {
    throw new MembershipSubscriptionConflictError({
      account_id,
      competingIds: competing.map(({ id }) => id),
    });
  }
}

export async function assertNoDueMembershipRenewal({
  account_id,
  client,
}: {
  account_id: string;
  client: Queryable;
}): Promise<void> {
  const { rows } = await client.query<{ subscription_id: number }>(
    `SELECT a.subscription_id
       FROM subscription_renewal_attempts a
      WHERE a.account_id=$1
        AND a.state IN ('scheduled','processing')
        AND a.not_before <= NOW()
      ORDER BY a.not_before, a.subscription_id
      LIMIT 1`,
    [account_id],
  );
  if (rows[0]) {
    throw new MembershipRenewalInProgressError({
      account_id,
      subscription_id: rows[0].subscription_id,
    });
  }
}
