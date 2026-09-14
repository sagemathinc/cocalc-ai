import getPool, {
  getTransactionClient,
  type PoolClient,
} from "@cocalc/database/pool";
import send, { support, url, name } from "@cocalc/server/messages/send";
import adminAlert from "@cocalc/server/messages/admin-alert";
import { moneyToCurrency } from "@cocalc/util/money";
import { recordMembershipAnalyticsEvent } from "@cocalc/server/membership/analytics";
import { cancelOpenSubscriptionRenewalAttempts } from "./subscription-renewal-attempts";
import {
  assertNoDueMembershipRenewal,
  lockMembershipSubscriptionAccount,
} from "./membership-subscription-guard";

interface Options {
  account_id: string;
  subscription_id: number | string;
  reason?: string;
  client?: PoolClient;
  notify?: boolean;
}

export function parseSubscriptionId(value: unknown): number {
  const subscriptionId =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[1-9][0-9]*$/.test(value)
        ? Number(value)
        : NaN;
  if (!Number.isSafeInteger(subscriptionId) || subscriptionId <= 0) {
    throw Object.assign(new Error("invalid subscription id"), {
      code: 400,
      status: 400,
    });
  }
  return subscriptionId;
}

export default async function cancelSubscription({
  account_id, // only used for added security
  subscription_id,
  reason = "no reason specified",
  client,
  notify = true,
}: Options) {
  const subscriptionId = parseSubscriptionId(subscription_id);
  const pool = client ?? (await getTransactionClient());
  const useTransaction = client == null;
  const now = new Date();
  try {
    await lockMembershipSubscriptionAccount({ account_id, client: pool });
    await assertNoDueMembershipRenewal({ account_id, client: pool });
    const update = await pool.query(
      `UPDATE subscriptions
        SET status='canceled', canceled_at=$1, canceled_reason=$2
      WHERE id=$3 AND account_id=$4
      RETURNING metadata, interval, current_period_start, current_period_end`,
      [now, reason, subscriptionId, account_id],
    );
    if (update.rowCount != 1) {
      throw Error(`You do not have a subscription with id ${subscriptionId}.`);
    }
    const row = update.rows[0];
    if (row?.metadata?.type === "membership") {
      await cancelOpenSubscriptionRenewalAttempts({
        subscription_id: subscriptionId,
        account_id,
        reason,
        client: pool,
      });
      await recordMembershipAnalyticsEvent({
        event_key: `subscription:${subscriptionId}:canceled:${now.toISOString()}`,
        event_type: "membership_canceled",
        event_time: now,
        account_id,
        membership_class: row.metadata.class,
        source: "subscription",
        interval: row.interval,
        subscription_id: subscriptionId,
        period_start: row.current_period_start,
        period_end: row.current_period_end,
        trial_status: row.metadata.trial === true ? "canceled" : "none",
        client: pool,
      });
    }
    if (useTransaction) {
      await pool.query("COMMIT");
    }
  } catch (err) {
    if (useTransaction) {
      await pool.query("ROLLBACK");
    }
    throw err;
  } finally {
    if (useTransaction) {
      pool.release();
    }
  }
  if (notify) {
    await sendCancelNotification({ subscription_id: subscriptionId, client });
  }
}

export async function sendCancelNotification({
  subscription_id,
  client,
  alertAdmin = true,
}: {
  subscription_id: number;
  client?: PoolClient;
  alertAdmin?: boolean;
}) {
  const pool = client ?? getPool();
  const { rows } = await pool.query(
    "SELECT account_id, canceled_reason, cost, interval FROM subscriptions where id=$1",
    [subscription_id],
  );
  if (rows.length == 0) {
    return;
  }
  const { account_id, canceled_reason, cost, interval } = rows[0];

  const subject = `Subscription Id=${subscription_id} Canceled`;
  const body = `
This is a confirmation that your subscription (id=${subscription_id}) that
costs ${moneyToCurrency(cost)}/${interval} was canceled.

**REASON:** ${JSON.stringify(canceled_reason)}

You can easily [resume or edit this membership at any time](${await url(`/settings/membership`)}).

${await support()}
`;

  await send({
    to_ids: [account_id],
    subject,
    body,
  });

  if (alertAdmin) {
    adminAlert({
      subject: `Alert -- User Subscription for ${moneyToCurrency(cost)}/${interval} Id=${subscription_id} was Canceled`,
      body: `
- User: ${await name(account_id)}, account_id=${account_id}

- User provided reason: "${JSON.stringify(canceled_reason)}"

- Cost: ${moneyToCurrency(cost)}/${interval}

- subscription_id=${subscription_id}

`,
    });
  }
}
