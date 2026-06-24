/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Request, Response } from "express";

import getLogger from "@cocalc/backend/logger";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import isValidAccount from "@cocalc/server/accounts/is-valid-account";
import adminAlert from "@cocalc/server/messages/admin-alert";
import { createCreditFromPaidStripeInvoice } from "@cocalc/server/purchases/create-invoice";
import { setUsageSubscription } from "@cocalc/server/purchases/stripe-usage-based-subscription";
import getConn from "@cocalc/server/stripe/connection";

import {
  alertUncreditedSucceededPayment,
  belongsToCurrentStripeSite,
  isReadyToProcess,
  processPaymentIntent,
} from "./process-payment-intents";
import { getPaymentIntentIdFromInvoice } from "./create-payment-intent";
import { currentStripeSite } from "./util";

const logger = getLogger("purchases:stripe:webhook");
const alertedWebhookFailures = new Set<string>();

export default async function stripeWebhookHandler(
  req: Request,
  res: Response,
) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const { stripe_webhook_secret } = await getServerSettings();
  if (!stripe_webhook_secret) {
    logger.warn("Stripe webhook request received but webhook secret is unset");
    res.status(503).json({ error: "stripe_webhook_not_configured" });
    return;
  }

  const signature = stripeSignature(req);
  if (!signature) {
    res.status(400).json({ error: "missing_stripe_signature" });
    return;
  }

  let event;
  try {
    const stripe = await getConn();
    event = stripe.webhooks.constructEvent(
      req.body,
      signature,
      stripe_webhook_secret,
    );
  } catch (err) {
    logger.warn("Stripe webhook signature verification failed", { err });
    res.status(400).json({ error: "invalid_stripe_signature" });
    return;
  }

  try {
    const result = await processStripeWebhookEvent(event);
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    logger.warn("Stripe webhook processing failed", {
      event_id: event?.id,
      event_type: event?.type,
      err,
    });
    try {
      await alertStripeWebhookFailure({ event, err });
    } catch (alertErr) {
      logger.warn("Failed to send Stripe webhook failure admin alert", {
        event_id: event?.id,
        event_type: event?.type,
        alertErr,
      });
    }
    res.status(500).json({ error: "stripe_webhook_processing_failed" });
  }
}

function stripeSignature(req: Request): string | undefined {
  const value = req.headers["stripe-signature"];
  if (Array.isArray(value)) {
    return value.join(",");
  }
  return value;
}

export async function processStripeWebhookEvent(event): Promise<{
  processed: boolean;
  type: string;
  action: string;
}> {
  switch (event?.type) {
    case "payment_intent.succeeded":
    case "payment_intent.canceled":
      return await processStripeWebhookPaymentIntent({
        eventType: event.type,
        paymentIntent: event.data?.object,
      });

    case "checkout.session.completed":
      return await processStripeWebhookCheckoutSession(event.data?.object);

    case "invoice.paid":
    case "invoice.payment_succeeded":
      return await processStripeWebhookPaidInvoice({
        eventType: event.type,
        invoice: event.data?.object,
      });

    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return await processStripeWebhookSubscription({
        eventType: event.type,
        subscription: event.data?.object,
      });

    default:
      return { processed: false, type: event?.type, action: "ignored" };
  }
}

async function processStripeWebhookPaymentIntent({
  eventType,
  paymentIntent,
}: {
  eventType: string;
  paymentIntent;
}) {
  const id = `${paymentIntent?.id ?? ""}`.trim();
  if (!id) {
    return { processed: false, type: eventType, action: "missing-id" };
  }
  const stripe = await getConn();
  const latest = await stripe.paymentIntents.retrieve(id);
  const site = await currentStripeSite();
  if (!(await belongsToCurrentStripeSite({ paymentIntent: latest, site }))) {
    return { processed: false, type: eventType, action: "foreign-site" };
  }
  if (!isReadyToProcess(latest)) {
    return { processed: false, type: eventType, action: "not-ready" };
  }
  try {
    const purchase_id = await processPaymentIntent(latest);
    return {
      processed: purchase_id != null,
      type: eventType,
      action: "payment-intent",
    };
  } catch (err) {
    await alertUncreditedSucceededPayment({
      err,
      paymentIntent: latest,
      stage: "process",
    });
    throw err;
  }
}

async function processStripeWebhookCheckoutSession(session) {
  const paymentIntentId = stripeId(session?.payment_intent);
  if (!paymentIntentId) {
    return {
      processed: false,
      type: "checkout.session.completed",
      action: "no-payment-intent",
    };
  }
  return await processStripeWebhookPaymentIntent({
    eventType: "checkout.session.completed",
    paymentIntent: { id: paymentIntentId },
  });
}

async function processStripeWebhookPaidInvoice({
  eventType,
  invoice,
}: {
  eventType: string;
  invoice;
}) {
  const stripe = await getConn();
  const latest = invoice?.id
    ? await stripe.invoices.retrieve(invoice.id, {
        expand: ["payments.data.payment.payment_intent"],
      } as any)
    : invoice;
  if (!(await metadataBelongsToCurrentSite(invoiceMetadata(latest)))) {
    return { processed: false, type: eventType, action: "foreign-site" };
  }

  const paymentIntentId = getPaymentIntentIdFromInvoice(latest);
  if (paymentIntentId && latest?.metadata?.purpose) {
    return await processStripeWebhookPaymentIntent({
      eventType,
      paymentIntent: { id: paymentIntentId },
    });
  }

  const processed = await createCreditFromPaidStripeInvoice(latest);
  return { processed, type: eventType, action: "invoice-credit" };
}

async function processStripeWebhookSubscription({
  eventType,
  subscription,
}: {
  eventType: string;
  subscription;
}) {
  const metadata = subscription?.metadata ?? {};
  if (!(await metadataBelongsToCurrentSite(metadata))) {
    return { processed: false, type: eventType, action: "foreign-site" };
  }
  const account_id = `${metadata.account_id ?? ""}`.trim();
  if (!account_id || metadata.service !== "credit") {
    return { processed: false, type: eventType, action: "not-usage-credit" };
  }
  const active = ["active", "trialing"].includes(`${subscription.status}`);
  await setUsageSubscription({
    account_id,
    subscription_id: active ? subscription.id : "",
  });
  return {
    processed: true,
    type: eventType,
    action: active ? "set-usage-subscription" : "clear-usage-subscription",
  };
}

function stripeId(value): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  return value?.id;
}

function invoiceMetadata(invoice): Record<string, string> {
  const metadata = invoice?.metadata ?? {};
  if (metadata?.account_id || metadata?.cocalc_site) {
    return metadata;
  }
  return invoice?.lines?.data?.[0]?.metadata ?? {};
}

async function metadataBelongsToCurrentSite(
  metadata?: Record<string, string>,
): Promise<boolean> {
  const site = await currentStripeSite();
  const paymentSite = `${metadata?.cocalc_site ?? ""}`.trim();
  if (paymentSite) {
    return !site || paymentSite === site;
  }
  const account_id = `${metadata?.account_id ?? ""}`.trim();
  return !!account_id && (await isValidAccount(account_id));
}

async function alertStripeWebhookFailure({ event, err }: { event; err }) {
  const eventId = `${event?.id ?? ""}`.trim();
  if (eventId && alertedWebhookFailures.has(eventId)) {
    return;
  }
  if (eventId) {
    alertedWebhookFailures.add(eventId);
  }
  await adminAlert({
    subject: "Stripe webhook processing failed",
    body: `CoCalc failed to process a verified Stripe webhook event.\n\n- Event id: ${eventId || "unknown"}\n- Event type: ${event?.type ?? "unknown"}\n- ERROR: ${err}`,
  });
}
