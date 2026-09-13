/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import getPool, { type PoolClient } from "@cocalc/database/pool";
import type {
  SubscriptionRenewalAttempt,
  SubscriptionRenewalAttemptState,
} from "@cocalc/util/db-schema/subscription-renewal-attempts";
import { toDecimal } from "@cocalc/util/money";
import { lockAccountSpending } from "./lock-account-spending";
import { getConfiguredBayId } from "@cocalc/server/bay-config";

type Queryable = Pick<PoolClient, "query">;

export const RENEWAL_ATTEMPT_LEASE_MS = 2 * 60 * 1000;
const RENEWAL_ATTEMPT_RETRY_MS = 60 * 1000;

function queryable(client?: Queryable): Queryable {
  return client ?? getPool();
}

export async function scheduleSubscriptionRenewalAttempt({
  subscription_id,
  account_id,
  client,
}: {
  subscription_id: number;
  account_id: string;
  client?: Queryable;
}): Promise<string | undefined> {
  const { rows } = await queryable(client).query<{ id: string }>(
    `INSERT INTO subscription_renewal_attempts
       (id, subscription_id, account_id, period_end, target_period_end,
        amount, funding_version, state, not_before, next_attempt_at, attempt_count,
        created_at, updated_at)
     SELECT gen_random_uuid(), s.id, s.account_id, s.current_period_end,
            s.current_period_end +
              CASE
                WHEN COALESCE(s.metadata->>'renewal_interval', s.interval)='year'
                  THEN INTERVAL '1 year'
                ELSE INTERVAL '1 month'
              END,
            s.cost, 1, 'scheduled', s.current_period_end,
            s.current_period_end, 0, NOW(), NOW()
       FROM subscriptions s
     WHERE s.id=$1
        AND s.account_id=$2
        AND s.metadata->>'type'='membership'
        AND s.status='active'
     ON CONFLICT (subscription_id, period_end)
     DO UPDATE SET
       target_period_end=EXCLUDED.target_period_end,
       amount=EXCLUDED.amount,
       state='scheduled',
       not_before=EXCLUDED.not_before,
       next_attempt_at=EXCLUDED.next_attempt_at,
       lease_expires_at=NULL,
       last_attempt_at=NULL,
       attempt_count=0,
       balance_applied=NULL,
       funding_version=1,
       last_error=NULL,
       completed_at=NULL,
       updated_at=NOW()
     WHERE subscription_renewal_attempts.state='canceled'
       AND subscription_renewal_attempts.stripe_invoice_id IS NULL
       AND subscription_renewal_attempts.payment_intent_id IS NULL
     RETURNING id`,
    [subscription_id, account_id],
  );
  if (rows[0]?.id) {
    return rows[0].id;
  }
  await queryable(client).query(
    `UPDATE subscription_renewal_attempts a
        SET funding_version=1, updated_at=NOW()
       FROM subscriptions s
      WHERE a.subscription_id=$1
        AND a.account_id=$2
        AND s.id=a.subscription_id
        AND s.account_id=a.account_id
        AND a.period_end=s.current_period_end
        AND a.funding_version IS NULL
        AND a.attempt_count=0
        AND a.last_attempt_at IS NULL
        AND a.stripe_invoice_id IS NULL
        AND a.payment_intent_id IS NULL`,
    [subscription_id, account_id],
  );
  const existing = await queryable(client).query<{ id: string }>(
    `SELECT a.id
       FROM subscription_renewal_attempts a
       JOIN subscriptions s ON s.id=a.subscription_id
      WHERE a.subscription_id=$1
        AND a.account_id=$2
        AND a.period_end=s.current_period_end
        AND a.state IN ('scheduled','processing')
      LIMIT 1`,
    [subscription_id, account_id],
  );
  return existing.rows[0]?.id;
}

export async function scheduleMissingSubscriptionRenewalAttempts(): Promise<number> {
  await cancelStaleSubscriptionRenewalAttempts();
  await getPool().query(
    `UPDATE subscription_renewal_attempts
        SET funding_version=1, updated_at=NOW()
      WHERE funding_version IS NULL
        AND state IN ('scheduled','processing')
        AND attempt_count=0
        AND last_attempt_at IS NULL
        AND stripe_invoice_id IS NULL
        AND payment_intent_id IS NULL`,
  );
  const { rowCount } = await getPool().query(
    `INSERT INTO subscription_renewal_attempts
       (id, subscription_id, account_id, period_end, target_period_end,
        amount, funding_version, state, not_before, next_attempt_at, attempt_count,
        created_at, updated_at)
     SELECT gen_random_uuid(), s.id, s.account_id, s.current_period_end,
            s.current_period_end +
              CASE
                WHEN COALESCE(s.metadata->>'renewal_interval', s.interval)='year'
                  THEN INTERVAL '1 year'
                ELSE INTERVAL '1 month'
              END,
            s.cost, 1, 'scheduled', s.current_period_end,
            s.current_period_end, 0, NOW(), NOW()
       FROM subscriptions s
      WHERE s.metadata->>'type'='membership'
        AND s.status='active'
     ON CONFLICT DO NOTHING`,
  );
  return rowCount ?? 0;
}

export async function cancelStaleSubscriptionRenewalAttempts(): Promise<number> {
  const { rowCount } = await getPool().query(
    `UPDATE subscription_renewal_attempts a
        SET state='canceled',
            lease_expires_at=NULL,
            last_error='Subscription is no longer active for this period',
            completed_at=NOW(),
            updated_at=NOW()
      WHERE a.state IN ('scheduled','processing')
        AND NOT EXISTS (
          SELECT 1
            FROM subscriptions s
           WHERE s.id=a.subscription_id
             AND s.account_id=a.account_id
             AND s.metadata->>'type'='membership'
             AND s.status='active'
             AND s.current_period_end=a.period_end
        )`,
  );
  return rowCount ?? 0;
}

export async function cancelOpenSubscriptionRenewalAttempts({
  subscription_id,
  account_id,
  reason,
  client,
}: {
  subscription_id: number;
  account_id: string;
  reason: string;
  client?: Queryable;
}): Promise<number> {
  const { rowCount } = await queryable(client).query(
    `UPDATE subscription_renewal_attempts
        SET state='canceled',
            lease_expires_at=NULL,
            last_error=$3,
            completed_at=NOW(),
            updated_at=NOW()
      WHERE subscription_id=$1
        AND account_id=$2
        AND state IN ('scheduled','processing')`,
    [subscription_id, account_id, reason],
  );
  return rowCount ?? 0;
}

export async function claimDueSubscriptionRenewalAttempts({
  limit,
}: {
  limit: number;
}): Promise<SubscriptionRenewalAttempt[]> {
  const { rows } = await getPool().query<SubscriptionRenewalAttempt>(
    `WITH candidates AS (
       SELECT a.id
         FROM subscription_renewal_attempts a
         JOIN subscriptions s
           ON s.id=a.subscription_id
          AND s.account_id=a.account_id
          AND s.metadata->>'type'='membership'
          AND s.status='active'
          AND s.current_period_end=a.period_end
        WHERE a.state IN ('scheduled','processing')
          AND EXISTS (SELECT 1 FROM accounts owner WHERE owner.account_id=a.account_id
            AND COALESCE(NULLIF(BTRIM(owner.home_bay_id),''),$3)=$3)
          AND NOT EXISTS (SELECT 1 FROM account_funding_authorities f
            WHERE f.payer_account_id=a.account_id AND (f.state <> 'active' OR f.home_bay_id <> $3))
          AND a.not_before <= NOW()
          AND a.next_attempt_at <= NOW()
          AND (a.lease_expires_at IS NULL OR a.lease_expires_at <= NOW())
        ORDER BY a.not_before, a.subscription_id
        LIMIT $1
        FOR UPDATE OF a SKIP LOCKED
     )
     UPDATE subscription_renewal_attempts a
        SET state='processing',
            lease_expires_at=NOW() + ($2 * INTERVAL '1 millisecond'),
            last_attempt_at=NOW(),
            attempt_count=a.attempt_count + 1,
            updated_at=NOW()
       FROM candidates
      WHERE a.id=candidates.id
      RETURNING a.*`,
    [limit, RENEWAL_ATTEMPT_LEASE_MS, getConfiguredBayId()],
  );
  return rows;
}

export async function claimSubscriptionRenewalAttempt({
  attempt_id,
  account_id,
  subscription_id,
  client,
}: {
  attempt_id: string;
  account_id: string;
  subscription_id: number;
  client?: Queryable;
}): Promise<SubscriptionRenewalAttempt> {
  const { rows } = await queryable(client).query<SubscriptionRenewalAttempt>(
    `UPDATE subscription_renewal_attempts
        SET state='processing',
            lease_expires_at=NOW() + ($4 * INTERVAL '1 millisecond'),
            last_attempt_at=NOW(),
            attempt_count=attempt_count + 1,
            updated_at=NOW()
      WHERE id=$1
        AND account_id=$2
        AND subscription_id=$3
        AND state IN ('scheduled','processing')
        AND not_before <= NOW()
        AND next_attempt_at <= NOW()
        AND (lease_expires_at IS NULL OR lease_expires_at <= NOW())
      RETURNING *`,
    [attempt_id, account_id, subscription_id, RENEWAL_ATTEMPT_LEASE_MS],
  );
  if (!rows[0]) {
    throw Error(`renewal attempt ${attempt_id} is not available`);
  }
  return rows[0];
}

export async function bindSubscriptionRenewalPaymentIntent({
  attempt_id,
  account_id,
  subscription_id,
  payment_intent_id,
  stripe_invoice_id,
}: {
  attempt_id: string;
  account_id: string;
  subscription_id: number;
  payment_intent_id: string;
  stripe_invoice_id?: string;
}): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await lockAccountSpending(client, account_id);
    const { rows } = await client.query<SubscriptionRenewalAttempt>(
      `UPDATE subscription_renewal_attempts
          SET payment_intent_id=$4,
              stripe_invoice_id=COALESCE($5, stripe_invoice_id),
              updated_at=NOW()
        WHERE id=$1
          AND account_id=$2
          AND subscription_id=$3
          AND state IN ('scheduled','processing')
          AND (payment_intent_id IS NULL OR payment_intent_id=$4)
        RETURNING *`,
      [
        attempt_id,
        account_id,
        subscription_id,
        payment_intent_id,
        stripe_invoice_id ?? null,
      ],
    );
    const attempt = rows[0];
    if (!attempt) {
      throw Error(`renewal attempt ${attempt_id} is no longer active`);
    }
    await setSubscriptionPaymentFromAttempt({
      attempt,
      payment_intent_id,
      client,
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function setSubscriptionPaymentFromAttempt({
  attempt,
  payment_intent_id,
  client,
}: {
  attempt: SubscriptionRenewalAttempt;
  payment_intent_id?: string;
  client?: Queryable;
}): Promise<void> {
  const payment = {
    renewal_attempt_id: attempt.id,
    payment_intent_id: payment_intent_id ?? attempt.payment_intent_id,
    subscription_id: attempt.subscription_id,
    amount: toDecimal(attempt.amount).toNumber(),
    balance_applied: toDecimal(attempt.balance_applied ?? 0).toNumber(),
    created: new Date(attempt.created_at).valueOf(),
    status: "active",
    new_expires_ms: new Date(attempt.target_period_end).valueOf(),
  };
  const result = await queryable(client).query(
    `UPDATE subscriptions
        SET payment=$3
      WHERE id=$1
        AND account_id=$2
        AND status='active'`,
    [attempt.subscription_id, attempt.account_id, payment],
  );
  if (result.rowCount !== 1) {
    throw Error(
      `subscription ${attempt.subscription_id} is no longer renewable`,
    );
  }
}

export async function releaseSubscriptionRenewalAttempt({
  attempt_id,
  error,
}: {
  attempt_id: string;
  error: unknown;
}): Promise<void> {
  await getPool().query(
    `UPDATE subscription_renewal_attempts
        SET lease_expires_at=NULL,
            next_attempt_at=NOW() + ($2 * INTERVAL '1 millisecond'),
            last_error=$3,
            updated_at=NOW()
      WHERE id=$1
        AND state='processing'`,
    [attempt_id, RENEWAL_ATTEMPT_RETRY_MS, `${error}`],
  );
}

export async function completeSubscriptionRenewalAttempt({
  attempt_id,
  state,
  error,
  client,
}: {
  attempt_id: string;
  state: Extract<SubscriptionRenewalAttemptState, "succeeded" | "failed">;
  error?: unknown;
  client?: Queryable;
}): Promise<void> {
  await queryable(client).query(
    `UPDATE subscription_renewal_attempts
        SET state=$2,
            lease_expires_at=NULL,
            last_error=$3,
            completed_at=NOW(),
            updated_at=NOW()
      WHERE id=$1
        AND state IN ('scheduled','processing')`,
    [attempt_id, state, error == null ? null : `${error}`],
  );
}

export async function getSubscriptionRenewalAttempt({
  attempt_id,
  client,
  forUpdate = false,
}: {
  attempt_id: string;
  client?: Queryable;
  forUpdate?: boolean;
}): Promise<SubscriptionRenewalAttempt | undefined> {
  const { rows } = await queryable(client).query<SubscriptionRenewalAttempt>(
    `SELECT *
       FROM subscription_renewal_attempts
      WHERE id=$1
      ${forUpdate ? "FOR UPDATE" : ""}`,
    [attempt_id],
  );
  return rows[0];
}
