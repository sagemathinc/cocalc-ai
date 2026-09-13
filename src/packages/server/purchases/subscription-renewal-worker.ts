/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import getConn from "@cocalc/server/stripe/connection";
import { registerBillingAuthorityAccount } from "@cocalc/server/purchases/billing-authority/context";
import type { SubscriptionRenewalAttempt } from "@cocalc/util/db-schema/subscription-renewal-attempts";
import createSubscriptionPayment, {
  processSubscriptionRenewalFailure,
} from "./stripe/create-subscription-payment";
import { cancelPaymentIntent } from "./stripe/create-payment-intent";
import processPaymentIntents from "./stripe/process-payment-intents";
import {
  claimDueSubscriptionRenewalAttempts,
  getSubscriptionRenewalAttempt,
  releaseSubscriptionRenewalAttempt,
  scheduleMissingSubscriptionRenewalAttempts,
} from "./subscription-renewal-attempts";

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
