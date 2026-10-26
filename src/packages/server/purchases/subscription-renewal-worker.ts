/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import getPool, { getTransactionClient } from "@cocalc/database/pool";
import getConn from "@cocalc/server/stripe/connection";
import send, { support, url } from "@cocalc/server/messages/send";
import { registerBillingAuthorityAccount } from "@cocalc/server/purchases/billing-authority/context";
import type { SubscriptionRenewalAttempt } from "@cocalc/util/db-schema/subscription-renewal-attempts";
import createSubscriptionPayment, {
  processSubscriptionRenewalFailure,
} from "./stripe/create-subscription-payment";
import { sendCancelNotification } from "./cancel-subscription";
import { lockMembershipSubscriptionAccount } from "./membership-subscription-guard";
import { cancelPaymentIntent } from "./stripe/create-payment-intent";
import { isBusinessTaxIdRequiredError } from "./stripe/business-tax-id-gate";
import processPaymentIntents from "./stripe/process-payment-intents";
import {
  BUSINESS_TAX_ID_REFUSAL_PREFIX,
  claimDueSubscriptionRenewalAttempts,
  completeSubscriptionRenewalAttempt,
  deferSubscriptionRenewalAttemptForBusinessTaxId,
  deferSubscriptionRenewalAttemptForCustomer,
  getSubscriptionRenewalAttempt,
  markSubscriptionRenewalBusinessTaxIdNotified,
  markSubscriptionRenewalCustomerNotified,
  releaseSubscriptionRenewalAttempt,
  RENEWAL_PAYMENT_GRACE_MS,
  renewalGraceEndsAt,
  scheduleMissingSubscriptionRenewalAttempts,
} from "./subscription-renewal-attempts";
import { formatRenewalDate } from "./subscription-renewal-notice";

const RENEWAL_NOTICE_DEDUP_MINUTES =
  Math.ceil(RENEWAL_PAYMENT_GRACE_MS / 60_000) + 24 * 60;

const logger = getLogger("purchases:subscription-renewal-worker");
const DEFAULT_CONCURRENCY = 1;
const MAX_CONCURRENCY = 20;
const MAX_ATTEMPTS_PER_RUN = 1000;

export type SubscriptionRenewalMode = "disabled" | "schedule-only" | "active";

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return;
  }
  return parsed;
}

function parseRenewalMode(value: unknown): SubscriptionRenewalMode {
  if (value === "schedule-only" || value === "active") {
    return value;
  }
  return "disabled";
}

async function renewalConfiguration(): Promise<{
  mode: SubscriptionRenewalMode;
  concurrency: number;
}> {
  const { subscription_maintenance: maintenance } = await getServerSettings();
  return {
    mode: parseRenewalMode(maintenance?.renewal_mode),
    concurrency: Math.min(
      MAX_CONCURRENCY,
      positiveInteger(maintenance?.renewal_concurrency) ?? DEFAULT_CONCURRENCY,
    ),
  };
}

// Statuses where the customer can still complete the open payment (enter a
// new card or authenticate with their bank) from the hosted invoice.
function needsCustomerAction(status: string): boolean {
  return status === "requires_action" || status === "requires_payment_method";
}

function isTerminalAutomaticFailure(status: string): boolean {
  return (
    status === "canceled" ||
    status === "requires_action" ||
    status === "requires_payment_method" ||
    status === "requires_capture"
  );
}

async function finishFromStripe({
  attempt,
  payment_intent_id,
}: {
  attempt: SubscriptionRenewalAttempt;
  payment_intent_id: string;
}): Promise<void> {
  const stripe = await getConn();
  let paymentIntent = await stripe.paymentIntents.retrieve(payment_intent_id);
  if (paymentIntent.status === "succeeded") {
    await processPaymentIntents({
      account_id: attempt.account_id,
      payment_intent_id,
      strict: true,
    });
    return;
  }
  if (!isTerminalAutomaticFailure(paymentIntent.status)) {
    throw Error(
      `Stripe payment ${payment_intent_id} is ${paymentIntent.status}`,
    );
  }
  if (
    needsCustomerAction(paymentIntent.status) &&
    Date.now() < renewalGraceEndsAt(attempt.period_end).valueOf()
  ) {
    // A declined card or a bank asking the customer to authenticate is not a
    // reason to end the membership immediately: leave the payment open (the
    // customer can complete it from the invoice), keep benefits during the
    // grace period, and make sure the customer is told.
    const { deferred, needsNotice } =
      await deferSubscriptionRenewalAttemptForCustomer({
        attempt_id: attempt.id,
        error: `Stripe payment ${payment_intent_id} is ${paymentIntent.status}`,
      });
    if (deferred && needsNotice) {
      // Retried on every recheck until delivery is recorded.
      try {
        await sendRenewalPaymentActionNotice({ attempt_id: attempt.id });
        await markSubscriptionRenewalCustomerNotified({
          attempt_id: attempt.id,
        });
      } catch (err) {
        logger.warn("unable to send renewal payment action notice", {
          attempt_id: attempt.id,
          err: `${err}`,
        });
      }
    }
    return;
  }
  if (paymentIntent.status !== "canceled") {
    await cancelPaymentIntent({ id: payment_intent_id, reason: "abandoned" });
    paymentIntent = {
      ...paymentIntent,
      status: "canceled",
    } as typeof paymentIntent;
  }
  await processSubscriptionRenewalFailure({
    account_id: attempt.account_id,
    paymentIntent,
  });
}

async function hostedInvoiceUrl(
  stripe_invoice_id?: string,
): Promise<string | undefined> {
  if (!stripe_invoice_id) return;
  // Errors propagate so the notice is retried with its payment link.
  const stripe = await getConn();
  const invoice = await stripe.invoices.retrieve(stripe_invoice_id);
  return invoice.hosted_invoice_url ?? undefined;
}

async function sendRenewalPaymentActionNotice({
  attempt_id,
}: {
  attempt_id: string;
}): Promise<void> {
  // Reload: on a first attempt the payment and invoice were created and bound
  // after this attempt was claimed.
  const attempt = await getSubscriptionRenewalAttempt({ attempt_id });
  if (attempt == null || attempt.state !== "scheduled") {
    return;
  }
  const { site_name } = await getServerSettings();
  const graceEnd = formatRenewalDate(renewalGraceEndsAt(attempt.period_end));
  const invoiceUrl = await hostedInvoiceUrl(attempt.stripe_invoice_id);
  const payLine = invoiceUrl ? `- [Complete the payment](${invoiceUrl})` : "";
  await send({
    to_ids: [attempt.account_id],
    // The notice is retried until delivery is recorded; if a previous try
    // stored the message but crashed before recording it, this suppresses the
    // duplicate. The subject names the subscription and is stable.
    dedupMinutes: RENEWAL_NOTICE_DEDUP_MINUTES,
    dedupBySubject: true,
    subject: `Action needed: ${site_name} subscription renewal payment (Id ${attempt.subscription_id})`,
    body: `
We couldn't automatically collect the renewal payment for your ${site_name} subscription (id=${attempt.subscription_id}). Your bank may have declined the card or asked you to confirm the payment.

**Your membership stays active until ${graceEnd}.** To keep it, complete the payment before then${invoiceUrl ? " using the link below, where you can also confirm the charge with your bank or pay with a different card" : ""}. If the payment isn't completed by ${graceEnd}, the subscription will be canceled.

${payLine}

- [Manage Membership](${await url(`/settings/membership`)})

${await support()}`,
  });
}

// A renewal the EU/UK business tax ID check refuses cannot succeed until the
// customer adds their organization's VAT number. Like a declined card
// (William, 10-26): during the grace period the membership stays active, the
// customer is told, and the renewal is rechecked every few hours, so it simply
// succeeds once a VAT number is on file. If it is still refused when the grace
// period has ended, the subscription is canceled.
async function handleRenewalRefusedForBusinessTaxId({
  attempt,
  err,
}: {
  attempt: SubscriptionRenewalAttempt;
  err: unknown;
}): Promise<void> {
  if (Date.now() >= renewalGraceEndsAt(attempt.period_end).valueOf()) {
    await cancelRenewalRefusedForBusinessTaxId({ attempt, err });
    return;
  }
  const { deferred, needsNotice } =
    await deferSubscriptionRenewalAttemptForBusinessTaxId({
      attempt_id: attempt.id,
      error: err,
    });
  if (!deferred || !needsNotice) return;
  // Retried on every recheck until delivery is recorded.
  try {
    if (await sendRenewalBusinessTaxIdNotice(attempt)) {
      await markSubscriptionRenewalBusinessTaxIdNotified({
        attempt_id: attempt.id,
      });
    }
  } catch (err) {
    logger.warn("unable to send renewal business tax ID notice", {
      attempt_id: attempt.id,
      err: `${err}`,
    });
  }
}

// Tells the customer which subscription was not renewed, what to do and when it
// will be canceled; returns whether it was sent. The check's generic weekly
// notice is not sent for renewals (it has neither the subscription nor the
// date). This one takes the same claim in business_tax_id_notices, so a
// customer gets at most one VAT notice a day: if one went out in the last day,
// this one waits for a later recheck. The claim is a single statement (no
// connection is held while sending) and is given back if sending fails. The
// subject names the subscription, so a retry after a crash is not sent twice.
async function sendRenewalBusinessTaxIdNotice(
  attempt: SubscriptionRenewalAttempt,
): Promise<boolean> {
  const pool = getPool();
  const { rows } = await pool.query<{
    claimed: string;
    previous: string | null;
  }>(
    `WITH previous AS (
       SELECT notified_at FROM business_tax_id_notices WHERE account_id=$1
     )
     INSERT INTO business_tax_id_notices (account_id, notified_at)
     VALUES ($1, NOW())
     ON CONFLICT (account_id) DO UPDATE SET notified_at = NOW()
      WHERE business_tax_id_notices.notified_at < NOW() - INTERVAL '1 day'
     RETURNING notified_at::text AS claimed,
               (SELECT notified_at::text FROM previous) AS previous`,
    [attempt.account_id],
  );
  if (rows.length === 0) {
    return false;
  }
  const { claimed, previous } = rows[0];
  try {
    const { site_name } = await getServerSettings();
    const graceEnd = formatRenewalDate(renewalGraceEndsAt(attempt.period_end));
    await send({
      to_ids: [attempt.account_id],
      dedupMinutes: RENEWAL_NOTICE_DEDUP_MINUTES,
      dedupBySubject: true,
      // Delivered to the account's home bay before the notice is recorded,
      // so a failed delivery is retried on the next recheck.
      requireAccountNoticeDelivery: true,
      subject: `Action needed: add a VAT number to renew your ${site_name} subscription (Id ${attempt.subscription_id})`,
      body: `
We couldn't renew your ${site_name} subscription (id=${attempt.subscription_id}). ${site_name} sells to customers in the EU and the UK only with the VAT number of their organization, and there is none on file.

**Your membership stays active until ${graceEnd}.** To keep it, please add your organization's VAT number under [Payment Methods](${await url(`/settings/payment-methods`)}), then Name and Address, before then. We retry the renewal automatically every few hours. If no VAT number is on file by ${graceEnd}, the subscription will be canceled.

- [Manage Membership](${await url(`/settings/membership`)})

${await support()}`,
    });
  } catch (err) {
    await pool.query(
      previous == null
        ? `DELETE FROM business_tax_id_notices
            WHERE account_id=$1 AND notified_at=$2::timestamptz`
        : `UPDATE business_tax_id_notices SET notified_at=$3::timestamptz
            WHERE account_id=$1 AND notified_at=$2::timestamptz`,
      previous == null
        ? [attempt.account_id, claimed]
        : [attempt.account_id, claimed, previous],
    );
    throw err;
  }
  return true;
}

async function cancelRenewalRefusedForBusinessTaxId({
  attempt,
  err,
}: {
  attempt: SubscriptionRenewalAttempt;
  err: unknown;
}): Promise<void> {
  const client = await getTransactionClient();
  let canceled = false;
  try {
    await lockMembershipSubscriptionAccount({
      account_id: attempt.account_id,
      client,
    });
    const current = await getSubscriptionRenewalAttempt({
      attempt_id: attempt.id,
      client,
      forUpdate: true,
    });
    if (current?.state !== "processing") {
      await client.query("COMMIT");
      return;
    }
    const { rowCount } = await client.query(
      `UPDATE subscriptions
          SET status='canceled',
              canceled_at=NOW(),
              canceled_reason='The renewal was not paid: there is no VAT number on file.'
        WHERE id=$1 AND account_id=$2 AND status<>'canceled'`,
      [attempt.subscription_id, attempt.account_id],
    );
    canceled = (rowCount ?? 0) > 0;
    await completeSubscriptionRenewalAttempt({
      attempt_id: attempt.id,
      state: "failed",
      error: `${BUSINESS_TAX_ID_REFUSAL_PREFIX}${err}`,
      client,
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  if (canceled) {
    await sendCancelNotification({
      subscription_id: attempt.subscription_id,
      alertAdmin: false,
    });
  }
}

async function processClaimedRenewalAttempt(
  attempt: SubscriptionRenewalAttempt,
): Promise<void> {
  try {
    await registerBillingAuthorityAccount(attempt.account_id);
    let paymentIntentId = attempt.payment_intent_id;
    if (!paymentIntentId) {
      const result = await createSubscriptionPayment({
        account_id: attempt.account_id,
        subscription_id: attempt.subscription_id,
        renewal_attempt_id: attempt.id,
      });
      paymentIntentId = result.payment_intent_id;
    }
    if (!paymentIntentId) {
      // A balance-funded renewal is completed synchronously.
      return;
    }
    await finishFromStripe({
      attempt,
      payment_intent_id: paymentIntentId,
    });
  } catch (err) {
    const current = await getSubscriptionRenewalAttempt({
      attempt_id: attempt.id,
    });
    if (current?.state === "processing" && isBusinessTaxIdRequiredError(err)) {
      await handleRenewalRefusedForBusinessTaxId({ attempt, err });
      return;
    }
    if (current?.state === "scheduled" || current?.state === "processing") {
      await releaseSubscriptionRenewalAttempt({
        attempt_id: attempt.id,
        error: err,
      });
    }
    logger.warn("subscription renewal attempt remains pending", {
      attempt_id: attempt.id,
      subscription_id: attempt.subscription_id,
      account_id: attempt.account_id,
      err: `${err}`,
    });
  }
}

export default async function maintainSubscriptionRenewals({
  max_attempts = MAX_ATTEMPTS_PER_RUN,
}: { max_attempts?: number } = {}): Promise<void> {
  const { mode, concurrency } = await renewalConfiguration();
  const maxAttempts = Math.max(
    0,
    Math.min(
      MAX_ATTEMPTS_PER_RUN,
      Number.isFinite(max_attempts)
        ? Math.floor(max_attempts)
        : MAX_ATTEMPTS_PER_RUN,
    ),
  );
  if (mode === "disabled") {
    logger.debug("subscription renewal maintenance is disabled");
    return;
  }
  const scheduled = await scheduleMissingSubscriptionRenewalAttempts();
  if (mode === "schedule-only") {
    logger.debug("subscription renewal maintenance scheduled attempts", {
      mode,
      scheduled,
    });
    return;
  }
  let processed = 0;
  while (processed < maxAttempts) {
    const attempts = await claimDueSubscriptionRenewalAttempts({
      limit: Math.min(concurrency, maxAttempts - processed),
    });
    if (attempts.length === 0) {
      break;
    }
    await Promise.all(attempts.map(processClaimedRenewalAttempt));
    processed += attempts.length;
  }
  logger.debug("subscription renewal maintenance finished", {
    scheduled,
    processed,
    concurrency,
    capped: processed >= maxAttempts,
  });
}

export const __test__ = {
  parseRenewalMode,
};
