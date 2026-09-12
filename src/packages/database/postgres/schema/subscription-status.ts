/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { Client } from "@cocalc/database/pool";

type DatabaseClient = Pick<Client, "query">;

export const SUBSCRIPTION_STATUS_CONSTRAINT =
  "subscriptions_status_active_or_canceled_check";
export const SUBSCRIPTION_STATUS_SCHEMA_LOCK =
  "subscriptions_status_active_or_canceled_schema";

// Deployment and recovery details live in
// server/legacy-migration/personal-subscription-status-migration.md. Keep this
// migration transactional: schema sync may run on several bays, and a failed
// lock acquisition or validation must not leave normalized rows without the
// constraint (or the constraint without normalized rows).

async function constraintState(
  db: DatabaseClient,
): Promise<{ exists: boolean; validated: boolean }> {
  const { rows } = await db.query<{
    exists: boolean;
    validated: boolean;
  }>(
    `SELECT EXISTS (
       SELECT 1
         FROM pg_constraint
        WHERE conname=$1
          AND contype='c'
          AND conrelid=to_regclass('subscriptions')
     ) AS exists,
     COALESCE((
       SELECT convalidated
         FROM pg_constraint
        WHERE conname=$1
          AND contype='c'
          AND conrelid=to_regclass('subscriptions')
     ), false) AS validated`,
    [SUBSCRIPTION_STATUS_CONSTRAINT],
  );
  return rows[0] ?? { exists: false, validated: false };
}

// Personal memberships are prepaid. Historical NULL, unpaid, and past-due
// rows do not grant an entitlement or enter the active renewal worker, so
// preserve them only as canceled audit records. An active embedded payment is
// a local pending-renewal marker, not a Stripe object; cancel it as well so the
// terminal subscription cannot continue to look as if fulfillment is pending.
async function normalizeLegacySubscriptionStatuses(
  db: DatabaseClient,
): Promise<void> {
  await db.query(
    `UPDATE subscriptions
        SET status='canceled',
            canceled_at=COALESCE(canceled_at, NOW()),
            canceled_reason=COALESCE(
              NULLIF(BTRIM(canceled_reason), ''),
              CASE status
                WHEN 'unpaid' THEN 'Legacy unpaid subscription state retired'
                WHEN 'past_due' THEN 'Legacy past-due subscription state retired'
                ELSE 'Legacy subscription without status retired'
              END
            ),
            payment=CASE
              WHEN payment->>'status'='active'
                THEN jsonb_set(payment, '{status}', '"canceled"'::jsonb)
              ELSE payment
            END
      WHERE status IS NULL OR status IN ('unpaid','past_due')`,
  );
}

export async function ensureSubscriptionStatusSchema(
  db: DatabaseClient,
): Promise<void> {
  let state = await constraintState(db);
  if (state.exists && state.validated) return;

  await db.query("BEGIN");
  try {
    await db.query("SET LOCAL lock_timeout='5s'");
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      SUBSCRIPTION_STATUS_SCHEMA_LOCK,
    ]);
    state = await constraintState(db);
    if (state.exists && state.validated) {
      await db.query("COMMIT");
      return;
    }
    await normalizeLegacySubscriptionStatuses(db);
    state = await constraintState(db);
    if (!state.exists) {
      await db.query(
        `ALTER TABLE subscriptions
           ADD CONSTRAINT ${SUBSCRIPTION_STATUS_CONSTRAINT}
           CHECK (status IS NOT NULL AND status IN ('active','canceled'))
           NOT VALID`,
      );
    }
    await db.query(
      `ALTER TABLE subscriptions
         VALIDATE CONSTRAINT ${SUBSCRIPTION_STATUS_CONSTRAINT}`,
    );
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
}

export async function subscriptionStatusSchemaNeedsSync(
  db: DatabaseClient,
): Promise<boolean> {
  const state = await constraintState(db);
  return !state.exists || !state.validated;
}
