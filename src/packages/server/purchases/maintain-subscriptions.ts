/*
UPCOMING NOTIFICATIONS:
  For each subscription that has status not 'canceled' and current_period_end
  is within the next 7 days, send a message that the subscription will renew on
  its current period end date. Include a link to cancel or edit the subscription.

CREATE PAYMENTS:
  For each subscription that has status not 'canceled', current_period_end is
  due, and there isn't already a renewal process happening for that
  subscription, we do the following:

  - Create a payment intent for the amount to renew the subscription for the next
    period. The metadata says what this payment is for and what should happen
    when payment is processed.  If user has selected to pay from credit on file
    and they have enough to covert the entire renewal, subscription is immediately
    renewed using available credit.

  - Send message about subscription renewal payment.  Including invoice
    payment link from stripe in that message.


PROCESS PAYMENT:
  - When processed, add a 'subscription-credit' line item saying
    "this is for renewal of this subscription". Then create a
    "subscription-payment" service line item taking that money back.
  - Extend the subscription period and save the payment intent id with the subscription.
  - The frontend UI clearly surfaces this payment state and blocks membership
    changes until it reaches a terminal outcome.
  - Users have an account setting to apply any balance on their account
    first toward subscriptions.


PAYMENT FOLLOW-UP:

  - While CoCalc has not reached a terminal payment outcome, the subscription
    stays active and membership benefits continue. A delayed attempt is an
    operational failure, not customer nonpayment, and is surfaced to admins by
    the aggregate renewal health alert.

  - A terminal automatic payment failure cancels the subscription and stops
    membership benefits. The user can resume it later with a new renewal period.

  - In particular, if a user doesn't pay their monthly subscription for 90 days (say),
    then their membership benefits would have not worked during the last 90 days and we didn't
    try to charge them during the second two periods, and moreover their payment
    got canceled/expired.  They can start their canceled subscription, paying for a
    full subscription period at this point, and the billing day for this subscription
    changes to the day when they resume the subscription.

MANUAL PAYMENTS:

- The legacy manual payment route uses the same durable attempt and cannot
  collect payment before the exact paid-through boundary.

*/

import maintainSubscriptionRenewals from "./subscription-renewal-worker";
import send, { url } from "@cocalc/server/messages/send";
import adminAlert from "@cocalc/server/messages/admin-alert";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import getPool from "@cocalc/database/pool";
import getLogger from "@cocalc/backend/logger";
import { getUser } from "@cocalc/server/purchases/statements/email-statement";
import { moneyToCurrency } from "@cocalc/util/money";
import {
  formatRenewalDate,
  getRenewalPaymentNotice,
} from "./subscription-renewal-notice";
import { alertDelayedSubscriptionRenewals } from "./subscription-renewal-health";

const logger = getLogger("purchases:maintain-subscriptions");

export default async function maintainSubscriptions() {
  logger.debug("maintaining subscriptions");
  try {
    await sendUpcomingRenewalNotifications();
  } catch (err) {
    logger.debug("nonfatal ERROR in sendUpcomingRenewalNotifications- ", err);
    adminAlert({
      subject: `ERROR in sendUpcomingRenewalNotifications`,
      body: err,
    });
  }
  try {
    await createPayments();
  } catch (err) {
    logger.debug("nonfatal ERROR in createPayments - ", err);
    adminAlert({
      subject: `nonfatal ERROR in createPayments`,
      body: err,
    });
  }
  try {
    await alertDelayedSubscriptionRenewals();
  } catch (err) {
    logger.debug("nonfatal ERROR in renewal health check - ", err);
    adminAlert({
      subject: "ERROR checking personal membership renewal health",
      body: err,
      dedupBySubject: true,
      dedupMinutes: 24 * 60,
    });
  }
}

// UPCOMING NOTIFICATIONS (see above)

export async function sendUpcomingRenewalNotifications() {
  logger.debug("sendUpcomingRenewalNotifications");
  const { support_account_id: from_id, site_name } = await getServerSettings();
  if (from_id == null) {
    throw Error("configure the support account_id in admin settings.");
  }

  // Find each subscription that has status not 'canceled' and current_period_end
  // is within the next 7 days.

  const pool = getPool();
  const cutoff = "1 week";
  const query = `
    SELECT id, cost, interval, metadata, account_id, current_period_end
    FROM subscriptions
    WHERE
      status='active' AND
      current_period_end > NOW() AND
      current_period_end <= NOW() + INTERVAL '${cutoff}' AND
      (renewal_email IS NULL OR renewal_email < NOW() - INTERVAL '${cutoff}')
  `;
  const { rows } = await pool.query(query);
  logger.debug(
    "sendUpcomingRenewalNotifications -- ",
    rows.length,
    "subscriptions",
  );

  for (const {
    id,
    cost,
    interval,
    metadata,
    account_id,
    current_period_end,
  } of rows) {
    const subject = `Upcoming ${site_name} Subscription Renewal - Id ${id}`;
    const { name } = await getUser(account_id);
    const renewalDate = formatRenewalDate(current_period_end);
    const paymentNotice = await getRenewalPaymentNotice({
      account_id,
      cost,
      current_period_end,
    });
    const body = `
Hello ${name},

Your ${interval}ly subscription will **automatically renew** on ${renewalDate}.

${paymentNotice}

You can also cancel or change your subscription:

[Manage Membership](${await url(`/settings/membership`)})

### Details

- ${interval == "month" ? "Monthly" : "Yearly"} Subscription (id=${
      id
    }) for ${moneyToCurrency(cost)}/${interval}
- ${await describeSubscription(metadata)}
`;

    logger.debug("sendUpcomingRenewalNotifications to ", name);
    //console.log(subject, "\n", body);
    await send({ to_ids: [account_id], from_id, subject, body });
    await pool.query(
      "UPDATE subscriptions SET renewal_email=NOW() WHERE id=$1",
      [id],
    );
  }
}

async function describeSubscription(metadata): Promise<string> {
  if (!metadata) {
    return "";
  }
  if (metadata.type == "membership") {
    return `Membership (${metadata.class ?? "unknown"})`;
  }
  return "";
}

// CREATE PAYMENTS (see above)

export async function createPayments() {
  await maintainSubscriptionRenewals();
}
