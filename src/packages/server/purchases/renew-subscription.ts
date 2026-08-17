/*
Renewing a membership subscription creates a new purchase for the next period
and updates current_period dates and status.
*/

import getPool, {
  getTransactionClient,
  type PoolClient,
} from "@cocalc/database/pool";
import getLogger from "@cocalc/backend/logger";
import dayjs from "dayjs";
import type { Status } from "@cocalc/util/db-schema/subscriptions";
import { hoursInInterval } from "@cocalc/util/stripe/timecalcs";
import createPurchase from "./create-purchase";
import { toDecimal } from "@cocalc/util/money";
import { assertPurchaseAllowed } from "./is-purchase-allowed";
import {
  recordMembershipAnalyticsEvent,
  recordMembershipPurchaseCompleted,
} from "@cocalc/server/membership/analytics";
import {
  consumePendingMembershipPlanChange,
  recordPersonalMembershipPeriod,
} from "@cocalc/server/membership/personal-allocation-analytics";
import { refreshAccountBalanceAndPublishBestEffort } from "./refresh-balance";
import {
  assertNoCompetingMembershipSubscription,
  lockMembershipSubscriptionAccount,
} from "./membership-subscription-guard";
import { scheduleSubscriptionRenewalAttempt } from "./subscription-renewal-attempts";

const logger = getLogger("purchases:renew-subscription");

interface Options {
  account_id: string;
  subscription_id: number;
}

export default async function renewSubscription({
  account_id,
  subscription_id,
}: Options): Promise<number | null | undefined> {
  // might not be a purchase in case there's no fee
  logger.debug({ account_id, subscription_id });
  // Use a transaction so we either record the renewal and update subscription or do nothing.
  const client = await getTransactionClient();
  try {
    await lockMembershipSubscriptionAccount({ account_id, client });
    const subscription = await getSubscription(subscription_id, client, true);
    if (subscription.account_id != account_id) {
      throw Error("you must be signed in as the owner of the subscription");
    }
    const {
      metadata,
      interval,
      current_period_end,
      cost,
      status,
      latest_purchase_id,
    } = subscription;
    if (metadata?.type != "membership") {
      throw Error("subscription must be a membership");
    }
    if (status == "active") {
      throw Error("subscription is already active");
    }
    if (status == "canceled") {
      throw Error("use resume subscription for canceled subscriptions");
    }
    if (status != "unpaid" && status != "past_due") {
      throw Error(`subscription is not due for renewal; status is "${status}"`);
    }
    await assertNoCompetingMembershipSubscription({
      account_id,
      subscription_id,
      client,
    });

    const end = addInterval(current_period_end, interval);
    const periodStart = subtractInterval(end, interval);
    const consumedPlanChange = consumePendingMembershipPlanChange(metadata);
    if (toDecimal(cost).gt(0)) {
      await assertPurchaseAllowed({
        account_id,
        service: "membership",
        cost,
        client,
      });
    }

    const purchase_id = await createPurchase({
      account_id,
      service: "membership",
      description: {
        type: "membership",
        subscription_id,
        class: metadata.class,
        interval,
      },
      client,
      cost,
      period_start: periodStart,
      period_end: end,
    });

    const update = await client.query(
      "UPDATE subscriptions SET status='active',current_period_start=$1,current_period_end=$2,latest_purchase_id=$3,metadata=$6 WHERE id=$4 AND account_id=$5 AND status IN ('unpaid','past_due')",
      [
        periodStart,
        end,
        purchase_id,
        subscription_id,
        account_id,
        consumedPlanChange.metadata,
      ],
    );
    if (update.rowCount != 1) {
      throw Error("subscription is no longer due for renewal");
    }
    await scheduleSubscriptionRenewalAttempt({
      account_id,
      subscription_id,
      client,
    });
    const isTrialConversion =
      metadata.trial === true && latest_purchase_id == null;
    await recordPersonalMembershipPeriod({
      account_id,
      subscription_id,
      purchase_id,
      membership_class: metadata.class,
      billing_interval: interval,
      lifecycle: isTrialConversion
        ? "first_paid"
        : consumedPlanChange.pending
          ? "plan_change"
          : "renewal",
      allocation_start: periodStart,
      allocation_end: end,
      revenue: cost,
      previous_membership_class:
        consumedPlanChange.pending?.previous_class ?? null,
      previous_billing_interval:
        consumedPlanChange.pending?.previous_interval ?? null,
      tier_change: consumedPlanChange.pending ? "downgrade" : "none",
      client,
    });
    await recordMembershipAnalyticsEvent({
      event_key: `subscription:${subscription_id}:renewed:${purchase_id}`,
      event_type: "membership_renewed",
      account_id,
      membership_class: metadata.class,
      source: "subscription",
      interval,
      subscription_id,
      purchase_id,
      amount: cost,
      period_start: periodStart,
      period_end: end,
      trial_status: isTrialConversion ? "converted" : "none",
      client,
    });
    await recordMembershipPurchaseCompleted({
      account_id,
      subscription_id,
      purchase_id,
      membership_class: metadata.class,
      interval,
      amount: cost,
      period_start: periodStart,
      period_end: end,
      trial_status: isTrialConversion ? "converted" : "none",
      client,
    });
    if (isTrialConversion) {
      await recordMembershipAnalyticsEvent({
        event_key: `subscription:${subscription_id}:trial-converted:${purchase_id}`,
        event_type: "trial_converted",
        account_id,
        membership_class: metadata.class,
        source: "trial",
        interval,
        subscription_id,
        purchase_id,
        period_start: periodStart,
        period_end: end,
        trial_days: metadata.trial_days ?? null,
        trial_status: "converted",
        client,
      });
    }
    await client.query("COMMIT");
    await refreshAccountBalanceAndPublishBestEffort({ account_id });
    return purchase_id;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// add the interval to the date.  The day of the month (and time) should be unchanged
export function addInterval(expires: Date, interval: "month" | "year"): Date {
  if (interval != "month" && interval != "year") {
    throw Error(`interval must be 'month' or 'year' but it is "${interval}"`);
  }
  let newExpires = dayjs(expires);
  return newExpires.add(1, interval).toDate();
}

function subtractInterval(expires: Date, interval: "month" | "year"): Date {
  if (interval != "month" && interval != "year") {
    throw Error(`interval must be 'month' or 'year' but it is "${interval}"`);
  }
  let newExpires = dayjs(expires);
  return newExpires.subtract(1, interval).toDate();
}

export function intervalContainingNow(
  end: Date,
  interval: "month" | "year",
): { start: Date; end: Date } {
  const now = new Date();
  // not being clever, since usually the interval needed is just 1 or 2 steps away.
  for (let i = 0; i < 1000; i++) {
    let start = subtractInterval(end, interval);
    if (start <= now && now <= end) {
      // now  is in this interval
      return { start, end };
    }
    if (now < start) {
      end = subtractInterval(end, interval);
    } else if (now > end) {
      end = addInterval(end, interval);
    }
  }
  throw Error(`bug in intervalContainingNow ${end} ${interval}`);
}

export const test = {
  addInterval,
  subtractInterval,
};

export async function getSubscription(
  subscription_id: number,
  client?: PoolClient,
  forUpdate = false,
): Promise<{
  id: number;
  account_id: string;
  metadata: any;
  cost: number;
  cost_per_hour: number;
  interval: "month" | "year";
  current_period_end: Date;
  status: Status; // used externally (not in this file)
  latest_purchase_id?: number | null;
}> {
  const pool = client ?? getPool();
  const { rows } = await pool.query(
    `SELECT id, account_id, metadata, cost, interval, current_period_end, status, latest_purchase_id FROM subscriptions WHERE id=$1${forUpdate ? " FOR UPDATE" : ""}`,
    [subscription_id],
  );
  if (rows.length == 0) {
    throw Error(`no subscription with id=${subscription_id}`);
  }
  const costValue = toDecimal(rows[0]?.cost ?? 0);
  return {
    ...rows[0],
    cost: costValue.toNumber(),
    cost_per_hour: costValue.div(hoursInInterval(rows[0].interval)).toNumber(),
  };
}
