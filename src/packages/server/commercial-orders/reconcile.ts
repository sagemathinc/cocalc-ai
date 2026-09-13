/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { getLogger } from "@cocalc/backend/logger";
import getPool, { type PoolClient } from "@cocalc/database/pool";
import centralLog from "@cocalc/database/postgres/central-log";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterSeedBayId } from "@cocalc/server/cluster-config";
import getConn from "@cocalc/server/stripe/connection";
import {
  getCommercialInvoice,
  getCommercialOrder,
  getStaleCommercialInvoiceIds,
  getStaleCommercialQuoteIds,
} from "./store";
import { reconcileStripeCommercialInvoice } from "./invoices/stripe";
import { reconcileStripeCommercialQuoteById } from "./quotes/stripe";
import {
  recordCommercialReconciliation,
  recordCommercialWebhookLatency,
} from "./observability";
import { registerCommercialOrderBillingAccount } from "./billing-authority";

const logger = getLogger("server:commercial-orders:reconcile");
const LEASE_MS = 5 * 60_000;
const MAX_EVENT_ATTEMPTS = 8;

export interface CommercialStripeEventEnvelope {
  event_id: string;
  event_type: string;
  livemode: boolean;
  commercial_order_id?: string;
  commercial_quote_id?: string;
  commercial_invoice_id?: string;
  provider_quote_id?: string;
  provider_invoice_id?: string;
  created?: number;
}

function assertSeed(): void {
  if (getConfiguredBayId() !== getConfiguredClusterSeedBayId()) {
    throw Error("commercial Stripe events are authoritative on the seed bay");
  }
}

function expectedLiveMode(
  stripe: Awaited<ReturnType<typeof getConn>>,
): boolean {
  return stripe.publishable_key.startsWith("pk_live_");
}

export async function enqueueCommercialStripeEvent(
  event: CommercialStripeEventEnvelope,
): Promise<void> {
  assertSeed();
  if (!/^evt_/.test(event.event_id)) throw Error("invalid Stripe event id");
  const stripe = await getConn();
  if (event.livemode !== expectedLiveMode(stripe)) {
    throw Error("Stripe webhook mode does not match configured Stripe keys");
  }
  await getPool().query(
    `INSERT INTO commercial_stripe_events
      (event_id,event_type,livemode,commercial_order_id,commercial_quote_id,
       commercial_invoice_id,provider_quote_id,provider_invoice_id,
       status,payload,attempt_count,next_attempt_at,
       created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,0,NOW(),NOW(),NOW())
     ON CONFLICT (event_id) DO NOTHING`,
    [
      event.event_id,
      event.event_type,
      event.livemode,
      event.commercial_order_id ?? null,
      event.commercial_quote_id ?? null,
      event.commercial_invoice_id ?? null,
      event.provider_quote_id ?? null,
      event.provider_invoice_id ?? null,
      { created: event.created },
    ],
  );
}

async function claimEvent(): Promise<any | undefined> {
  const client: PoolClient = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT * FROM commercial_stripe_events
        WHERE status IN ('pending','failed','processing')
          AND next_attempt_at <= NOW()
          AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
    );
    if (!rows[0]) {
      await client.query("COMMIT");
      return undefined;
    }
    const result = await client.query(
      `UPDATE commercial_stripe_events SET status='processing',
        attempt_count=attempt_count+1,lease_expires_at=$2,updated_at=NOW()
       WHERE event_id=$1 RETURNING *`,
      [rows[0].event_id, new Date(Date.now() + LEASE_MS)],
    );
    await client.query("COMMIT");
    return result.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function finishEvent(
  event: { event_id: string; attempt_count: number },
  status: "processed" | "failed" | "ignored",
  error?: unknown,
): Promise<void> {
  const message = error == null ? "" : `${error}`;
  const permanent =
    /metadata does not match|currency does not match|different commercial order|not found|invalid Stripe|cancelled commercial order/i.test(
      message,
    );
  const deadLetter =
    status === "failed" &&
    (permanent || event.attempt_count >= MAX_EVENT_ATTEMPTS);
  const persistedStatus = deadLetter ? "dead_letter" : status;
  const retrySeconds =
    status === "failed" && !deadLetter
      ? Math.min(30 * 2 ** Math.max(event.attempt_count - 1, 0), 21_600)
      : 0;
  const terminal = ["processed", "dead_letter", "ignored"].includes(
    persistedStatus,
  );
  await getPool().query(
    `UPDATE commercial_stripe_events SET status=$2::varchar,last_error=$3,
      processed_at=CASE WHEN $5::boolean THEN NOW() ELSE NULL END,
      lease_expires_at=NULL,
      next_attempt_at=NOW()+($4::integer * INTERVAL '1 second'),
      updated_at=NOW() WHERE event_id=$1`,
    [
      event.event_id,
      persistedStatus,
      message ? message.slice(0, 5_000) : null,
      retrySeconds,
      terminal,
    ],
  );
  if (deadLetter) {
    await centralLog({
      event: "commercial_stripe_webhook_dead_lettered",
      value: {
        stripe_event_id: event.event_id,
        attempt_count: event.attempt_count,
        permanent,
        error: message.slice(0, 1_000),
      },
    });
  }
}

type ReconcileStripeInvoice = typeof reconcileStripeCommercialInvoice;
type ReconcileStripeQuote = typeof reconcileStripeCommercialQuoteById;

async function processClaimedEvent(
  event: any,
  reconcileInvoice: ReconcileStripeInvoice,
  reconcileQuote: ReconcileStripeQuote,
): Promise<void> {
  if (!event.commercial_order_id) {
    await finishEvent(event, "ignored");
    recordCommercialReconciliation("webhook", "ignored");
    return;
  }
  try {
    if (event.commercial_quote_id) {
      await reconcileQuote({
        order_id: event.commercial_order_id,
        commercial_quote_id: event.commercial_quote_id,
        reason: `Stripe webhook ${event.event_type}`,
        source: "stripe-webhook",
        event_idempotency_key: `stripe-event:${event.event_id}`,
      });
    } else {
      await reconcileInvoice({
        id: event.commercial_order_id,
        commercial_invoice_id: event.commercial_invoice_id ?? undefined,
        reason: `Stripe webhook ${event.event_type}`,
        source: "stripe-webhook",
        event_source: "stripe-webhook",
        event_idempotency_key: `stripe-event:${event.event_id}`,
      });
    }
    await finishEvent(event, "processed");
    const latencyMs =
      typeof event.payload?.created === "number"
        ? Math.max(0, Date.now() - event.payload.created * 1000)
        : null;
    recordCommercialReconciliation("webhook", "success");
    if (latencyMs != null) recordCommercialWebhookLatency(latencyMs);
    await centralLog({
      event: "commercial_stripe_webhook_processed",
      value: {
        stripe_event_id: event.event_id,
        event_type: event.event_type,
        commercial_order_id: event.commercial_order_id,
        commercial_quote_id: event.commercial_quote_id,
        commercial_invoice_id: event.commercial_invoice_id,
        latency_ms: latencyMs,
      },
    });
  } catch (err) {
    recordCommercialReconciliation("webhook", "failed");
    await finishEvent(event, "failed", err);
    throw err;
  }
}

export async function processCommercialStripeEventQueue(
  limit = 100,
  reconcileInvoice: ReconcileStripeInvoice = reconcileStripeCommercialInvoice,
  log: Pick<typeof logger, "warn"> = logger,
  reconcileQuote: ReconcileStripeQuote = reconcileStripeCommercialQuoteById,
): Promise<{ processed: number; failed: number }> {
  assertSeed();
  let processed = 0;
  let failed = 0;
  while (processed + failed < Math.min(Math.max(limit, 1), 500)) {
    const event = await claimEvent();
    if (!event) break;
    try {
      await processClaimedEvent(event, reconcileInvoice, reconcileQuote);
      processed += 1;
    } catch (err) {
      failed += 1;
      log.warn("commercial Stripe webhook reconciliation failed", {
        event_id: event.event_id,
        commercial_order_id: event.commercial_order_id,
        error: `${err}`,
      });
    }
  }
  return { processed, failed };
}

export async function reconcileStaleCommercialQuotes(
  opts: {
    stale_minutes?: number;
    limit?: number;
  } = {},
): Promise<{ reconciled: number; failed: number }> {
  assertSeed();
  const ids = await getStaleCommercialQuoteIds(opts);
  let reconciled = 0;
  let failed = 0;
  for (const quoteId of ids) {
    try {
      const { rows } = await getPool().query<{ commercial_order_id: string }>(
        "SELECT commercial_order_id FROM commercial_quotes WHERE id=$1",
        [quoteId],
      );
      if (!rows[0]) throw Error("commercial quote not found");
      const order = await getCommercialOrder(rows[0].commercial_order_id);
      await registerCommercialOrderBillingAccount(order);
      const bucket = Math.floor(Date.now() / (15 * 60_000));
      await reconcileStripeCommercialQuoteById({
        order_id: order.id,
        commercial_quote_id: quoteId,
        reason: "Scheduled Stripe quote reconciliation",
        source: "reconciler",
        event_idempotency_key: `commercial-quote-reconcile:${quoteId}:${bucket}`,
      });
      reconciled += 1;
      recordCommercialReconciliation("scheduled", "success");
    } catch (err) {
      failed += 1;
      recordCommercialReconciliation("scheduled", "failed");
      logger.warn("stale commercial quote reconciliation failed", {
        commercial_quote_id: quoteId,
        error: `${err}`,
      });
    }
  }
  return { reconciled, failed };
}

export async function reconcileStaleCommercialInvoices(
  opts: {
    stale_minutes?: number;
    limit?: number;
  } = {},
): Promise<{ reconciled: number; failed: number }> {
  assertSeed();
  const ids = await getStaleCommercialInvoiceIds(opts);
  let reconciled = 0;
  let failed = 0;
  for (const invoiceId of ids) {
    try {
      const invoice = await getCommercialInvoiceById(invoiceId);
      const order = await getCommercialOrder(invoice.commercial_order_id);
      await registerCommercialOrderBillingAccount(order);
      const bucket = Math.floor(Date.now() / (15 * 60_000));
      await reconcileStripeCommercialInvoice({
        id: order.id,
        commercial_invoice_id: invoice.id,
        reason: "Scheduled Stripe invoice reconciliation",
        source: "reconciler",
        event_source: "reconciler",
        event_idempotency_key: `commercial-reconcile:${invoice.id}:${bucket}`,
      });
      reconciled += 1;
      recordCommercialReconciliation("scheduled", "success");
    } catch (err) {
      failed += 1;
      recordCommercialReconciliation("scheduled", "failed");
      logger.warn("stale commercial invoice reconciliation failed", {
        commercial_invoice_id: invoiceId,
        error: `${err}`,
      });
    }
  }
  return { reconciled, failed };
}

async function getCommercialInvoiceById(invoiceId: string) {
  const { rows } = await getPool().query<{ commercial_order_id: string }>(
    "SELECT commercial_order_id FROM commercial_invoices WHERE id=$1",
    [invoiceId],
  );
  if (!rows[0]) throw Error("commercial invoice not found");
  return await getCommercialInvoice(rows[0].commercial_order_id, invoiceId);
}
