/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { getLogger } from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import type {
  CommercialInvoiceMutationRequest,
  CommercialInvoiceLinkRequest,
  CommercialManualPaymentRequest,
  CommercialInvoicePreview,
  CommercialInvoicePreviewRequest,
  CommercialReconcilePreview,
  CommercialReconcilePreviewRequest,
} from "@cocalc/conat/hub/api/commercial-orders";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterSeedBayId } from "@cocalc/server/cluster-config";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";
import { currentStripeSite } from "@cocalc/server/purchases/stripe/util";
import getConn from "@cocalc/server/stripe/connection";
import type {
  CommercialCollectionState,
  CommercialEventSource,
  CommercialInvoice,
  CommercialOrder,
  CommercialPaymentMethod,
  CommercialUnlinkedStripeInvoice,
} from "@cocalc/util/commercial-orders";
import {
  moneyAdd,
  moneyCompare,
  moneySubtract,
  moneyToDbString,
  stripeToMoney,
  toDecimal,
} from "@cocalc/util/money";
import { decimalToStripe } from "@cocalc/util/stripe/calc";
import {
  commercialIdempotencyKey,
  createCommercialInvoiceIntent,
  getCommercialInvoice,
  getCommercialOrder,
  normalizeInvoiceRow,
  recordManualCommercialPayment,
  reserveCommercialProviderOperation,
  setCommercialProviderOperationStatus,
  updateCommercialInvoiceProvider,
} from "../store";
import { recordCommercialProviderFailure } from "../observability";
import { commercialTaxPolicy, assertCommercialAutomaticTax } from "../tax";
import {
  assertInvoiceReady,
  invoiceCollectionState,
  normalizeCurrency,
  normalizePositiveMoney,
  requireReason,
} from "../state";

const logger = getLogger("server:commercial-orders:stripe");
const FLOW = "commercial_order";
const PAYMENT_METHOD_TYPES = ["card", "us_bank_account"] as const;

function dueAt(order: CommercialOrder, from = new Date()): string {
  const date = new Date(from.getTime());
  date.setUTCDate(
    date.getUTCDate() + Math.max(order.payment_terms_days ?? 21, 0),
  );
  return date.toISOString();
}

export function approvedInvoiceTerms(order: CommercialOrder): {
  memo?: string;
  billing_address?: Record<string, string>;
} {
  const value = order.terms_snapshot.invoice;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const invoice = value as Record<string, unknown>;
  const addressFields = new Set([
    "line1",
    "line2",
    "city",
    "state",
    "postal_code",
    "country",
  ]);
  const address =
    invoice.billing_address &&
    typeof invoice.billing_address === "object" &&
    !Array.isArray(invoice.billing_address)
      ? Object.fromEntries(
          Object.entries(invoice.billing_address).filter(
            (entry): entry is [string, string] =>
              addressFields.has(entry[0]) &&
              typeof entry[1] === "string" &&
              !!entry[1].trim(),
          ),
        )
      : undefined;
  const memo =
    typeof invoice.memo === "string" && invoice.memo.trim()
      ? invoice.memo.trim()
      : undefined;
  return {
    memo,
    billing_address:
      address && Object.keys(address).length ? address : undefined,
  };
}

async function invoicePreviewForOrder(
  order: CommercialOrder,
  ignoreActiveInvoiceId?: string,
): Promise<CommercialInvoicePreview> {
  const blockers: string[] = [];
  const invoiceTerms = approvedInvoiceTerms(order);
  const taxPolicy = commercialTaxPolicy(order.terms_snapshot);
  try {
    assertInvoiceReady(order);
  } catch (err) {
    blockers.push(`${err}`.replace(/^Error:\s*/, ""));
  }
  if (
    order.invoices.some(
      ({ id, status }) =>
        id !== ignoreActiveInvoiceId &&
        ["creating", "draft", "open"].includes(status),
    )
  ) {
    blockers.push("the order already has an active invoice");
  }
  if (
    !taxPolicy.enabled &&
    moneyCompare(order.agreed_subtotal, order.agreed_total) !== 0
  ) {
    blockers.push(
      "agreed_total must equal agreed_subtotal unless reviewed automatic tax is enabled",
    );
  }
  return {
    automatic_tax: taxPolicy.enabled,
    tax_code: taxPolicy.taxCode,
    order_id: order.id,
    order_number: order.order_number,
    organization_name: order.organization_name,
    stripe_customer_id: order.stripe_customer_id,
    billing_contacts: order.contacts.filter(({ role }) => role === "billing"),
    items: order.items,
    currency: order.currency,
    subtotal: order.agreed_subtotal,
    total: order.agreed_total,
    due_at: dueAt(order),
    payment_terms_days: order.payment_terms_days ?? 21,
    po_number: order.po_number,
    customer_reference: order.customer_reference,
    invoice_memo: invoiceTerms.memo,
    billing_address: invoiceTerms.billing_address,
    metadata: {
      flow: FLOW,
      commercial_order_id: order.id,
      order_number: order.order_number,
      cocalc_site: await currentStripeSite(),
    },
    ready: blockers.length === 0,
    blockers,
  };
}

export async function commercialInvoicePreview(
  opts: CommercialInvoicePreviewRequest,
): Promise<CommercialInvoicePreview> {
  requireReason(opts.reason);
  return await invoicePreviewForOrder(await getCommercialOrder(opts.id));
}

export async function commercialReconcilePreview(
  opts: CommercialReconcilePreviewRequest,
): Promise<CommercialReconcilePreview> {
  requireReason(opts.reason);
  const order = await getCommercialOrder(opts.id);
  const invoice = await getCommercialInvoice(
    order.id,
    opts.commercial_invoice_id,
  );
  const blockers: string[] = [];
  if (!invoice.provider_invoice_id) {
    blockers.push("the local invoice is not attached to a Stripe invoice");
  }
  if (["paid", "void", "uncollectible"].includes(invoice.status)) {
    blockers.push(`invoice status ${invoice.status} is already terminal`);
  }
  const reconciledAt = invoice.last_reconciled_at
    ? new Date(invoice.last_reconciled_at).getTime()
    : 0;
  return {
    order_id: order.id,
    commercial_invoice_id: invoice.id,
    provider_invoice_id: invoice.provider_invoice_id,
    local_status: invoice.status,
    local_total: invoice.total,
    local_amount_due: invoice.amount_due,
    last_reconciled_at: invoice.last_reconciled_at,
    stale: reconciledAt < Date.now() - 15 * 60_000,
    ready: blockers.length === 0,
    blockers,
  };
}

export async function findUnlinkedCommercialStripeInvoices(
  limit = 500,
): Promise<{
  invoices: CommercialUnlinkedStripeInvoice[];
  truncated: boolean;
}> {
  const cappedLimit = Math.min(Math.max(limit, 1), 500);
  const stripe = await getConn();
  const site = await currentStripeSite();
  const found: any[] = [];
  let page: string | undefined;
  do {
    const response = await stripe.invoices.search({
      query: `metadata['flow']:'${FLOW}' AND metadata['cocalc_site']:'${site}'`,
      limit: 100,
      ...(page ? { page } : {}),
    });
    for (const invoice of response.data) {
      assertStripeMode(stripe, invoice);
      found.push(invoice);
      if (found.length > cappedLimit) break;
    }
    if (found.length > cappedLimit || !response.has_more) break;
    page = response.next_page ?? undefined;
    if (!page) throw Error("Stripe returned an invalid invoice search page");
  } while (true);
  const candidates = found.slice(0, cappedLimit);
  if (!candidates.length) return { invoices: [], truncated: false };
  const ids = candidates.map(({ id }) => id);
  const { rows } = await getPool().query<{ provider_invoice_id: string }>(
    `SELECT provider_invoice_id FROM commercial_invoices
      WHERE provider='stripe' AND provider_invoice_id=ANY($1::text[])`,
    [ids],
  );
  const linked = new Set(
    rows.map(({ provider_invoice_id }) => provider_invoice_id),
  );
  return {
    invoices: candidates
      .filter(({ id }) => !linked.has(id))
      .map((invoice) => ({
        provider_invoice_id: invoice.id,
        status: `${invoice.status ?? "unknown"}`,
        currency: `${invoice.currency ?? ""}`.toLowerCase(),
        amount_due: fromStripeAmount(invoice.amount_due),
        commercial_order_id: invoice.metadata?.commercial_order_id ?? null,
        commercial_invoice_id: invoice.metadata?.commercial_invoice_id ?? null,
        order_number: invoice.metadata?.order_number ?? null,
        created_at: timestamp(invoice.created),
      })),
    truncated: found.length > cappedLimit,
  };
}

function invoiceCustomerId(invoice: any): string | undefined {
  return typeof invoice?.customer === "string"
    ? invoice.customer
    : invoice?.customer?.id;
}

function paymentIntentId(invoice: any): string | undefined {
  if (typeof invoice?.payment_intent === "string")
    return invoice.payment_intent;
  if (invoice?.payment_intent?.id) return invoice.payment_intent.id;
  const payments = invoice?.payments?.data ?? [];
  for (const payment of payments) {
    const value = payment?.payment?.payment_intent;
    if (typeof value === "string") return value;
    if (value?.id) return value.id;
  }
  return undefined;
}

function fromStripeAmount(value: unknown): string {
  return moneyToDbString(stripeToMoney(Number(value ?? 0)));
}

function timestamp(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value * 1000).toISOString()
    : null;
}

function providerSnapshot(invoice: any): Record<string, unknown> {
  return {
    id: invoice?.id,
    object: invoice?.object,
    livemode: invoice?.livemode,
    status: invoice?.status,
    currency: invoice?.currency,
    customer: invoiceCustomerId(invoice),
    subtotal: invoice?.subtotal,
    total: invoice?.total,
    amount_due: invoice?.amount_due,
    amount_paid: invoice?.amount_paid,
    amount_remaining: invoice?.amount_remaining,
    due_date: invoice?.due_date,
    collection_method: invoice?.collection_method,
    auto_advance: invoice?.auto_advance,
    automatic_tax: invoice?.automatic_tax,
    total_taxes: invoice?.total_taxes,
    custom_fields: invoice?.custom_fields,
    description: invoice?.description,
    payment_settings: invoice?.payment_settings,
    created: invoice?.created,
    status_transitions: invoice?.status_transitions,
    metadata: invoice?.metadata,
    payment_intent: paymentIntentId(invoice),
    payments: (invoice?.payments?.data ?? []).map((payment) => {
      const intent = payment?.payment?.payment_intent;
      return {
        id: payment?.id,
        status: payment?.status,
        amount_paid: payment?.amount_paid,
        amount_requested: payment?.amount_requested,
        created: payment?.created,
        paid_at: payment?.status_transitions?.paid_at,
        payment_intent:
          typeof intent === "string" ? intent : (intent?.id ?? null),
        payment_intent_status:
          typeof intent === "object" ? intent?.status : null,
        payment_method:
          typeof intent === "object" ? intent?.payment_method : null,
      };
    }),
  };
}

function normalizedStatus(value: unknown): CommercialInvoice["status"] {
  switch (value) {
    case "draft":
    case "open":
    case "paid":
    case "void":
    case "uncollectible":
      return value;
    default:
      return "failed";
  }
}

function paymentMethod(payment: any): CommercialPaymentMethod {
  const type = payment?.payment?.type;
  const method = payment?.payment?.payment_intent?.payment_method_types?.[0];
  if (method === "us_bank_account") return "ach";
  if (method === "customer_balance") return "bank_transfer";
  if (method === "card" || type === "payment_intent") return "card";
  return "other";
}

function normalizedPayments(invoice: any) {
  return (invoice?.payments?.data ?? [])
    .filter(
      (payment) =>
        payment?.id &&
        (payment.status === "paid" || Number(payment.amount_paid ?? 0) > 0),
    )
    .map((payment) => {
      const underlying = payment?.payment?.payment_intent;
      return {
        id: payment.id,
        underlying_payment_id:
          typeof underlying === "string"
            ? underlying
            : (underlying?.id ?? null),
        amount: fromStripeAmount(
          payment.amount_paid ?? payment.amount_requested,
        ),
        currency: `${invoice.currency ?? "usd"}`.toLowerCase(),
        status: "succeeded",
        received_at:
          timestamp(payment.status_transitions?.paid_at) ??
          timestamp(invoice.status_transitions?.paid_at) ??
          timestamp(payment.created) ??
          timestamp(invoice.created)!,
        method: paymentMethod(payment),
      };
    });
}

function assertStripeMode(
  stripe: Awaited<ReturnType<typeof getConn>>,
  invoice: any,
): void {
  const expectedLive = stripe.publishable_key.startsWith("pk_live_");
  if (invoice?.livemode !== expectedLive) {
    throw Error("Stripe invoice mode does not match configured Stripe keys");
  }
}

async function assertStripeLinkIdentity(
  invoice: any,
  internalInvoice: CommercialInvoice,
): Promise<void> {
  const site = await currentStripeSite();
  if (
    invoice?.metadata?.flow !== FLOW ||
    invoice?.metadata?.commercial_order_id !==
      internalInvoice.commercial_order_id ||
    invoice?.metadata?.commercial_invoice_id !== internalInvoice.id ||
    invoice?.metadata?.cocalc_site !== site
  ) {
    throw Error(
      "Stripe invoice metadata does not match the commercial invoice",
    );
  }
  if (`${invoice?.currency ?? ""}`.toLowerCase() !== internalInvoice.currency) {
    throw Error("Stripe invoice currency does not match the commercial order");
  }
  if (
    internalInvoice.provider_invoice_id &&
    invoice?.id !== internalInvoice.provider_invoice_id
  ) {
    throw Error("Stripe invoice id does not match the linked provider invoice");
  }
  const customer = invoiceCustomerId(invoice);
  if (
    internalInvoice.provider_customer_id &&
    customer !== internalInvoice.provider_customer_id
  ) {
    throw Error("Stripe customer does not match the linked commercial invoice");
  }
}

async function assertStripeIdentity(
  invoice: any,
  internalInvoice: CommercialInvoice,
): Promise<void> {
  await assertStripeLinkIdentity(invoice, internalInvoice);
  if (Number(invoice?.total) !== decimalToStripe(internalInvoice.total)) {
    throw Error("Stripe invoice total does not match the commercial order");
  }
}

async function findStripeInvoiceByMetadata(
  stripe: Awaited<ReturnType<typeof getConn>>,
  internalInvoiceId: string,
): Promise<any | undefined> {
  try {
    const result = await stripe.invoices.search({
      query: `metadata['commercial_invoice_id']:'${internalInvoiceId}'`,
      limit: 2,
    } as any);
    if (result.data.length > 1) {
      throw Error(`multiple Stripe invoices reference ${internalInvoiceId}`);
    }
    return result.data[0];
  } catch (err) {
    logger.warn("Stripe invoice metadata search failed", {
      commercial_invoice_id: internalInvoiceId,
      error: `${err}`,
    });
    throw err;
  }
}

async function retrieveStripeInvoice(
  stripe: Awaited<ReturnType<typeof getConn>>,
  invoice: CommercialInvoice,
): Promise<any> {
  if (invoice.provider_invoice_id) {
    return await stripe.invoices.retrieve(invoice.provider_invoice_id, {
      expand: ["payments.data.payment.payment_intent"],
    } as any);
  }
  const found = await findStripeInvoiceByMetadata(stripe, invoice.id);
  if (!found)
    throw Error(
      "Stripe invoice has not been attached and cannot be found by metadata",
    );
  return found;
}

async function resolveCustomer(opts: {
  stripe: Awaited<ReturnType<typeof getConn>>;
  order: CommercialOrder;
  invoice: CommercialInvoice;
  keyPrefix: string;
}): Promise<string> {
  return await resolveCommercialStripeCustomer({
    stripe: opts.stripe,
    order: opts.order,
    providerCustomerId: opts.invoice.provider_customer_id,
    keyPrefix: opts.keyPrefix,
  });
}

export async function resolveCommercialStripeCustomer(opts: {
  stripe: Awaited<ReturnType<typeof getConn>>;
  order: CommercialOrder;
  providerCustomerId?: string | null;
  keyPrefix: string;
}): Promise<string> {
  const billing = opts.order.contacts.find(({ role }) => role === "billing");
  if (!billing) throw Error("a billing contact is required");
  const site = await currentStripeSite();
  const existing = await findExistingCustomer({
    stripe: opts.stripe,
    order: opts.order,
    providerCustomerId: opts.providerCustomerId,
    site,
  });
  if (existing) return existing;
  const customer = await opts.stripe.customers.create(
    {
      name: opts.order.organization_name,
      description: `CoCalc institutional customer for ${opts.order.order_number}`,
      email: billing.email_snapshot,
      address: approvedInvoiceTerms(opts.order).billing_address,
      metadata: {
        flow: FLOW,
        commercial_organization_key: commercialOrganizationKey(
          opts.order.organization_name,
        ),
        commercial_organization_name: opts.order.organization_name.trim(),
        created_for_commercial_order_id: opts.order.id,
        cocalc_site: site,
      },
    },
    { idempotencyKey: `${opts.keyPrefix}:customer` },
  );
  assertCustomerMatchesOrder(customer, opts.order, site);
  return customer.id;
}

async function findExistingCustomer(opts: {
  stripe: Awaited<ReturnType<typeof getConn>>;
  order: CommercialOrder;
  providerCustomerId?: string | null;
  site?: string;
}): Promise<string | undefined> {
  const site = opts.site ?? (await currentStripeSite());
  const explicit =
    opts.providerCustomerId ?? opts.order.stripe_customer_id ?? undefined;
  if (explicit) {
    const customer = await opts.stripe.customers.retrieve(explicit);
    assertCustomerMatchesOrder(customer, opts.order, site);
    return explicit;
  }
  const organizationKey = commercialOrganizationKey(
    opts.order.organization_name,
  );
  const matches = await opts.stripe.customers.search({
    query: [
      `metadata['flow']:'${FLOW}'`,
      `metadata['commercial_organization_key']:'${escapeStripeSearchValue(organizationKey)}'`,
      `metadata['cocalc_site']:'${escapeStripeSearchValue(site)}'`,
    ].join(" AND "),
    limit: 10,
  } as any);
  const candidates = (matches.data ?? []).filter(
    (customer: any) => !customer.deleted,
  );
  if (candidates.length > 1) {
    throw Error(
      `multiple Stripe customers match ${opts.order.organization_name}; select one explicitly`,
    );
  }
  if (candidates[0]) {
    assertCustomerMatchesOrder(candidates[0], opts.order, site);
    return candidates[0].id;
  }
  return undefined;
}

export async function findExistingCommercialStripeCustomer(opts: {
  stripe: Awaited<ReturnType<typeof getConn>>;
  order: CommercialOrder;
  providerCustomerId?: string | null;
  site?: string;
}): Promise<string | undefined> {
  return await findExistingCustomer(opts);
}

function normalizeText(value: unknown): string {
  return `${value ?? ""}`.trim().replace(/\s+/g, " ").toLowerCase();
}

function commercialOrganizationKey(value: string): string {
  return normalizeText(value).slice(0, 240);
}

function escapeStripeSearchValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function assertCustomerMatchesOrder(
  customer: any,
  order: CommercialOrder,
  site: string,
): void {
  if (!customer || customer.deleted) {
    throw Error("the selected Stripe customer was deleted");
  }
  const billing = order.contacts.find(({ role }) => role === "billing");
  if (!billing) throw Error("a billing contact is required");
  if (normalizeText(customer.name) !== normalizeText(order.organization_name)) {
    throw Error(
      "Stripe customer name does not match the approved organization",
    );
  }
  if (normalizeText(customer.email) !== normalizeText(billing.email_snapshot)) {
    throw Error(
      "Stripe customer email does not match the approved billing contact",
    );
  }
  const expectedAddress = approvedInvoiceTerms(order).billing_address;
  if (expectedAddress) {
    for (const [field, expected] of Object.entries(expectedAddress)) {
      if (
        normalizeText(customer.address?.[field]) !== normalizeText(expected)
      ) {
        throw Error(
          `Stripe customer billing address field ${field} does not match the approved order`,
        );
      }
    }
  }
  const metadata = customer.metadata ?? {};
  if (
    metadata.flow !== FLOW ||
    metadata.cocalc_site !== site ||
    metadata.commercial_organization_key !==
      commercialOrganizationKey(order.organization_name) ||
    metadata.commercial_organization_name !== order.organization_name.trim()
  ) {
    throw Error(
      "Stripe customer metadata does not match the approved organization",
    );
  }
}

export function customFields(order: CommercialOrder): Array<{
  name: string;
  value: string;
}> {
  return [
    order.po_number ? { name: "PO number", value: order.po_number } : undefined,
    order.customer_reference
      ? { name: "Customer reference", value: order.customer_reference }
      : undefined,
  ].filter(Boolean) as Array<{ name: string; value: string }>;
}

function invoiceDescription(order: CommercialOrder): string {
  return (
    approvedInvoiceTerms(order).memo ??
    `${order.organization_name}: ${order.order_number}`
  );
}

function expectedDueDate(invoice: CommercialInvoice): number {
  const dueAt = new Date(invoice.due_at ?? "").getTime();
  if (!Number.isFinite(dueAt)) {
    throw Error("the commercial invoice does not have a valid due date");
  }
  return Math.floor(dueAt / 1000);
}

function sortedCustomFields(value: unknown): Array<{
  name: string;
  value: string;
}> {
  if (!Array.isArray(value)) return [];
  return value
    .map((field) => ({
      name: `${field?.name ?? ""}`,
      value: `${field?.value ?? ""}`,
    }))
    .sort((a, b) =>
      `${a.name}\0${a.value}`.localeCompare(`${b.name}\0${b.value}`),
    );
}

function sortedPaymentMethods(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).sort() : [];
}

async function assertInvoiceDeliveryMatchesOrder(opts: {
  stripe: Awaited<ReturnType<typeof getConn>>;
  stripeInvoice: any;
  internalInvoice: CommercialInvoice;
  order: CommercialOrder;
}): Promise<void> {
  await assertStripeIdentity(opts.stripeInvoice, opts.internalInvoice);
  assertInvoiceDeliveryConfiguration(
    opts.stripeInvoice,
    opts.order,
    expectedDueDate(opts.internalInvoice),
  );
  const customerId = invoiceCustomerId(opts.stripeInvoice);
  if (!customerId) throw Error("Stripe invoice has no customer recipient");
  const customer = await opts.stripe.customers.retrieve(customerId);
  assertCustomerMatchesOrder(customer, opts.order, await currentStripeSite());
}

function assertInvoiceDeliveryConfiguration(
  stripeInvoice: any,
  order: CommercialOrder,
  dueDate: number,
  exactDueDate = true,
): void {
  if (stripeInvoice.collection_method !== "send_invoice") {
    throw Error("Stripe invoice collection method is not send_invoice");
  }
  if (stripeInvoice.auto_advance !== false) {
    throw Error("Stripe invoice auto_advance must remain disabled");
  }
  const actualDueDate = Number(stripeInvoice.due_date);
  const dueDateMatches = exactDueDate
    ? actualDueDate === dueDate
    : Number.isFinite(actualDueDate) &&
      new Date(actualDueDate * 1000).toISOString().slice(0, 10) ===
        new Date(dueDate * 1000).toISOString().slice(0, 10);
  if (!dueDateMatches) {
    throw Error("Stripe invoice due terms do not match the approved order");
  }
  if (
    JSON.stringify(sortedCustomFields(stripeInvoice.custom_fields)) !==
    JSON.stringify(sortedCustomFields(customFields(order)))
  ) {
    throw Error("Stripe invoice custom fields do not match the approved order");
  }
  if (`${stripeInvoice.description ?? ""}` !== invoiceDescription(order)) {
    throw Error("Stripe invoice description does not match the approved order");
  }
  if (stripeInvoice.metadata?.order_number !== order.order_number) {
    throw Error(
      "Stripe invoice order reference does not match the approved order",
    );
  }
  assertCommercialAutomaticTax(stripeInvoice, order);
  if (
    JSON.stringify(
      sortedPaymentMethods(
        stripeInvoice.payment_settings?.payment_method_types,
      ),
    ) !== JSON.stringify([...PAYMENT_METHOD_TYPES].sort())
  ) {
    throw Error(
      "Stripe invoice payment settings do not match the approved order",
    );
  }
}

async function listStripeInvoiceLines(
  stripe: Awaited<ReturnType<typeof getConn>>,
  invoiceId: string,
): Promise<any[]> {
  const lines: any[] = [];
  let startingAfter: string | undefined;
  do {
    const page = await stripe.invoices.listLineItems(invoiceId, {
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    lines.push(...page.data);
    if (!page.has_more) break;
    startingAfter = page.data.at(-1)?.id;
    if (!startingAfter) {
      throw Error("Stripe returned an invalid invoice line-item page");
    }
  } while (true);
  return lines;
}

async function ensureStripeInvoiceItems(opts: {
  stripe: Awaited<ReturnType<typeof getConn>>;
  stripeInvoice: any;
  order: CommercialOrder;
  customer: string;
  keyPrefix: string;
}): Promise<void> {
  const expected = new Map(opts.order.items.map((item) => [item.id, item]));
  for (const line of await listStripeInvoiceLines(
    opts.stripe,
    opts.stripeInvoice.id,
  )) {
    const itemId = line.metadata?.commercial_order_item_id;
    const item = itemId ? expected.get(itemId) : undefined;
    if (
      !item ||
      Number(line.amount) !== decimalToStripe(item.subtotal) ||
      `${line.currency ?? ""}`.toLowerCase() !== opts.order.currency ||
      `${line.description ?? ""}` !== item.description
    ) {
      throw Error("Stripe draft line items do not match the approved order");
    }
    expected.delete(itemId);
  }
  if (expected.size && opts.stripeInvoice.status !== "draft") {
    throw Error("a finalized Stripe invoice is missing approved line items");
  }
  for (const item of expected.values()) {
    await opts.stripe.invoiceItems.create(
      {
        invoice: opts.stripeInvoice.id,
        customer: opts.customer,
        amount: decimalToStripe(item.subtotal),
        currency: opts.order.currency,
        description: item.description,
        ...(commercialTaxPolicy(opts.order.terms_snapshot).enabled
          ? {
              tax_behavior: "exclusive" as const,
              tax_code: commercialTaxPolicy(opts.order.terms_snapshot).taxCode,
            }
          : {}),
        metadata: {
          commercial_order_item_id: item.id,
          product_kind: item.product_kind,
        },
      },
      { idempotencyKey: `${opts.keyPrefix}:item:${item.id}` },
    );
  }
}

async function applyStripeInvoice(opts: {
  internalInvoice: CommercialInvoice;
  stripeInvoice: any;
  event_type: string;
  event_source: CommercialEventSource;
  event_reason: string;
  event_idempotency_key: string;
  actor_account_id?: string;
  include_provider_payments?: boolean;
  skip_if_unchanged?: boolean;
}): Promise<CommercialOrder> {
  const stripe = await getConn();
  assertStripeMode(stripe, opts.stripeInvoice);
  await assertStripeIdentity(opts.stripeInvoice, opts.internalInvoice);
  const status = normalizedStatus(opts.stripeInvoice.status);
  const normalized: Pick<
    CommercialInvoice,
    "status" | "amount_due" | "amount_paid" | "due_at"
  > = {
    status,
    amount_due: fromStripeAmount(
      opts.stripeInvoice.amount_remaining ?? opts.stripeInvoice.amount_due,
    ),
    amount_paid: fromStripeAmount(opts.stripeInvoice.amount_paid),
    due_at:
      timestamp(opts.stripeInvoice.due_date) ?? opts.internalInvoice.due_at,
  };
  const collectionState: CommercialCollectionState =
    invoiceCollectionState(normalized);
  return await updateCommercialInvoiceProvider({
    invoice_id: opts.internalInvoice.id,
    status,
    provider_customer_id: invoiceCustomerId(opts.stripeInvoice),
    provider_invoice_id: opts.stripeInvoice.id,
    provider_payment_intent_id: paymentIntentId(opts.stripeInvoice),
    subtotal: fromStripeAmount(opts.stripeInvoice.subtotal),
    tax: fromStripeAmount(
      (opts.stripeInvoice.total_taxes ?? []).reduce(
        (total: number, tax: any) => total + Number(tax.amount ?? 0),
        0,
      ),
    ),
    total: fromStripeAmount(opts.stripeInvoice.total),
    amount_due: normalized.amount_due,
    amount_paid: normalized.amount_paid,
    due_at: normalized.due_at,
    hosted_invoice_url: opts.stripeInvoice.hosted_invoice_url,
    invoice_pdf_url: opts.stripeInvoice.invoice_pdf,
    sent_at: timestamp(opts.stripeInvoice.status_transitions?.finalized_at),
    paid_at: timestamp(opts.stripeInvoice.status_transitions?.paid_at),
    voided_at: timestamp(opts.stripeInvoice.status_transitions?.voided_at),
    provider_snapshot: providerSnapshot(opts.stripeInvoice),
    provider_payments:
      opts.include_provider_payments === false
        ? []
        : normalizedPayments(opts.stripeInvoice),
    collection_state: collectionState,
    event_type: opts.event_type,
    event_source: opts.event_source,
    event_reason: opts.event_reason,
    event_idempotency_key: opts.event_idempotency_key,
    actor_account_id: opts.actor_account_id,
    skip_if_unchanged: opts.skip_if_unchanged,
  });
}

export async function createStripeCommercialInvoiceDraft(
  opts: CommercialInvoiceMutationRequest,
): Promise<CommercialOrder> {
  const reason = requireReason(opts.reason);
  if (!opts.account_id) throw Error("account_id is required");
  if (!opts.expected_version) throw Error("expected_version is required");
  const intentKey = commercialIdempotencyKey("invoice-draft", opts as any);
  const orderBefore = await getCommercialOrder(opts.id);
  const replayInvoice = orderBefore.invoices.find(
    ({ idempotency_key }) => idempotency_key === intentKey,
  );
  if (replayInvoice && replayInvoice.status !== "creating") {
    return orderBefore;
  }
  const preview = await invoicePreviewForOrder(orderBefore, replayInvoice?.id);
  if (!preview.ready)
    throw Error(`invoice is not ready: ${preview.blockers.join("; ")}`);
  const stripe = await getConn();
  await findExistingCustomer({
    stripe,
    order: orderBefore,
    providerCustomerId: replayInvoice?.provider_customer_id,
  });
  const { order, invoice } = replayInvoice
    ? { order: orderBefore, invoice: replayInvoice }
    : await createCommercialInvoiceIntent({
        order_id: preview.order_id,
        actor_account_id: opts.account_id,
        expected_version: opts.expected_version,
        reason,
        idempotency_key: intentKey,
        due_at: preview.due_at,
      });
  if (invoice.status !== "creating") return order;
  const keyPrefix = `cocalc:${await currentStripeSite()}:commercial-invoice:${invoice.id}:v1`;
  const reservation = await reserveCommercialProviderOperation({
    order_id: order.id,
    invoice_id: invoice.id,
    operation: "create-invoice",
    expected_version: order.version,
    idempotency_key: `${keyPrefix}:operation:create`,
    request: { order_version: order.version, invoice_id: invoice.id },
  });
  if (reservation.operation.status === "succeeded") {
    return await getCommercialOrder(order.id);
  }
  await setCommercialProviderOperationStatus({
    id: reservation.operation.id,
    status: "remote_started",
  });
  try {
    let stripeInvoice = await findStripeInvoiceByMetadata(stripe, invoice.id);
    let customer: string;
    if (!stripeInvoice) {
      customer = await resolveCustomer({
        stripe,
        order,
        invoice,
        keyPrefix,
      });
      stripeInvoice = await stripe.invoices.create(
        {
          customer,
          auto_advance: false,
          collection_method: "send_invoice",
          // Relative terms remain valid after local DB work or a delayed retry.
          // Stripe calculates the authoritative due timestamp when it creates
          // the invoice, including for due-on-receipt (zero-day) invoices.
          days_until_due: preview.payment_terms_days,
          currency: preview.currency,
          custom_fields: customFields(order),
          description: invoiceDescription(order),
          metadata: {
            ...preview.metadata,
            commercial_invoice_id: invoice.id,
          },
          automatic_tax: {
            enabled: commercialTaxPolicy(order.terms_snapshot).enabled,
          },
          payment_settings: {
            payment_method_types: [...PAYMENT_METHOD_TYPES],
          },
        },
        { idempotencyKey: `${keyPrefix}:invoice` },
      );
    } else {
      assertStripeMode(stripe, stripeInvoice);
      await assertStripeLinkIdentity(stripeInvoice, invoice);
      customer = invoiceCustomerId(stripeInvoice) ?? "";
      if (!customer) throw Error("Stripe invoice has no customer recipient");
      assertCustomerMatchesOrder(
        await stripe.customers.retrieve(customer),
        order,
        await currentStripeSite(),
      );
    }
    await ensureStripeInvoiceItems({
      stripe,
      stripeInvoice,
      order,
      customer,
      keyPrefix,
    });
    stripeInvoice = await stripe.invoices.retrieve(stripeInvoice.id, {
      expand: ["payments.data.payment.payment_intent"],
    } as any);
    const updated = await applyStripeInvoice({
      internalInvoice: invoice,
      stripeInvoice,
      event_type: "invoice-draft-created",
      event_source: opts.source ?? "cli",
      event_reason: reason,
      event_idempotency_key: `${intentKey}:attached`,
      actor_account_id: opts.account_id,
    });
    await setCommercialProviderOperationStatus({
      id: reservation.operation.id,
      status: "succeeded",
      result: { provider_invoice_id: stripeInvoice.id },
    });
    return updated;
  } catch (err) {
    recordCommercialProviderFailure("invoice-draft");
    await setCommercialProviderOperationStatus({
      id: reservation.operation.id,
      status: "indeterminate",
      error: err,
    });
    throw err;
  }
}

export async function linkExistingStripeCommercialInvoice(
  opts: CommercialInvoiceLinkRequest,
): Promise<CommercialOrder> {
  const reason = requireReason(opts.reason);
  if (!opts.account_id || !opts.expected_version) {
    throw Error("account_id and expected_version are required");
  }
  if (!/^in_[A-Za-z0-9]+$/.test(opts.provider_invoice_id)) {
    throw Error("a valid Stripe invoice id is required");
  }
  const orderBefore = await getCommercialOrder(opts.id);
  assertInvoiceReady(orderBefore);
  const intentKey = commercialIdempotencyKey("invoice-link", opts as any);
  const replayInvoice = orderBefore.invoices.find(
    ({ idempotency_key }) => idempotency_key === intentKey,
  );
  if (
    !replayInvoice &&
    orderBefore.invoices.some(({ status }) =>
      ["creating", "draft", "open"].includes(status),
    )
  ) {
    throw Error("the order already has an active invoice");
  }
  const stripe = await getConn();
  let stripeInvoice = await stripe.invoices.retrieve(opts.provider_invoice_id, {
    expand: ["payments.data.payment.payment_intent"],
  } as any);
  await assertExistingStripeInvoiceCandidate({
    stripe,
    stripeInvoice,
    order: orderBefore,
    commercialInvoiceId: replayInvoice?.id,
  });
  const { order, invoice } = replayInvoice
    ? { order: orderBefore, invoice: replayInvoice }
    : await createCommercialInvoiceIntent({
        order_id: orderBefore.id,
        actor_account_id: opts.account_id,
        expected_version: opts.expected_version,
        reason,
        idempotency_key: intentKey,
        due_at: dueAt(orderBefore),
      });
  if (invoice.status !== "creating") return order;
  const keyPrefix = `cocalc:${await currentStripeSite()}:commercial-invoice:${invoice.id}:link-v1`;
  const reservation = await reserveCommercialProviderOperation({
    order_id: order.id,
    invoice_id: invoice.id,
    operation: "link-existing-invoice",
    expected_version: order.version,
    idempotency_key: `${keyPrefix}:operation`,
    request: { provider_invoice_id: opts.provider_invoice_id },
  });
  if (reservation.operation.status === "succeeded") {
    return await getCommercialOrder(order.id);
  }
  await setCommercialProviderOperationStatus({
    id: reservation.operation.id,
    status: "remote_started",
  });
  try {
    stripeInvoice = await stripe.invoices.retrieve(opts.provider_invoice_id, {
      expand: ["payments.data.payment.payment_intent"],
    } as any);
    await assertExistingStripeInvoiceCandidate({
      stripe,
      stripeInvoice,
      order,
      commercialInvoiceId: invoice.id,
    });
    const metadata = stripeInvoice.metadata ?? {};
    stripeInvoice = await stripe.invoices.update(
      stripeInvoice.id,
      {
        metadata: {
          ...metadata,
          flow: FLOW,
          commercial_order_id: order.id,
          commercial_invoice_id: invoice.id,
          order_number: order.order_number,
          cocalc_site: await currentStripeSite(),
        },
      },
      { idempotencyKey: `${keyPrefix}:metadata` },
    );
    stripeInvoice = await stripe.invoices.retrieve(stripeInvoice.id, {
      expand: ["payments.data.payment.payment_intent"],
    } as any);
    const updated = await applyStripeInvoice({
      internalInvoice: invoice,
      stripeInvoice,
      event_type: "existing-invoice-linked",
      event_source: opts.source ?? "migration",
      event_reason: reason,
      event_idempotency_key: `${intentKey}:attached`,
      actor_account_id: opts.account_id,
    });
    await setCommercialProviderOperationStatus({
      id: reservation.operation.id,
      status: "succeeded",
      result: { provider_invoice_id: stripeInvoice.id },
    });
    return updated;
  } catch (err) {
    recordCommercialProviderFailure("invoice-link");
    await setCommercialProviderOperationStatus({
      id: reservation.operation.id,
      status: "indeterminate",
      error: err,
    });
    throw err;
  }
}

async function assertExistingStripeInvoiceCandidate(opts: {
  stripe: Awaited<ReturnType<typeof getConn>>;
  stripeInvoice: any;
  order: CommercialOrder;
  commercialInvoiceId?: string;
}): Promise<void> {
  assertStripeMode(opts.stripe, opts.stripeInvoice);
  const site = await currentStripeSite();
  const metadata = opts.stripeInvoice.metadata ?? {};
  if (
    metadata.flow !== FLOW ||
    metadata.commercial_order_id !== opts.order.id ||
    metadata.order_number !== opts.order.order_number ||
    metadata.cocalc_site !== site
  ) {
    throw Error(
      "Stripe invoice must be explicitly prepared for this commercial order before it can be linked",
    );
  }
  if (
    metadata.commercial_invoice_id &&
    metadata.commercial_invoice_id !== opts.commercialInvoiceId
  ) {
    throw Error("Stripe invoice is already linked to another local invoice");
  }
  const customerId = invoiceCustomerId(opts.stripeInvoice);
  if (!customerId) throw Error("Stripe invoice has no customer recipient");
  if (
    opts.order.stripe_customer_id &&
    customerId !== opts.order.stripe_customer_id
  ) {
    throw Error("Stripe invoice customer does not match the approved order");
  }
  assertCustomerMatchesOrder(
    await opts.stripe.customers.retrieve(customerId),
    opts.order,
    site,
  );
  const created = Number(opts.stripeInvoice.created);
  if (!Number.isFinite(created) || created <= 0) {
    throw Error("Stripe invoice does not have a valid creation date");
  }
  assertInvoiceDeliveryConfiguration(
    opts.stripeInvoice,
    opts.order,
    Math.floor(
      new Date(dueAt(opts.order, new Date(created * 1000))).getTime() / 1000,
    ),
    false,
  );
  await assertStripeInvoiceMatchesOrder(
    opts.stripeInvoice,
    opts.order,
    opts.stripe,
  );
}

async function assertStripeInvoiceMatchesOrder(
  stripeInvoice: any,
  order: CommercialOrder,
  stripe?: Awaited<ReturnType<typeof getConn>>,
) {
  const expectedCents = decimalToStripe(order.agreed_total);
  if (`${stripeInvoice.currency}`.toLowerCase() !== order.currency) {
    throw Error("Stripe draft currency no longer matches the approved order");
  }
  if (
    Number(stripeInvoice.total) !== expectedCents ||
    Number(stripeInvoice.subtotal) !== decimalToStripe(order.agreed_subtotal)
  ) {
    throw Error("Stripe draft total no longer matches the approved order");
  }
  const lines = await listStripeInvoiceLines(
    stripe ?? (await getConn()),
    stripeInvoice.id,
  );
  const expected = new Map(
    order.items.map((item) => [item.id, decimalToStripe(item.subtotal)]),
  );
  for (const line of lines) {
    const itemId = line.metadata?.commercial_order_item_id;
    const item = order.items.find(({ id }) => id === itemId);
    if (
      !itemId ||
      expected.get(itemId) !== line.amount ||
      `${line.currency ?? ""}`.toLowerCase() !== order.currency ||
      `${line.description ?? ""}` !== item?.description
    ) {
      throw Error("Stripe draft line items no longer match the approved order");
    }
    expected.delete(itemId);
  }
  if (expected.size) throw Error("Stripe draft is missing approved line items");
}

export async function sendStripeCommercialInvoice(
  opts: CommercialInvoiceMutationRequest,
): Promise<CommercialOrder> {
  const reason = requireReason(opts.reason);
  if (!opts.account_id || !opts.expected_version)
    throw Error("account_id and expected_version are required");
  const order = await getCommercialOrder(opts.id);
  const invoice = await getCommercialInvoice(
    order.id,
    opts.commercial_invoice_id,
  );
  const key = commercialIdempotencyKey("invoice-send", opts as any);
  const reservation = await reserveCommercialProviderOperation({
    order_id: order.id,
    invoice_id: invoice.id,
    operation: "send-invoice",
    expected_version: opts.expected_version,
    idempotency_key: key,
    request: { provider_invoice_id: invoice.provider_invoice_id },
  });
  if (reservation.operation.status === "succeeded")
    return await getCommercialOrder(order.id);
  const stripe = await getConn();
  let latest = await retrieveStripeInvoice(stripe, invoice);
  assertStripeMode(stripe, latest);
  await assertInvoiceDeliveryMatchesOrder({
    stripe,
    stripeInvoice: latest,
    internalInvoice: invoice,
    order,
  });
  await assertStripeInvoiceMatchesOrder(latest, order, stripe);
  if (!["draft", "open", "paid"].includes(latest.status)) {
    throw Error(`Stripe invoice cannot be sent from status ${latest.status}`);
  }
  await setCommercialProviderOperationStatus({
    id: reservation.operation.id,
    status: "remote_started",
  });
  try {
    if (latest.status === "draft") {
      latest = await stripe.invoices.finalizeInvoice(
        latest.id,
        {
          auto_advance: false,
          expand: ["payments.data.payment.payment_intent"],
        } as any,
        { idempotencyKey: `${key}:finalize` },
      );
      await assertInvoiceDeliveryMatchesOrder({
        stripe,
        stripeInvoice: latest,
        internalInvoice: invoice,
        order,
      });
      // Finalization can recalculate tax; never deliver an unreviewed total.
      await assertStripeInvoiceMatchesOrder(latest, order, stripe);
    }
    if (latest.status === "open" && !latest.hosted_invoice_url) {
      latest = await stripe.invoices.sendInvoice(
        latest.id,
        { expand: ["payments.data.payment.payment_intent"] } as any,
        { idempotencyKey: `${key}:send` },
      );
    } else if (latest.status === "open") {
      // sendInvoice is idempotent and ensures Stripe's delivery transition ran.
      latest = await stripe.invoices.sendInvoice(
        latest.id,
        {},
        { idempotencyKey: `${key}:send` },
      );
    }
    await assertInvoiceDeliveryMatchesOrder({
      stripe,
      stripeInvoice: latest,
      internalInvoice: invoice,
      order,
    });
    const updated = await applyStripeInvoice({
      internalInvoice: invoice,
      stripeInvoice: latest,
      event_type: "invoice-sent",
      event_source: opts.source ?? "cli",
      event_reason: reason,
      event_idempotency_key: `${key}:local`,
      actor_account_id: opts.account_id,
    });
    await setCommercialProviderOperationStatus({
      id: reservation.operation.id,
      status: "succeeded",
      result: { provider_invoice_id: latest.id, status: latest.status },
    });
    return updated;
  } catch (err) {
    recordCommercialProviderFailure("invoice-send");
    await setCommercialProviderOperationStatus({
      id: reservation.operation.id,
      status: "indeterminate",
      error: err,
    });
    throw err;
  }
}

export async function voidStripeCommercialInvoice(
  opts: CommercialInvoiceMutationRequest,
): Promise<CommercialOrder> {
  const reason = requireReason(opts.reason);
  if (!opts.account_id || !opts.expected_version)
    throw Error("account_id and expected_version are required");
  const order = await getCommercialOrder(opts.id);
  const invoice = await getCommercialInvoice(
    order.id,
    opts.commercial_invoice_id,
  );
  const key = commercialIdempotencyKey("invoice-void", opts as any);
  const reservation = await reserveCommercialProviderOperation({
    order_id: order.id,
    invoice_id: invoice.id,
    operation: "void-invoice",
    expected_version: opts.expected_version,
    idempotency_key: key,
  });
  if (reservation.operation.status === "succeeded")
    return await getCommercialOrder(order.id);
  try {
    const stripe = await getConn();
    const deletedDraft = reservation.operation.result.deleted === true;
    let latest: any;
    if (deletedDraft) {
      latest = {
        id: invoice.provider_invoice_id,
        status: "void",
        metadata: invoice.provider_snapshot.metadata,
        currency: invoice.currency,
        subtotal: decimalToStripe(invoice.subtotal),
        total: decimalToStripe(invoice.total),
        amount_due: 0,
        amount_remaining: 0,
        amount_paid: 0,
        customer: invoice.provider_customer_id,
        livemode: (invoice.provider_snapshot as any).livemode,
        status_transitions: {
          voided_at:
            Number(reservation.operation.result.deleted_at) ||
            Math.floor(Date.now() / 1000),
        },
      };
    } else if (!invoice.provider_invoice_id) {
      latest = await findStripeInvoiceByMetadata(stripe, invoice.id);
      if (!latest) {
        const abandoned = await updateCommercialInvoiceProvider({
          invoice_id: invoice.id,
          status: "failed",
          provider_customer_id: invoice.provider_customer_id,
          subtotal: invoice.subtotal,
          tax: invoice.tax,
          total: invoice.total,
          amount_due: "0",
          amount_paid: invoice.amount_paid,
          due_at: invoice.due_at,
          provider_snapshot: {
            ...invoice.provider_snapshot,
            abandoned_without_remote_invoice: true,
          },
          collection_state: "void",
          event_type: "invoice-intent-abandoned",
          event_source: opts.source ?? "cli",
          event_reason: reason,
          event_idempotency_key: `${key}:local-abandoned`,
          actor_account_id: opts.account_id,
          error: "no Stripe invoice exists for the local intent",
        });
        await setCommercialProviderOperationStatus({
          id: reservation.operation.id,
          status: "succeeded",
          result: { abandoned_without_remote_invoice: true },
        });
        return abandoned;
      }
    } else {
      latest = await retrieveStripeInvoice(stripe, invoice);
    }
    await setCommercialProviderOperationStatus({
      id: reservation.operation.id,
      status: "remote_started",
    });
    if (latest.status === "draft") {
      const providerDraft = latest;
      await stripe.invoices.del(
        latest.id,
        {},
        { idempotencyKey: `${key}:delete-draft` },
      );
      latest = {
        ...providerDraft,
        id: invoice.provider_invoice_id,
        status: "void",
        metadata: invoice.provider_snapshot.metadata,
        currency: invoice.currency,
        subtotal: decimalToStripe(invoice.subtotal),
        total: decimalToStripe(invoice.total),
        amount_due: 0,
        amount_remaining: 0,
        amount_paid: 0,
        customer: invoice.provider_customer_id,
        livemode: (invoice.provider_snapshot as any).livemode,
        status_transitions: { voided_at: Math.floor(Date.now() / 1000) },
      };
      await setCommercialProviderOperationStatus({
        id: reservation.operation.id,
        status: "remote_started",
        result: {
          deleted: true,
          provider_invoice_id: invoice.provider_invoice_id,
          deleted_at: latest.status_transitions.voided_at,
        },
      });
    } else if (latest.status === "open") {
      latest = await stripe.invoices.voidInvoice(
        latest.id,
        {},
        { idempotencyKey: `${key}:void` },
      );
    } else if (latest.status !== "void") {
      throw Error(
        `Stripe invoice cannot be voided from status ${latest.status}`,
      );
    }
    const updated = await applyStripeInvoice({
      internalInvoice: invoice,
      stripeInvoice: latest,
      event_type: "invoice-voided",
      event_source: opts.source ?? "cli",
      event_reason: reason,
      event_idempotency_key: `${key}:local`,
      actor_account_id: opts.account_id,
    });
    await setCommercialProviderOperationStatus({
      id: reservation.operation.id,
      status: "succeeded",
    });
    return updated;
  } catch (err) {
    recordCommercialProviderFailure("invoice-void");
    await setCommercialProviderOperationStatus({
      id: reservation.operation.id,
      status: "indeterminate",
      error: err,
    });
    throw err;
  }
}

export async function reconcileStripeCommercialInvoice(
  opts: CommercialInvoiceMutationRequest & {
    event_source?: CommercialEventSource;
    event_idempotency_key?: string;
  },
): Promise<CommercialOrder> {
  const reason = requireReason(opts.reason);
  const order = await getCommercialOrder(opts.id);
  const invoice = await getCommercialInvoice(
    order.id,
    opts.commercial_invoice_id,
  );
  const stripe = await getConn();
  const latest = await retrieveStripeInvoice(stripe, invoice);
  return await applyStripeInvoice({
    internalInvoice: invoice,
    stripeInvoice: latest,
    event_type: "invoice-reconciled",
    event_source: opts.event_source ?? opts.source ?? "reconciler",
    event_reason: reason,
    event_idempotency_key:
      opts.event_idempotency_key ??
      commercialIdempotencyKey("invoice-reconcile", opts as any),
    actor_account_id: opts.account_id,
    skip_if_unchanged: true,
  });
}

export async function recordStripeAwareCommercialManualPayment(
  opts: CommercialManualPaymentRequest,
): Promise<CommercialOrder> {
  const reason = requireReason(opts.reason);
  if (!opts.account_id || !opts.expected_version) {
    throw Error("account_id and expected_version are required");
  }
  let order = await getCommercialOrder(opts.id);
  const amount = normalizePositiveMoney(opts.amount, "payment amount");
  const currency = normalizeCurrency(opts.currency);
  const key = commercialIdempotencyKey(
    "manual-settlement-provider",
    opts as any,
  );
  const manualPaymentKey = `${key}:manual-evidence`;
  const replayPayment = order.payments.find(
    ({ provider, idempotency_key }) =>
      provider === "manual" && idempotency_key === manualPaymentKey,
  );
  if (replayPayment) {
    if (
      moneyCompare(replayPayment.amount, amount) !== 0 ||
      replayPayment.currency !== currency ||
      replayPayment.method !== opts.method ||
      replayPayment.evidence_reference !== opts.evidence_reference
    ) {
      throw Error(
        "manual payment idempotency key was reused with different evidence",
      );
    }
    return order;
  }
  const invoice = opts.commercial_invoice_id
    ? order.invoices.find(({ id }) => id === opts.commercial_invoice_id)
    : order.invoices[0];
  if (!invoice || !invoice.provider_invoice_id) {
    return await recordManualCommercialPayment(opts);
  }
  if (currency !== order.currency) {
    throw Error("payment currency does not match the order");
  }
  const paid = order.payments
    .filter(({ status }) => status === "succeeded")
    .reduce((sum, payment) => moneyAdd(sum, payment.amount), toDecimal(0));
  const remaining = moneySubtract(order.agreed_total, paid);
  if (moneyCompare(amount, remaining) !== 0) {
    throw Error(
      `an out-of-band Stripe invoice settlement must equal the remaining balance ${moneyToDbString(remaining)}`,
    );
  }
  if (invoice.status === "draft" || invoice.status === "creating") {
    throw Error(
      "void the Stripe draft before recording an out-of-band manual settlement",
    );
  }
  if (["void", "uncollectible", "failed"].includes(invoice.status)) {
    return await recordManualCommercialPayment(opts);
  }
  const reservation = await reserveCommercialProviderOperation({
    order_id: order.id,
    invoice_id: invoice.id,
    operation: "mark-invoice-paid-out-of-band",
    expected_version: opts.expected_version,
    idempotency_key: key,
    request: {
      provider_invoice_id: invoice.provider_invoice_id,
      amount: opts.amount,
      currency: opts.currency,
      method: opts.method,
    },
  });
  if (reservation.operation.status !== "succeeded") {
    await setCommercialProviderOperationStatus({
      id: reservation.operation.id,
      status: "remote_started",
    });
    try {
      const stripe = await getConn();
      let latest = await retrieveStripeInvoice(stripe, invoice);
      assertStripeMode(stripe, latest);
      await assertStripeIdentity(latest, invoice);
      if (latest.status === "open") {
        latest = await stripe.invoices.pay(
          latest.id,
          { paid_out_of_band: true },
          { idempotencyKey: `${key}:pay-out-of-band` },
        );
      }
      if (latest.status !== "paid") {
        throw Error(
          `Stripe invoice cannot be manually settled from status ${latest.status}`,
        );
      }
      order = await applyStripeInvoice({
        internalInvoice: invoice,
        stripeInvoice: latest,
        event_type: "invoice-paid-out-of-band",
        event_source: opts.source ?? "cli",
        event_reason: reason,
        event_idempotency_key: `${key}:provider-local`,
        actor_account_id: opts.account_id,
        include_provider_payments: false,
      });
      await setCommercialProviderOperationStatus({
        id: reservation.operation.id,
        status: "succeeded",
        result: {
          provider_invoice_id: latest.id,
          status: latest.status,
        },
      });
    } catch (err) {
      recordCommercialProviderFailure("manual-settlement-provider");
      await setCommercialProviderOperationStatus({
        id: reservation.operation.id,
        status: "indeterminate",
        error: err,
      });
      throw err;
    }
  } else {
    order = await getCommercialOrder(order.id);
  }
  return await recordManualCommercialPayment({
    ...opts,
    expected_version: order.version,
    idempotency_key: manualPaymentKey,
  });
}

function commercialMetadata(object: any): Record<string, string> {
  return object?.metadata ?? object?.parent?.invoice_details?.metadata ?? {};
}

export async function acceptCommercialStripeWebhookEvent(
  event: any,
): Promise<boolean> {
  const metadata = commercialMetadata(event?.data?.object);
  const quoteFlow =
    metadata.flow === "commercial_quote" && !!metadata.commercial_quote_id;
  const invoiceFlow = metadata.flow === FLOW;
  if (!invoiceFlow && !quoteFlow) return false;
  const site = await currentStripeSite();
  if (metadata.cocalc_site !== site) return false;
  const object = event?.data?.object;
  const isQuote = `${object?.object}` === "quote";
  const payload = {
    event_id: `${event.id}`,
    event_type: `${event.type}`,
    livemode: event.livemode === true,
    commercial_order_id: metadata.commercial_order_id,
    commercial_quote_id: quoteFlow ? metadata.commercial_quote_id : undefined,
    commercial_invoice_id: invoiceFlow
      ? metadata.commercial_invoice_id
      : undefined,
    provider_quote_id: isQuote ? object.id : undefined,
    provider_invoice_id:
      `${object?.object}` === "invoice" ? object.id : object?.invoice,
    created: event.created,
  };
  if (getConfiguredBayId() !== getConfiguredClusterSeedBayId()) {
    await getInterBayBridge()
      .bayOps(getConfiguredClusterSeedBayId(), { timeout_ms: 30_000 })
      .commercialOrders({
        action: "stripeWebhook",
        actor_account_id: "00000000-0000-0000-0000-000000000000",
        payload,
      });
    return true;
  }
  const { enqueueCommercialStripeEvent } = await import("../reconcile");
  await enqueueCommercialStripeEvent(payload);
  return true;
}

export { normalizeInvoiceRow };
