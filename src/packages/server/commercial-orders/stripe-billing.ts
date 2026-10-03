/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createHash } from "node:crypto";
import type {
  CommercialStripeBillingDetails,
  CommercialStripeBillingPreview,
  CommercialStripeBillingPreviewRequest,
  CommercialStripeBillingSyncRequest,
} from "@cocalc/conat/hub/api/commercial-orders";
import type { CommercialOrder } from "@cocalc/util/commercial-orders";
import getConn from "@cocalc/server/stripe/connection";
import { currentStripeSite } from "@cocalc/server/purchases/stripe/util";
import {
  approvedInvoiceTerms,
  assertCommercialStripeCustomerIdentity,
} from "./invoices/stripe";
import {
  assertCommercialStripeBillingSyncAllowed,
  completeCommercialStripeBillingSync,
  getCommercialOrder,
  getCommercialProviderOperationByIdempotencyKey,
  reserveCommercialProviderOperation,
  setCommercialProviderOperationStatus,
} from "./store";
import { requireReason } from "./state";

const addressFields = [
  "line1",
  "line2",
  "city",
  "state",
  "postal_code",
  "country",
];

function details(
  email: string | null | undefined,
  address: unknown,
): CommercialStripeBillingDetails {
  return {
    email: email ?? "",
    // Stripe updates addresses by field. Explicit empty strings clear obsolete
    // fields (e.g. line2/state) rather than retaining an old partial address.
    address: Object.fromEntries(
      addressFields.map((field) => [
        field,
        (address as Record<string, string> | null)?.[field] ?? "",
      ]),
    ),
  };
}

function same(
  a: CommercialStripeBillingDetails,
  b: CommercialStripeBillingDetails,
): boolean {
  // PostgreSQL jsonb reorders object keys in durable operation snapshots.
  return (
    a.email === b.email &&
    addressFields.every((field) => a.address[field] === b.address[field])
  );
}

async function readCustomer(order: CommercialOrder) {
  if (!order.stripe_customer_id)
    throw Error("order has no linked Stripe customer");
  const stripe = await getConn();
  const customer = await stripe.customers.retrieve(order.stripe_customer_id);
  assertCommercialStripeCustomerIdentity(
    customer,
    order,
    await currentStripeSite(),
  );
  if (customer.deleted) throw Error("the selected Stripe customer was deleted");
  return { stripe, customer };
}

async function providerBlockers(
  stripe: Awaited<ReturnType<typeof getConn>>,
  customer: string,
): Promise<string[]> {
  const blockers: string[] = [];
  for (const status of ["draft", "open"] as const) {
    const invoices = await stripe.invoices.list({ customer, status, limit: 1 });
    if (invoices.data.length)
      blockers.push(
        `Stripe customer has a ${status} invoice; void it before billing synchronization`,
      );
  }
  const subscriptions = await stripe.subscriptions.list({
    customer,
    status: "all",
    limit: 100,
  });
  if (
    subscriptions.has_more ||
    subscriptions.data.some(
      ({ status }) => !["canceled", "incomplete_expired"].includes(status),
    )
  ) {
    blockers.push(
      "Stripe customer has subscriptions (or a truncated subscription history); review manually",
    );
  }
  for (const status of ["draft", "open"] as const) {
    const quotes = await stripe.quotes.list({ customer, status, limit: 1 });
    if (quotes.data.length)
      blockers.push(
        `Stripe customer has a ${status} quote; cancel it before billing synchronization`,
      );
  }
  return blockers;
}

export async function stripeBillingPreview(
  opts: CommercialStripeBillingPreviewRequest,
): Promise<CommercialStripeBillingPreview> {
  const order = await getCommercialOrder(opts.id);
  const { stripe, customer } = await readCustomer(order);
  const billing = order.contacts.filter(({ role }) => role === "billing");
  if (billing.length !== 1)
    throw Error("exactly one approved billing contact is required");
  const before = details(customer.email, customer.address);
  const after = details(
    billing[0].email_snapshot,
    approvedInvoiceTerms(order).billing_address,
  );
  const input = {
    order_id: order.id,
    order_version: order.version,
    customer_id: customer.id,
    before,
    after,
  };
  const blockers = await providerBlockers(stripe, customer.id);
  try {
    await assertCommercialStripeBillingSyncAllowed(order);
  } catch (err) {
    blockers.push((err as Error).message);
  }
  return {
    ...input,
    preview_hash: createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex"),
    changed: !same(before, after),
    blockers,
  };
}

export async function syncStripeBilling(
  opts: CommercialStripeBillingSyncRequest,
): Promise<CommercialOrder> {
  requireReason(opts.reason);
  if (
    !opts.account_id ||
    !opts.expected_version ||
    !opts.idempotency_key?.trim()
  ) {
    throw Error(
      "account_id, expected_version and a stable idempotency_key are required",
    );
  }
  if (!/^[a-f0-9]{64}$/.test(opts.preview_hash))
    throw Error("reviewed preview_hash is required");
  const order = await getCommercialOrder(opts.id);
  // A new CLI command key can resume a failed billing-authority command without
  // creating a second provider operation for the same reviewed change.
  const key = `commercial-billing-sync:${order.id}:${opts.preview_hash}`;
  const existing = await getCommercialProviderOperationByIdempotencyKey(key);
  let preview: CommercialStripeBillingPreview;
  if (existing) {
    preview = existing.request
      .preview as unknown as CommercialStripeBillingPreview;
    if (
      existing.operation !== "sync-customer-billing" ||
      existing.commercial_order_id !== order.id ||
      preview.preview_hash !== opts.preview_hash ||
      preview.order_version !== opts.expected_version
    ) {
      throw Error("billing sync replay does not match the reviewed operation");
    }
    if (existing.status === "succeeded") return order;
    if (existing.status === "failed") {
      throw Error(
        "billing sync operation was closed as failed; review a new operation instead of resuming it",
      );
    }
  } else {
    preview = await stripeBillingPreview(opts);
    if (
      preview.order_version !== opts.expected_version ||
      preview.preview_hash !== opts.preview_hash
    ) {
      throw Error(
        "Stripe billing preview changed; review a fresh preview before committing",
      );
    }
    if (preview.blockers.length) throw Error(preview.blockers.join("; "));
  }
  const reservation = existing
    ? { operation: existing }
    : await reserveCommercialProviderOperation({
        order_id: order.id,
        operation: "sync-customer-billing",
        expected_version: opts.expected_version,
        idempotency_key: key,
        request: {
          preview,
          account_id: opts.account_id,
          reason: opts.reason,
          source: opts.source,
        },
      });
  const operation = reservation.operation;
  // A rejection on a retry cannot prove an earlier timed-out call did not apply.
  const firstAttempt =
    operation.status === "reserved" && !operation.remote_started_at;
  let attemptedUpdate = false;
  let definitiveRejection = false;
  try {
    const currentOrder = await getCommercialOrder(order.id);
    const { stripe, customer } = await readCustomer(currentOrder);
    const billing = currentOrder.contacts.filter(
      ({ role }) => role === "billing",
    );
    if (
      customer.id !== preview.customer_id ||
      billing.length !== 1 ||
      !same(
        details(
          billing[0].email_snapshot,
          approvedInvoiceTerms(currentOrder).billing_address,
        ),
        preview.after,
      )
    ) {
      throw Error(
        "approved billing details changed during synchronization; manual reconciliation required",
      );
    }
    const current = details(customer.email, customer.address);
    // Reconciliation is not a new Stripe write. Payments/fulfillment may have
    // completed the order since the original update; still retire its fence.
    if (existing && same(current, preview.after)) {
      await setCommercialProviderOperationStatus({
        id: operation.id,
        status: "remote_started",
      });
      return await completeCommercialStripeBillingSync(operation.id);
    }
    await assertCommercialStripeBillingSyncAllowed(
      currentOrder,
      undefined,
      operation.id,
    );
    if (!same(current, preview.before) && !same(current, preview.after)) {
      throw Error(
        "Stripe billing changed outside the reviewed operation; manual reconciliation required",
      );
    }
    const blockers = await providerBlockers(stripe, customer.id);
    if (blockers.length) throw Error(blockers.join("; "));
    await setCommercialProviderOperationStatus({
      id: operation.id,
      status: "remote_started",
    });
    if (!same(current, preview.after)) {
      attemptedUpdate = true;
      try {
        await stripe.customers.update(customer.id, preview.after, {
          idempotencyKey: key,
        });
      } catch (err) {
        const rejection = err as {
          type?: string;
          statusCode?: number;
          requestId?: string;
        };
        // Only an authenticated provider validation response plus unchanged
        // readback proves this first update was rejected. Never infer this from
        // arbitrary 4xx, timeouts, transport failures or idempotency conflicts.
        if (
          firstAttempt &&
          rejection.type === "StripeInvalidRequestError" &&
          rejection.statusCode === 400 &&
          rejection.requestId
        ) {
          try {
            const readback = await readCustomer(currentOrder);
            definitiveRejection = same(
              details(readback.customer.email, readback.customer.address),
              preview.before,
            );
          } catch {
            // Failed readback leaves the outcome unknown and fenced.
          }
        }
        throw err;
      }
    }
    // Reconcile from a fresh provider read, including after a timed-out update.
    const verified = await readCustomer(currentOrder);
    if (
      !same(
        details(verified.customer.email, verified.customer.address),
        preview.after,
      )
    ) {
      throw Error(
        "Stripe customer billing update could not be verified; retry this reviewed operation",
      );
    }
    return await completeCommercialStripeBillingSync(operation.id);
  } catch (err) {
    if ((firstAttempt && !attemptedUpdate) || definitiveRejection) {
      await completeCommercialStripeBillingSync(operation.id, { error: err });
      throw err;
    }
    await setCommercialProviderOperationStatus({
      id: operation.id,
      status: "indeterminate",
      error: err,
    });
    throw err;
  }
}
