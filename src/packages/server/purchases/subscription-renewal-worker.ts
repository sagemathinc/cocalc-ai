/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import getConn from "@cocalc/server/stripe/connection";
import send, { support, url } from "@cocalc/server/messages/send";
import { registerBillingAuthorityAccount } from "@cocalc/server/purchases/billing-authority/context";
import type { SubscriptionRenewalAttempt } from "@cocalc/util/db-schema/subscription-renewal-attempts";
import createSubscriptionPayment, {
  processSubscriptionRenewalFailure,
} from "./stripe/create-subscription-payment";
import { cancelPaymentIntent } from "./stripe/create-payment-intent";
import { isBusinessTaxIdRequiredError } from "./stripe/business-tax-id-gate";
import processPaymentIntents from "./stripe/process-payment-intents";
import {
  claimDueSubscriptionRenewalAttempts,
  deferSubscriptionRenewalAttemptForBusinessTaxId,
  deferSubscriptionRenewalAttemptForCustomer,
  getSubscriptionRenewalAttempt,
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

// What to do with a renewal that the EU/UK business tax ID check refuses once
// its grace period has ended. "hold" keeps it waiting (rechecked every
// RENEWAL_CUSTOMER_ACTION_RECHECK_MS, and reported by the renewal health
// alert) until a decision is made for these customers. Pending William's
// decision (10-26) between canceling at the end of the grace period and
// exempting subscriptions that started before the check existed.
const BUSINESS_TAX_ID_REFUSAL_PAST_GRACE: "hold" = "hold";

// A refusal that cannot succeed until the customer acts: the customer is in
// the EU or the UK without a valid VAT ID. Retrying it soon cannot help, so it
// waits for the customer (rechecked every few hours) instead of being retried
// (and recorded) every few minutes. The check itself notifies the customer, at
// most weekly; the renewal health alert counts the renewal as waiting for the
// customer only if that notice was recorded.
async function deferRenewalRefusedForCustomer({
  attempt,
  err,
}: {
  attempt: SubscriptionRenewalAttempt;
  err: unknown;
}): Promise<void> {
  const deferred = await deferSubscriptionRenewalAttemptForBusinessTaxId({
    attempt_id: attempt.id,
    error: err,
  });
  if (
    deferred &&
    Date.now() >= renewalGraceEndsAt(attempt.period_end).valueOf()
  ) {
    logger.warn(
      "renewal refused by the business tax ID check past its grace period",
      {
        attempt_id: attempt.id,
        subscription_id: attempt.subscription_id,
        policy: BUSINESS_TAX_ID_REFUSAL_PAST_GRACE,
      },
    );
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
      await deferRenewalRefusedForCustomer({ attempt, err });
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
