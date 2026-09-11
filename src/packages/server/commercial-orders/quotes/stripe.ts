/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createHash } from "node:crypto";

import { getLogger } from "@cocalc/backend/logger";
import type {
  CommercialStripeQuoteAcceptRequest,
  CommercialStripeQuoteCreateRequest,
  CommercialStripeQuoteMutationRequest,
  CommercialStripeQuotePreview,
  CommercialStripeQuotePreviewRequest,
} from "@cocalc/conat/hub/api/commercial-orders";
import { currentStripeSite } from "@cocalc/server/purchases/stripe/util";
import getConn from "@cocalc/server/stripe/connection";
import type {
  CommercialOrder,
  CommercialEventSource,
  CommercialOrderItem,
  CommercialQuote,
} from "@cocalc/util/commercial-orders";
import {
  moneyCompare,
  moneySubtract,
  moneyToDbString,
  stripeToMoney,
} from "@cocalc/util/money";
import { decimalToStripe } from "@cocalc/util/stripe/calc";
import {
  approvedInvoiceTerms,
  customFields,
  findExistingCommercialStripeCustomer,
  resolveCommercialStripeCustomer,
} from "../invoices/stripe";
import { recordCommercialProviderFailure } from "../observability";
import {
  buildCommercialQuotePreview,
  commercialIdempotencyKey,
  completeCommercialQuoteAcceptance,
  createCommercialInvoiceIntent,
  createCommercialStripeQuoteIntent,
  getCommercialOrder,
  getCommercialQuote,
  reserveCommercialProviderOperation,
  setCommercialProviderOperationStatus,
  updateCommercialQuoteProvider,
  quoteValidUntil,
} from "../store";
import { requireReason } from "../state";
import {
  commercialTaxPolicy,
  assertCommercialAutomaticTax,
  assertCommercialInvoiceLineTax,
} from "../tax";

const logger = getLogger("server:commercial-orders:stripe-quotes");
const FLOW = "commercial_quote";
const MAX_PDF_BYTES = 2_097_152;
const PAYMENT_METHOD_TYPES = ["card", "us_bank_account"] as const;

type StripeConnection = Awaited<ReturnType<typeof getConn>>;

type ReviewedQuoteProduct = {
  commercial_order_item_id: string;
  provider_product_id: string;
  description: string;
  quantity: number;
  unit_amount: number;
  subtotal: number;
};

const PRODUCT_NAMES: Record<string, string> = {
  site_license: "CoCalc Site License",
  professional_service: "CoCalc Professional Services",
  support: "CoCalc Support",
  training: "CoCalc Training",
  custom: "CoCalc Commercial Agreement",
};

function stripeMode(stripe: StripeConnection): "test" | "live" {
  return stripe.publishable_key.startsWith("pk_live_") ? "live" : "test";
}

function assertStripeMode(stripe: StripeConnection, object: any): void {
  if (object?.livemode !== (stripeMode(stripe) === "live")) {
    throw Error("Stripe quote mode does not match configured Stripe keys");
  }
}

function stripeId(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value) {
    return `${(value as { id?: unknown }).id ?? ""}` || undefined;
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

function quoteText(order: CommercialOrder): {
  description: string;
  header: string;
  footer: string;
} {
  const value = order.terms_snapshot.quote;
  const quote =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const text = (key: string): string =>
    typeof quote[key] === "string" ? quote[key].trim() : "";
  return {
    description:
      text("memo") ||
      approvedInvoiceTerms(order).memo ||
      `${order.organization_name}: ${order.order_number}`,
    header: text("header") || "CoCalc Commercial Quote",
    footer: text("footer"),
  };
}

type ReviewedQuoteText = ReturnType<typeof quoteText>;

function reviewedQuoteText(
  order: CommercialOrder,
  quote: CommercialQuote,
): ReviewedQuoteText {
  const value = quote.provider_snapshot.reviewed_text;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const text = value as Record<string, unknown>;
    if (
      typeof text.description === "string" &&
      typeof text.header === "string" &&
      typeof text.footer === "string"
    ) {
      return {
        description: text.description,
        header: text.header,
        footer: text.footer,
      };
    }
  }
  return quoteText(order);
}

function explicitProductId(item: CommercialOrderItem): string | undefined {
  const value = item.product_reference?.trim();
  return value && /^prod_[A-Za-z0-9]+$/.test(value) ? value : undefined;
}

function itemProductBlocker(item: CommercialOrderItem): string | undefined {
  if (explicitProductId(item)) return;
  if (!PRODUCT_NAMES[item.product_kind]) {
    return `line item ${item.description} needs a supported product_kind or a Stripe prod_ product_reference`;
  }
}

function quoteProductPreview(
  item: CommercialOrderItem,
): CommercialStripeQuotePreview["products"][number] {
  const quantity = Number(item.quantity);
  return {
    commercial_order_item_id: item.id,
    product_kind: item.product_kind,
    provider_product_id: explicitProductId(item),
    quantity,
    unit_amount: decimalToStripe(item.unit_amount),
  };
}

async function quotePreviewForOrder(
  order: CommercialOrder,
  validUntil?: string,
  ignoreActiveQuoteId?: string,
): Promise<CommercialStripeQuotePreview> {
  const base = buildCommercialQuotePreview(order);
  const blockers = [...base.blockers];
  const text = quoteText(order);
  if (text.description.length > 500) {
    blockers.push(
      "the Stripe quote description must be at most 500 characters",
    );
  }
  if (text.header.length > 50) {
    blockers.push("the Stripe quote header must be at most 50 characters");
  }
  if (text.footer.length > 500) {
    blockers.push("the Stripe quote footer must be at most 500 characters");
  }
  if (
    !commercialTaxPolicy(order.terms_snapshot).enabled &&
    moneyCompare(order.agreed_subtotal, order.agreed_total) !== 0
  ) {
    blockers.push(
      "agreed_total must equal agreed_subtotal unless reviewed automatic tax is enabled",
    );
  }
  for (const item of order.items) {
    const quantity = Number(item.quantity);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      blockers.push(
        `line item ${item.description} quantity must be a positive integer for Stripe Quotes`,
      );
    }
    try {
      if (!Number.isSafeInteger(decimalToStripe(item.unit_amount))) {
        throw Error();
      }
    } catch {
      blockers.push(
        `line item ${item.description} unit amount must convert exactly to currency minor units`,
      );
    }
    const productBlocker = itemProductBlocker(item);
    if (productBlocker) blockers.push(productBlocker);
  }
  if (
    order.quotes.some(
      ({ id, provider, status }) =>
        id !== ignoreActiveQuoteId &&
        provider === "stripe" &&
        ["draft", "issued"].includes(status),
    )
  ) {
    blockers.push("the order already has an active Stripe quote");
  }
  try {
    quoteValidUntil(validUntil, base.default_valid_until);
  } catch (err) {
    blockers.push(`${err}`.replace(/^Error:\s*/, ""));
  }
  const stripe = await getConn();
  const site = await currentStripeSite();
  let customerId = order.stripe_customer_id;
  try {
    customerId =
      (await findExistingCommercialStripeCustomer({
        stripe,
        order,
        providerCustomerId: customerId,
        site,
      })) ?? null;
  } catch (err) {
    blockers.push(`${err}`.replace(/^Error:\s*/, ""));
  }
  const paymentTermsDays = Math.max(order.payment_terms_days ?? 21, 0);
  if (!Number.isSafeInteger(paymentTermsDays) || paymentTermsDays > 365) {
    blockers.push("payment_terms_days must be an integer from 0 through 365");
  }
  return {
    ...base,
    automatic_tax: commercialTaxPolicy(order.terms_snapshot).enabled,
    tax_code: commercialTaxPolicy(order.terms_snapshot).taxCode,
    stripe_mode: stripeMode(stripe),
    stripe_customer_id: customerId,
    collection_method: "send_invoice",
    payment_terms_days: paymentTermsDays,
    description: text.description,
    header: text.header,
    footer: text.footer,
    metadata: {
      flow: FLOW,
      commercial_order_id: order.id,
      order_number: order.order_number,
      cocalc_site: site,
    },
    products: order.items.map(quoteProductPreview),
    ready: blockers.length === 0,
    blockers,
  };
}

export async function commercialStripeQuotePreview(
  opts: CommercialStripeQuotePreviewRequest,
): Promise<CommercialStripeQuotePreview> {
  requireReason(opts.reason);
  return await quotePreviewForOrder(
    await getCommercialOrder(opts.id),
    opts.valid_until,
  );
}

function assertProductMode(stripe: StripeConnection, product: any): void {
  assertStripeMode(stripe, product);
  if (!product || product.deleted || product.active === false) {
    throw Error("the selected Stripe product is not active");
  }
}

function assertProductDescription(product: any, description: string): void {
  if (`${product?.name ?? ""}` !== description) {
    throw Error(
      "the Stripe product name must exactly match the reviewed line-item description",
    );
  }
}

async function resolveProduct(opts: {
  stripe: StripeConnection;
  item: CommercialOrderItem;
  site: string;
  taxCode?: string;
}): Promise<string> {
  const explicit = explicitProductId(opts.item);
  if (explicit) {
    const product = await opts.stripe.products.retrieve(explicit);
    assertProductMode(opts.stripe, product);
    assertProductDescription(product, opts.item.description);
    if (opts.taxCode && stripeId(product.tax_code) !== opts.taxCode) {
      throw Error("Stripe product tax code does not match reviewed terms");
    }
    return explicit;
  }
  if (!PRODUCT_NAMES[opts.item.product_kind]) {
    throw Error(itemProductBlocker(opts.item));
  }
  const descriptionHash = createHash("sha256")
    .update(opts.item.description + (opts.taxCode ? `:${opts.taxCode}` : ""))
    .digest("hex");
  const query = [
    `metadata['flow']:'${FLOW}'`,
    `metadata['purpose']:'commercial_quote_line_product'`,
    `metadata['product_kind']:'${opts.item.product_kind}'`,
    `metadata['line_description_sha256']:'${descriptionHash}'`,
    `metadata['cocalc_site']:'${opts.site}'`,
  ].join(" AND ");
  const result = await opts.stripe.products.search({ query, limit: 10 } as any);
  const products = (result.data ?? []).filter(
    (product: any) => !product.deleted && product.active !== false,
  );
  if (products.length > 1) {
    throw Error(`multiple Stripe products match ${opts.item.product_kind}`);
  }
  if (products[0]) {
    assertProductMode(opts.stripe, products[0]);
    assertProductDescription(products[0], opts.item.description);
    if (opts.taxCode && stripeId(products[0].tax_code) !== opts.taxCode) {
      throw Error("Stripe product tax code does not match reviewed terms");
    }
    return products[0].id;
  }
  const product = await opts.stripe.products.create(
    {
      // Stripe Quote line descriptions are derived from the Product name.
      name: opts.item.description,
      ...(opts.taxCode ? { tax_code: opts.taxCode } : {}),
      metadata: {
        flow: FLOW,
        purpose: "commercial_quote_line_product",
        product_kind: opts.item.product_kind,
        line_description_sha256: descriptionHash,
        cocalc_site: opts.site,
      },
    },
    {
      idempotencyKey: `cocalc:${opts.site}:commercial-quote-line-product:${opts.item.product_kind}:${descriptionHash}:v1`,
    },
  );
  assertProductMode(opts.stripe, product);
  assertProductDescription(product, opts.item.description);
  return product.id;
}

function quoteCustomerId(quote: any): string | undefined {
  return stripeId(quote?.customer);
}

function quoteInvoiceId(quote: any): string | undefined {
  return stripeId(quote?.invoice);
}

function quoteProviderSnapshot(
  quote: any,
  lines: any[] = [],
  products: ReviewedQuoteProduct[] = [],
  reviewedText?: ReviewedQuoteText,
): Record<string, unknown> {
  return {
    id: quote?.id,
    object: quote?.object,
    livemode: quote?.livemode,
    status: quote?.status,
    number: quote?.number,
    currency: quote?.currency,
    customer: quoteCustomerId(quote),
    invoice: quoteInvoiceId(quote),
    amount_subtotal: quote?.amount_subtotal,
    amount_total: quote?.amount_total,
    collection_method: quote?.collection_method,
    invoice_settings: quote?.invoice_settings,
    expires_at: quote?.expires_at,
    created: quote?.created,
    description: quote?.description,
    header: quote?.header,
    footer: quote?.footer,
    automatic_tax: quote?.automatic_tax,
    metadata: quote?.metadata,
    reviewed_text: reviewedText,
    products,
    lines: lines.slice(0, 100).map((line) => ({
      id: line?.id,
      product: stripeId(line?.price?.product),
      description: line?.description,
      quantity: line?.quantity,
      unit_amount: line?.price?.unit_amount,
      amount_subtotal: line?.amount_subtotal,
      amount_total: line?.amount_total,
    })),
  };
}

async function listQuoteLines(
  stripe: StripeConnection,
  quoteId: string,
): Promise<any[]> {
  const result = await stripe.quotes.listLineItems(quoteId, {
    limit: 100,
    expand: ["data.price.product"],
  } as any);
  if (result.has_more) {
    throw Error("Stripe quote has more than 100 line items");
  }
  return result.data ?? [];
}

function lineSignature(value: {
  product: string;
  description: string;
  quantity: number;
  unit_amount: number;
  subtotal: number;
}): string {
  return `${value.product}\0${value.description}\0${value.quantity}\0${value.unit_amount}\0${value.subtotal}`;
}

function reviewedPaymentTermsDays(
  order: CommercialOrder,
  quote: CommercialQuote,
): number {
  const value = quote.snapshot.payment_terms_days;
  return Number.isSafeInteger(value)
    ? Number(value)
    : Math.max(order.payment_terms_days ?? 21, 0);
}

async function assertQuoteMatchesOrder(opts: {
  stripe: StripeConnection;
  quote: any;
  localQuote: CommercialQuote;
  order: CommercialOrder;
  customerId: string;
  products: ReviewedQuoteProduct[];
}): Promise<any[]> {
  assertStripeMode(opts.stripe, opts.quote);
  const site = await currentStripeSite();
  const metadata = opts.quote?.metadata ?? {};
  if (
    metadata.flow !== FLOW ||
    metadata.commercial_order_id !== opts.order.id ||
    metadata.commercial_quote_id !== opts.localQuote.id ||
    metadata.order_number !== opts.order.order_number ||
    metadata.cocalc_site !== site
  ) {
    throw Error("Stripe quote metadata does not match the commercial quote");
  }
  if (
    `${opts.quote?.currency ?? ""}`.toLowerCase() !==
      opts.localQuote.currency ||
    Number(opts.quote?.amount_subtotal) !==
      decimalToStripe(opts.localQuote.subtotal) ||
    Number(opts.quote?.amount_total) !== decimalToStripe(opts.localQuote.total)
  ) {
    throw Error("Stripe quote totals do not match the commercial quote");
  }
  if (
    quoteCustomerId(opts.quote) !== opts.customerId ||
    opts.quote?.collection_method !== "send_invoice"
  ) {
    throw Error(
      "Stripe quote delivery or customer does not match reviewed terms",
    );
  }
  assertCommercialAutomaticTax(opts.quote, opts.order);
  const expectedExpiresAt = Math.floor(
    new Date(opts.localQuote.valid_until).getTime() / 1000,
  );
  if (Number(opts.quote?.expires_at) !== expectedExpiresAt) {
    throw Error("Stripe quote expiration does not match reviewed terms");
  }
  if (
    Number(opts.quote?.invoice_settings?.days_until_due) !==
    reviewedPaymentTermsDays(opts.order, opts.localQuote)
  ) {
    throw Error(
      "Stripe quote payment-term settings do not match reviewed terms",
    );
  }
  const expectedText = reviewedQuoteText(opts.order, opts.localQuote);
  if (
    `${opts.quote?.description ?? ""}` !== expectedText.description ||
    `${opts.quote?.header ?? ""}` !== expectedText.header ||
    `${opts.quote?.footer ?? ""}` !== expectedText.footer
  ) {
    throw Error("Stripe quote text does not match reviewed terms");
  }
  const lines = await listQuoteLines(opts.stripe, opts.quote.id);
  const expected = new Map<string, number>();
  for (const product of opts.products) {
    const signature = lineSignature({
      product: product.provider_product_id,
      description: product.description,
      quantity: product.quantity,
      unit_amount: product.unit_amount,
      subtotal: product.subtotal,
    });
    expected.set(signature, (expected.get(signature) ?? 0) + 1);
  }
  for (const line of lines) {
    const taxPolicy = commercialTaxPolicy(opts.order.terms_snapshot);
    if (
      taxPolicy.enabled &&
      (line?.price?.tax_behavior !== "exclusive" ||
        stripeId(line?.price?.product?.tax_code) !== taxPolicy.taxCode)
    ) {
      throw Error("Stripe quote line tax settings do not match reviewed terms");
    }
    const signature = lineSignature({
      product: stripeId(line?.price?.product) ?? "",
      description: `${line?.description ?? ""}`,
      quantity: Number(line?.quantity),
      unit_amount: Number(line?.price?.unit_amount),
      subtotal: Number(line?.amount_subtotal),
    });
    const count = expected.get(signature) ?? 0;
    if (!count)
      throw Error("Stripe quote line items do not match reviewed terms");
    if (count === 1) expected.delete(signature);
    else expected.set(signature, count - 1);
  }
  if (expected.size) {
    throw Error("Stripe quote is missing reviewed line items");
  }
  return lines;
}

async function findStripeQuoteByMetadata(opts: {
  stripe: StripeConnection;
  localQuote: CommercialQuote;
  customerId: string;
}): Promise<any | undefined> {
  const result = await opts.stripe.quotes.list({
    customer: opts.customerId,
    limit: 100,
  } as any);
  const matches = (result.data ?? []).filter(
    (quote: any) =>
      quote?.metadata?.flow === FLOW &&
      quote?.metadata?.commercial_quote_id === opts.localQuote.id,
  );
  if (matches.length > 1) {
    throw Error(`multiple Stripe quotes reference ${opts.localQuote.id}`);
  }
  if (!matches.length && result.has_more) {
    throw Error("Stripe quote recovery exceeded the bounded customer search");
  }
  return matches[0];
}

async function resolveProducts(opts: {
  stripe: StripeConnection;
  order: CommercialOrder;
  site: string;
}): Promise<ReviewedQuoteProduct[]> {
  const products: ReviewedQuoteProduct[] = [];
  for (const item of opts.order.items) {
    products.push({
      commercial_order_item_id: item.id,
      provider_product_id: await resolveProduct({
        stripe: opts.stripe,
        item,
        site: opts.site,
        taxCode: commercialTaxPolicy(opts.order.terms_snapshot).taxCode,
      }),
      description: item.description,
      quantity: Number(item.quantity),
      unit_amount: decimalToStripe(item.unit_amount),
      subtotal: decimalToStripe(item.subtotal),
    });
  }
  return products;
}

function operationPrefix(site: string, quoteId: string): string {
  return `cocalc:${site}:commercial-quote:${quoteId}:v1`;
}

export async function createStripeCommercialQuote(
  opts: CommercialStripeQuoteCreateRequest,
): Promise<CommercialOrder> {
  const reason = requireReason(opts.reason);
  if (!opts.account_id || !opts.expected_version) {
    throw Error("account_id and expected_version are required");
  }
  const before = await getCommercialOrder(opts.id);
  const replay = before.quotes.find(
    ({ idempotency_key }) =>
      idempotency_key ===
      commercialIdempotencyKey("stripe-quote-create", opts as any),
  );
  if (replay?.provider_quote_id) return before;
  const preview = await quotePreviewForOrder(
    before,
    opts.valid_until,
    replay?.id,
  );
  if (!preview.ready) {
    throw Error(`Stripe quote is not ready: ${preview.blockers.join("; ")}`);
  }
  const { order, quote } = replay
    ? { order: before, quote: replay }
    : await createCommercialStripeQuoteIntent(opts);
  const stripe = await getConn();
  const site = await currentStripeSite();
  const keyPrefix = operationPrefix(site, quote.id);
  const reservation = await reserveCommercialProviderOperation({
    order_id: order.id,
    quote_id: quote.id,
    operation: "quote_create",
    expected_version: order.version,
    idempotency_key: `${keyPrefix}:operation:create`,
    request: { commercial_quote_id: quote.id },
  });
  if (reservation.operation.status === "succeeded") {
    return await getCommercialOrder(order.id);
  }
  await setCommercialProviderOperationStatus({
    id: reservation.operation.id,
    status: "remote_started",
  });
  try {
    const customerId = await resolveCommercialStripeCustomer({
      stripe,
      order,
      providerCustomerId: order.stripe_customer_id,
      keyPrefix,
    });
    const products = await resolveProducts({ stripe, order, site });
    let stripeQuote = quote.provider_quote_id
      ? await stripe.quotes.retrieve(quote.provider_quote_id)
      : await findStripeQuoteByMetadata({
          stripe,
          localQuote: quote,
          customerId,
        });
    if (!stripeQuote) {
      const expiresAt = Math.floor(
        new Date(quote.valid_until).getTime() / 1000,
      );
      stripeQuote = await stripe.quotes.create(
        {
          customer: customerId,
          collection_method: "send_invoice",
          invoice_settings: {
            days_until_due: preview.payment_terms_days,
          },
          expires_at: expiresAt,
          line_items: products.map((product) => ({
            quantity: product.quantity,
            price_data: {
              currency: preview.currency,
              product: product.provider_product_id,
              unit_amount: product.unit_amount,
              ...(commercialTaxPolicy(order.terms_snapshot).enabled
                ? { tax_behavior: "exclusive" as const }
                : {}),
            },
          })),
          automatic_tax: {
            enabled: commercialTaxPolicy(order.terms_snapshot).enabled,
          },
          description: preview.description,
          header: preview.header,
          // An explicit empty footer suppresses account-level Stripe defaults.
          footer: preview.footer,
          metadata: {
            ...preview.metadata,
            commercial_quote_id: quote.id,
            local_quote_number: quote.quote_number,
          },
        } as any,
        { idempotencyKey: `${keyPrefix}:quote` },
      );
    }
    const lines = await assertQuoteMatchesOrder({
      stripe,
      quote: stripeQuote,
      localQuote: quote,
      order,
      customerId,
      products,
    });
    if (stripeQuote.status !== "draft") {
      throw Error(`new Stripe quote is unexpectedly ${stripeQuote.status}`);
    }
    const updated = await updateCommercialQuoteProvider({
      quote_id: quote.id,
      status: "draft",
      provider_quote_id: stripeQuote.id,
      provider_status: "draft",
      provider_snapshot: quoteProviderSnapshot(stripeQuote, lines, products, {
        description: preview.description,
        header: preview.header,
        footer: preview.footer,
      }),
      actor_account_id: opts.account_id,
      event_type: "stripe-quote-draft-created",
      event_source: opts.source ?? "cli",
      event_reason: reason,
      event_idempotency_key: `${quote.idempotency_key}:provider-attached`,
    });
    await setCommercialProviderOperationStatus({
      id: reservation.operation.id,
      status: "succeeded",
      result: { provider_quote_id: stripeQuote.id },
    });
    return updated;
  } catch (err) {
    recordCommercialProviderFailure("quote-create");
    await setCommercialProviderOperationStatus({
      id: reservation.operation.id,
      status: "indeterminate",
      error: err,
    });
    throw err;
  }
}

async function readStripePdf(stream: any): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_PDF_BYTES) {
      if (typeof stream.destroy === "function") stream.destroy();
      throw Error("Stripe quote PDF exceeds the 2 MiB retention limit");
    }
    chunks.push(buffer);
  }
  const document = Buffer.concat(chunks);
  if (!document.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw Error("Stripe returned an invalid quote PDF");
  }
  return document;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function productsFromSnapshot(
  stripe: StripeConnection,
  quote: CommercialQuote,
  order: CommercialOrder,
): Promise<ReviewedQuoteProduct[]> {
  if (Array.isArray(quote.provider_snapshot.products)) {
    const snapshotItems = Array.isArray(quote.snapshot.items)
      ? quote.snapshot.items
      : order.items;
    const items = new Map<string, any>(
      snapshotItems
        .filter((item: any) => typeof item?.id === "string")
        .map((item: any) => [item.id, item]),
    );
    const products: ReviewedQuoteProduct[] = [];
    for (const product of quote.provider_snapshot.products as any[]) {
      if (
        typeof product?.commercial_order_item_id !== "string" ||
        typeof product?.provider_product_id !== "string" ||
        !Number.isSafeInteger(product?.quantity) ||
        !Number.isSafeInteger(product?.unit_amount)
      ) {
        continue;
      }
      const item = items.get(product.commercial_order_item_id);
      const description =
        typeof product.description === "string"
          ? product.description
          : item?.description;
      const subtotal = Number.isSafeInteger(product.subtotal)
        ? Number(product.subtotal)
        : item?.subtotal != null
          ? decimalToStripe(`${item.subtotal}`)
          : undefined;
      if (typeof description !== "string" || subtotal == null) continue;
      products.push({
        commercial_order_item_id: product.commercial_order_item_id,
        provider_product_id: product.provider_product_id,
        description,
        quantity: product.quantity,
        unit_amount: product.unit_amount,
        subtotal,
      });
    }
    if (products.length === snapshotItems.length) return products;
  }
  return await resolveProducts({
    stripe,
    order,
    site: await currentStripeSite(),
  });
}

export async function finalizeStripeCommercialQuote(
  opts: CommercialStripeQuoteMutationRequest,
): Promise<CommercialOrder> {
  const reason = requireReason(opts.reason);
  if (!opts.account_id || !opts.expected_version) {
    throw Error("account_id and expected_version are required");
  }
  const order = await getCommercialOrder(opts.id);
  const quote = await getCommercialQuote(order.id, opts.commercial_quote_id);
  if (quote.provider !== "stripe" || !quote.provider_quote_id) {
    throw Error("Stripe quote draft has not been created");
  }
  if (quote.status === "issued" && quote.document_sha256) return order;
  const stripe = await getConn();
  const site = await currentStripeSite();
  const keyPrefix = operationPrefix(site, quote.id);
  const reservation = await reserveCommercialProviderOperation({
    order_id: order.id,
    quote_id: quote.id,
    operation: "quote_finalize",
    expected_version: opts.expected_version,
    idempotency_key: `${keyPrefix}:operation:finalize`,
    request: { provider_quote_id: quote.provider_quote_id },
  });
  if (reservation.operation.status === "succeeded") {
    return await getCommercialOrder(order.id);
  }
  await setCommercialProviderOperationStatus({
    id: reservation.operation.id,
    status: "remote_started",
  });
  try {
    const customerId = quoteCustomerId(quote.provider_snapshot);
    const expectedCustomer =
      customerId ??
      (await findExistingCommercialStripeCustomer({
        stripe,
        order,
        providerCustomerId: order.stripe_customer_id,
      }));
    if (!expectedCustomer) throw Error("Stripe quote has no reviewed customer");
    const products = await productsFromSnapshot(stripe, quote, order);
    let stripeQuote = await stripe.quotes.retrieve(quote.provider_quote_id);
    await assertQuoteMatchesOrder({
      stripe,
      quote: stripeQuote,
      localQuote: quote,
      order,
      customerId: expectedCustomer,
      products,
    });
    if (stripeQuote.status === "draft") {
      stripeQuote = await stripe.quotes.finalizeQuote(
        stripeQuote.id,
        {},
        { idempotencyKey: `${keyPrefix}:finalize` },
      );
    }
    if (stripeQuote.status !== "open") {
      throw Error(
        `Stripe quote cannot be finalized from ${stripeQuote.status}`,
      );
    }
    const lines = await assertQuoteMatchesOrder({
      stripe,
      quote: stripeQuote,
      localQuote: quote,
      order,
      customerId: expectedCustomer,
      products,
    });
    const document = await readStripePdf(
      await stripe.quotes.pdf(stripeQuote.id),
    );
    const updated = await updateCommercialQuoteProvider({
      quote_id: quote.id,
      status: "issued",
      provider_quote_id: stripeQuote.id,
      provider_status: "open",
      provider_snapshot: quoteProviderSnapshot(
        stripeQuote,
        lines,
        products,
        reviewedQuoteText(order, quote),
      ),
      issued_at:
        timestamp(stripeQuote.status_transitions?.finalized_at) ??
        new Date().toISOString(),
      document_filename: `${stripeQuote.number ?? quote.quote_number}.pdf`,
      document_sha256: sha256(document),
      document_data: document,
      actor_account_id: opts.account_id,
      event_type: "stripe-quote-finalized",
      event_source: opts.source ?? "cli",
      event_reason: reason,
      event_idempotency_key: `${keyPrefix}:local:finalized`,
    });
    await setCommercialProviderOperationStatus({
      id: reservation.operation.id,
      status: "succeeded",
      result: { provider_quote_id: stripeQuote.id },
    });
    return updated;
  } catch (err) {
    recordCommercialProviderFailure("quote-finalize");
    await setCommercialProviderOperationStatus({
      id: reservation.operation.id,
      status: "indeterminate",
      error: err,
    });
    throw err;
  }
}

export async function cancelStripeCommercialQuote(
  opts: CommercialStripeQuoteMutationRequest,
): Promise<CommercialOrder> {
  const reason = requireReason(opts.reason);
  if (!opts.account_id || !opts.expected_version) {
    throw Error("account_id and expected_version are required");
  }
  const order = await getCommercialOrder(opts.id);
  const quote = await getCommercialQuote(order.id, opts.commercial_quote_id);
  if (quote.provider !== "stripe" || !quote.provider_quote_id) {
    throw Error("Stripe quote draft has not been created");
  }
  if (quote.status === "void" && quote.provider_status === "canceled") {
    return order;
  }
  if (quote.status === "accepted") {
    throw Error("an accepted Stripe quote cannot be canceled");
  }
  const stripe = await getConn();
  const site = await currentStripeSite();
  const keyPrefix = operationPrefix(site, quote.id);
  const reservation = await reserveCommercialProviderOperation({
    order_id: order.id,
    quote_id: quote.id,
    operation: "quote_cancel",
    expected_version: opts.expected_version,
    idempotency_key: `${keyPrefix}:operation:cancel`,
    request: { provider_quote_id: quote.provider_quote_id },
  });
  if (reservation.operation.status === "succeeded") {
    return await getCommercialOrder(order.id);
  }
  await setCommercialProviderOperationStatus({
    id: reservation.operation.id,
    status: "remote_started",
  });
  try {
    const customerId = quoteCustomerId(quote.provider_snapshot);
    const expectedCustomer =
      customerId ??
      (await findExistingCommercialStripeCustomer({
        stripe,
        order,
        providerCustomerId: order.stripe_customer_id,
      }));
    if (!expectedCustomer) throw Error("Stripe quote has no reviewed customer");
    const products = await productsFromSnapshot(stripe, quote, order);
    let stripeQuote = await stripe.quotes.retrieve(quote.provider_quote_id);
    await assertQuoteMatchesOrder({
      stripe,
      quote: stripeQuote,
      localQuote: quote,
      order,
      customerId: expectedCustomer,
      products,
    });
    if (!["draft", "open", "canceled"].includes(stripeQuote.status)) {
      throw Error(`Stripe quote cannot be canceled from ${stripeQuote.status}`);
    }
    if (stripeQuote.status !== "canceled") {
      stripeQuote = await stripe.quotes.cancel(
        stripeQuote.id,
        {},
        { idempotencyKey: `${keyPrefix}:cancel` },
      );
    }
    if (stripeQuote.status !== "canceled") {
      throw Error("Stripe did not cancel the quote");
    }
    const lines = await assertQuoteMatchesOrder({
      stripe,
      quote: stripeQuote,
      localQuote: quote,
      order,
      customerId: expectedCustomer,
      products,
    });
    const updated = await updateCommercialQuoteProvider({
      quote_id: quote.id,
      status: "void",
      provider_quote_id: stripeQuote.id,
      provider_status: "canceled",
      provider_snapshot: quoteProviderSnapshot(
        stripeQuote,
        lines,
        products,
        reviewedQuoteText(order, quote),
      ),
      actor_account_id: opts.account_id,
      event_type: "stripe-quote-canceled",
      event_source: opts.source ?? "cli",
      event_reason: reason,
      event_idempotency_key: `${keyPrefix}:local:canceled`,
    });
    await setCommercialProviderOperationStatus({
      id: reservation.operation.id,
      status: "succeeded",
      result: { provider_quote_id: stripeQuote.id },
    });
    return updated;
  } catch (err) {
    recordCommercialProviderFailure("quote-cancel");
    await setCommercialProviderOperationStatus({
      id: reservation.operation.id,
      status: "indeterminate",
      error: err,
    });
    throw err;
  }
}

function invoiceProviderSnapshot(invoice: any): Record<string, unknown> {
  return {
    id: invoice?.id,
    object: invoice?.object,
    livemode: invoice?.livemode,
    status: invoice?.status,
    currency: invoice?.currency,
    customer: stripeId(invoice?.customer),
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
    metadata: invoice?.metadata,
  };
}

function dueAt(order: CommercialOrder, from = new Date()): string {
  const date = new Date(from);
  date.setUTCDate(
    date.getUTCDate() + Math.max(order.payment_terms_days ?? 21, 0),
  );
  return date.toISOString();
}

async function normalizeAcceptedInvoice(opts: {
  stripe: StripeConnection;
  order: CommercialOrder;
  quoteId: string;
  invoiceId: string;
  providerInvoiceId: string;
  customerId: string;
  products: Array<{
    commercial_order_item_id: string;
    provider_product_id: string;
  }>;
  keyPrefix: string;
  expectedDueAt: string;
}): Promise<any> {
  let invoice = await opts.stripe.invoices.retrieve(opts.providerInvoiceId);
  assertStripeMode(opts.stripe, invoice);
  if (invoice.status !== "draft") {
    throw Error(
      `a quote acceptance must create a draft invoice, not ${invoice.status}`,
    );
  }
  if (stripeId(invoice.customer) !== opts.customerId) {
    throw Error("accepted quote invoice has an unexpected Stripe customer");
  }
  invoice = await opts.stripe.invoices.update(
    invoice.id,
    {
      auto_advance: false,
      collection_method: "send_invoice",
      due_date: Math.floor(new Date(opts.expectedDueAt).getTime() / 1000),
      custom_fields: customFields(opts.order),
      description:
        approvedInvoiceTerms(opts.order).memo ??
        `${opts.order.organization_name}: ${opts.order.order_number}`,
      automatic_tax: {
        enabled: commercialTaxPolicy(opts.order.terms_snapshot).enabled,
      },
      payment_settings: {
        payment_method_types: [...PAYMENT_METHOD_TYPES],
      },
      metadata: {
        ...(invoice.metadata ?? {}),
        flow: "commercial_order",
        commercial_order_id: opts.order.id,
        commercial_invoice_id: opts.invoiceId,
        accepted_commercial_quote_id: opts.quoteId,
        order_number: opts.order.order_number,
        cocalc_site: await currentStripeSite(),
      },
    } as any,
    { idempotencyKey: `${opts.keyPrefix}:invoice:normalize` },
  );
  const lineResult = await opts.stripe.invoices.listLineItems(invoice.id, {
    limit: 100,
  } as any);
  if (
    lineResult.has_more ||
    lineResult.data.length !== opts.order.items.length
  ) {
    throw Error(
      "accepted quote invoice line count does not match reviewed terms",
    );
  }
  const remaining = [...opts.order.items];
  for (const line of lineResult.data) {
    await assertCommercialInvoiceLineTax(opts.stripe, line, opts.order);
    const invoiceLine = line as any;
    const lineProductId =
      stripeId(invoiceLine?.price?.product) ??
      stripeId(invoiceLine?.pricing?.price_details?.product);
    const index = remaining.findIndex((item) => {
      const expectedProduct = opts.products.find(
        ({ commercial_order_item_id }) => commercial_order_item_id === item.id,
      )?.provider_product_id;
      return (
        expectedProduct === lineProductId &&
        Number(line.amount) === decimalToStripe(item.subtotal) &&
        Number(line.quantity ?? 1) === Number(item.quantity)
      );
    });
    if (index < 0) {
      throw Error("accepted quote invoice lines do not match reviewed terms");
    }
    const [item] = remaining.splice(index, 1);
    await opts.stripe.invoices.updateLineItem(
      invoice.id,
      line.id,
      {
        description: item.description,
        metadata: {
          commercial_order_item_id: item.id,
          product_kind: item.product_kind,
        },
      } as any,
      { idempotencyKey: `${opts.keyPrefix}:invoice-line:${item.id}` },
    );
  }
  invoice = await opts.stripe.invoices.retrieve(invoice.id, {
    expand: ["payments.data.payment.payment_intent"],
  } as any);
  if (
    invoice.status !== "draft" ||
    invoice.auto_advance !== false ||
    invoice.collection_method !== "send_invoice" ||
    `${invoice.currency ?? ""}`.toLowerCase() !== opts.order.currency ||
    stripeId(invoice.customer) !== opts.customerId ||
    Number(invoice.subtotal) !== decimalToStripe(opts.order.agreed_subtotal) ||
    Number(invoice.total) !== decimalToStripe(opts.order.agreed_total) ||
    Number(invoice.amount_due) !== decimalToStripe(opts.order.agreed_total) ||
    invoice.metadata?.flow !== "commercial_order" ||
    invoice.metadata?.commercial_order_id !== opts.order.id ||
    invoice.metadata?.commercial_invoice_id !== opts.invoiceId
  ) {
    throw Error("accepted quote invoice does not match the commercial order");
  }
  assertCommercialAutomaticTax(invoice, opts.order);
  return invoice;
}

async function acceptOrAdoptStripeQuote(opts: {
  order: CommercialOrder;
  quote: CommercialQuote;
  expectedVersion: number;
  actorAccountId?: string;
  source: CommercialEventSource;
  reason: string;
  allowRemoteAccept: boolean;
}): Promise<CommercialOrder> {
  if (!opts.order.approved_at || !opts.order.approved_by_account_id) {
    throw Error(
      "the commercial order must be approved before quote acceptance",
    );
  }
  if (!opts.quote.provider_quote_id) {
    throw Error("Stripe quote draft has not been created");
  }
  if (!opts.quote.document_sha256 && opts.allowRemoteAccept) {
    throw Error("Stripe quote must be finalized before acceptance");
  }
  const invoiceIntentKey = `commercial:stripe-quote:${opts.quote.id}:accepted-invoice:v1`;
  const existingInvoice = opts.order.invoices.find(
    ({ idempotency_key }) => idempotency_key === invoiceIntentKey,
  );
  if (
    opts.quote.status === "accepted" &&
    existingInvoice &&
    existingInvoice.status !== "creating"
  ) {
    return opts.order;
  }
  const expectedDueAt = existingInvoice?.due_at ?? dueAt(opts.order);
  const intent = existingInvoice
    ? { order: opts.order, invoice: existingInvoice }
    : await createCommercialInvoiceIntent({
        order_id: opts.order.id,
        actor_account_id:
          opts.actorAccountId ?? opts.quote.created_by_account_id,
        expected_version: opts.expectedVersion,
        reason: opts.reason,
        idempotency_key: invoiceIntentKey,
        due_at: expectedDueAt,
      });
  const stripe = await getConn();
  const site = await currentStripeSite();
  const keyPrefix = operationPrefix(site, opts.quote.id);
  const reservation = await reserveCommercialProviderOperation({
    order_id: opts.order.id,
    quote_id: opts.quote.id,
    invoice_id: intent.invoice.id,
    operation: "quote_accept",
    expected_version: intent.order.version,
    idempotency_key: `${keyPrefix}:operation:accept`,
    request: {
      provider_quote_id: opts.quote.provider_quote_id,
      commercial_invoice_id: intent.invoice.id,
    },
  });
  if (reservation.operation.status === "succeeded") {
    return await getCommercialOrder(opts.order.id);
  }
  await setCommercialProviderOperationStatus({
    id: reservation.operation.id,
    status: "remote_started",
  });
  try {
    let stripeQuote = await stripe.quotes.retrieve(
      opts.quote.provider_quote_id,
    );
    const customerId = quoteCustomerId(stripeQuote);
    if (!customerId) throw Error("Stripe quote has no customer");
    const products = await productsFromSnapshot(stripe, opts.quote, opts.order);
    await assertQuoteMatchesOrder({
      stripe,
      quote: stripeQuote,
      localQuote: opts.quote,
      order: opts.order,
      customerId,
      products,
    });
    if (stripeQuote.status === "open" && opts.allowRemoteAccept) {
      stripeQuote = await stripe.quotes.accept(
        stripeQuote.id,
        {},
        { idempotencyKey: `${keyPrefix}:accept` },
      );
    }
    if (stripeQuote.status !== "accepted") {
      throw Error(
        opts.allowRemoteAccept
          ? `Stripe quote cannot be accepted from ${stripeQuote.status}`
          : `Stripe quote is ${stripeQuote.status}, not accepted`,
      );
    }
    const providerInvoiceId = quoteInvoiceId(stripeQuote);
    if (!providerInvoiceId) {
      throw Error("accepted Stripe quote did not create an invoice");
    }
    const lines = await assertQuoteMatchesOrder({
      stripe,
      quote: stripeQuote,
      localQuote: opts.quote,
      order: opts.order,
      customerId,
      products,
    });
    const quoteDocument = opts.quote.document_sha256
      ? undefined
      : await readStripePdf(await stripe.quotes.pdf(stripeQuote.id));
    const stripeInvoice = await normalizeAcceptedInvoice({
      stripe,
      order: opts.order,
      quoteId: opts.quote.id,
      invoiceId: intent.invoice.id,
      providerInvoiceId,
      customerId,
      products,
      keyPrefix,
      expectedDueAt,
    });
    return await completeCommercialQuoteAcceptance({
      operation_id: reservation.operation.id,
      quote_id: opts.quote.id,
      invoice_id: intent.invoice.id,
      provider_quote_id: stripeQuote.id,
      provider_invoice_id: stripeInvoice.id,
      provider_customer_id: customerId,
      quote_provider_snapshot: quoteProviderSnapshot(
        stripeQuote,
        lines,
        products,
        reviewedQuoteText(opts.order, opts.quote),
      ),
      acceptance_source: opts.allowRemoteAccept
        ? "operator_confirmed"
        : "provider_reconciliation",
      quote_issued_at:
        opts.quote.issued_at ??
        timestamp(stripeQuote.status_transitions?.finalized_at) ??
        new Date().toISOString(),
      quote_document_filename: quoteDocument
        ? `${stripeQuote.number ?? opts.quote.quote_number}.pdf`
        : undefined,
      quote_document_sha256: quoteDocument ? sha256(quoteDocument) : undefined,
      quote_document_data: quoteDocument,
      invoice_provider_snapshot: invoiceProviderSnapshot(stripeInvoice),
      subtotal: fromStripeAmount(stripeInvoice.subtotal),
      tax: moneyToDbString(
        moneySubtract(
          fromStripeAmount(stripeInvoice.total),
          fromStripeAmount(stripeInvoice.subtotal),
        ),
      ),
      total: fromStripeAmount(stripeInvoice.total),
      amount_due: fromStripeAmount(stripeInvoice.amount_due),
      due_at: timestamp(stripeInvoice.due_date),
      hosted_invoice_url: stripeInvoice.hosted_invoice_url,
      invoice_pdf_url: stripeInvoice.invoice_pdf,
      actor_account_id: opts.actorAccountId,
      event_source: opts.source,
      event_reason: opts.reason,
      event_idempotency_key: `${keyPrefix}:local:accepted`,
    });
  } catch (err) {
    recordCommercialProviderFailure("quote-accept");
    await setCommercialProviderOperationStatus({
      id: reservation.operation.id,
      status: "indeterminate",
      error: err,
    });
    throw err;
  }
}

export async function acceptStripeCommercialQuote(
  opts: CommercialStripeQuoteAcceptRequest,
): Promise<CommercialOrder> {
  const reason = requireReason(opts.reason);
  if (!opts.account_id || !opts.expected_version) {
    throw Error("account_id and expected_version are required");
  }
  if (opts.customer_acceptance_confirmed !== true) {
    throw Error("confirmed customer acceptance is required");
  }
  const order = await getCommercialOrder(opts.id);
  if (!order.approved_at || !order.approved_by_account_id) {
    throw Error(
      "the commercial order must be approved before quote acceptance",
    );
  }
  const quote = await getCommercialQuote(order.id, opts.commercial_quote_id);
  if (quote.provider !== "stripe") throw Error("quote is not Stripe-backed");
  return await acceptOrAdoptStripeQuote({
    order,
    quote,
    expectedVersion: opts.expected_version,
    actorAccountId: opts.account_id,
    source: opts.source ?? "cli",
    reason,
    allowRemoteAccept: true,
  });
}

async function applyReconciledStripeQuote(opts: {
  order: CommercialOrder;
  quote: CommercialQuote;
  stripe: StripeConnection;
  stripeQuote: any;
  source: CommercialEventSource;
  reason: string;
  eventKey: string;
  actorAccountId?: string;
}): Promise<CommercialOrder> {
  const customerId = quoteCustomerId(opts.stripeQuote);
  if (!customerId) throw Error("Stripe quote has no customer");
  const products = await productsFromSnapshot(
    opts.stripe,
    opts.quote,
    opts.order,
  );
  const lines = await assertQuoteMatchesOrder({
    stripe: opts.stripe,
    quote: opts.stripeQuote,
    localQuote: opts.quote,
    order: opts.order,
    customerId,
    products,
  });
  switch (opts.stripeQuote.status) {
    case "draft":
      if (opts.quote.status !== "draft") {
        throw Error("Stripe quote regressed from a finalized local state");
      }
      return await updateCommercialQuoteProvider({
        quote_id: opts.quote.id,
        status: "draft",
        provider_quote_id: opts.stripeQuote.id,
        provider_status: "draft",
        provider_snapshot: quoteProviderSnapshot(
          opts.stripeQuote,
          lines,
          products,
          reviewedQuoteText(opts.order, opts.quote),
        ),
        actor_account_id: opts.actorAccountId,
        event_type: "stripe-quote-reconciled",
        event_source: opts.source,
        event_reason: opts.reason,
        event_idempotency_key: opts.eventKey,
        skip_if_unchanged: true,
      });
    case "open": {
      const document = opts.quote.document_sha256
        ? undefined
        : await readStripePdf(
            await opts.stripe.quotes.pdf(opts.stripeQuote.id),
          );
      return await updateCommercialQuoteProvider({
        quote_id: opts.quote.id,
        status: "issued",
        provider_quote_id: opts.stripeQuote.id,
        provider_status: "open",
        provider_snapshot: quoteProviderSnapshot(
          opts.stripeQuote,
          lines,
          products,
          reviewedQuoteText(opts.order, opts.quote),
        ),
        issued_at:
          opts.quote.issued_at ??
          timestamp(opts.stripeQuote.status_transitions?.finalized_at) ??
          new Date().toISOString(),
        document_filename: document
          ? `${opts.stripeQuote.number ?? opts.quote.quote_number}.pdf`
          : undefined,
        document_sha256: document ? sha256(document) : undefined,
        document_data: document,
        actor_account_id: opts.actorAccountId,
        event_type: "stripe-quote-reconciled",
        event_source: opts.source,
        event_reason: opts.reason,
        event_idempotency_key: opts.eventKey,
        skip_if_unchanged: true,
      });
    }
    case "accepted":
      return await acceptOrAdoptStripeQuote({
        order: opts.order,
        quote: opts.quote,
        expectedVersion: opts.order.version,
        actorAccountId: opts.actorAccountId,
        source: opts.source,
        reason: opts.reason,
        allowRemoteAccept: false,
      });
    case "canceled":
      return await updateCommercialQuoteProvider({
        quote_id: opts.quote.id,
        status: "void",
        provider_quote_id: opts.stripeQuote.id,
        provider_status: "canceled",
        provider_snapshot: quoteProviderSnapshot(
          opts.stripeQuote,
          lines,
          products,
          reviewedQuoteText(opts.order, opts.quote),
        ),
        actor_account_id: opts.actorAccountId,
        event_type: "stripe-quote-reconciled",
        event_source: opts.source,
        event_reason: opts.reason,
        event_idempotency_key: opts.eventKey,
        skip_if_unchanged: true,
      });
    default:
      throw Error(`unsupported Stripe quote status ${opts.stripeQuote.status}`);
  }
}

export async function reconcileStripeCommercialQuoteById(opts: {
  order_id: string;
  commercial_quote_id: string;
  source: CommercialEventSource;
  reason: string;
  event_idempotency_key: string;
  actor_account_id?: string;
}): Promise<CommercialOrder> {
  const order = await getCommercialOrder(opts.order_id);
  const quote = await getCommercialQuote(order.id, opts.commercial_quote_id);
  if (quote.provider !== "stripe") throw Error("quote is not Stripe-backed");
  const stripe = await getConn();
  let stripeQuote = quote.provider_quote_id
    ? await stripe.quotes.retrieve(quote.provider_quote_id)
    : undefined;
  if (!stripeQuote) {
    const customerId =
      quoteCustomerId(quote.provider_snapshot) ??
      (await findExistingCommercialStripeCustomer({
        stripe,
        order,
        providerCustomerId: order.stripe_customer_id,
      }));
    if (!customerId) throw Error("Stripe quote customer cannot be resolved");
    stripeQuote = await findStripeQuoteByMetadata({
      stripe,
      localQuote: quote,
      customerId,
    });
  }
  if (!stripeQuote) throw Error("Stripe quote could not be found");
  return await applyReconciledStripeQuote({
    order,
    quote,
    stripe,
    stripeQuote,
    source: opts.source,
    reason: opts.reason,
    eventKey: opts.event_idempotency_key,
    actorAccountId: opts.actor_account_id,
  });
}

export async function reconcileStripeCommercialQuote(
  opts: CommercialStripeQuoteMutationRequest,
): Promise<CommercialOrder> {
  const reason = requireReason(opts.reason);
  if (!opts.account_id || !opts.expected_version) {
    throw Error("account_id and expected_version are required");
  }
  const order = await getCommercialOrder(opts.id);
  const quote = await getCommercialQuote(order.id, opts.commercial_quote_id);
  const site = await currentStripeSite();
  const keyPrefix = operationPrefix(site, quote.id);
  const operationKey = commercialIdempotencyKey("quote-reconcile", opts as any);
  const reservation = await reserveCommercialProviderOperation({
    order_id: order.id,
    quote_id: quote.id,
    operation: "quote_reconcile",
    expected_version: opts.expected_version,
    idempotency_key: operationKey,
    request: { commercial_quote_id: quote.id },
  });
  if (reservation.operation.status === "succeeded") {
    return await getCommercialOrder(order.id);
  }
  await setCommercialProviderOperationStatus({
    id: reservation.operation.id,
    status: "remote_started",
  });
  try {
    const updated = await reconcileStripeCommercialQuoteById({
      order_id: order.id,
      commercial_quote_id: quote.id,
      source: opts.source ?? "reconciler",
      reason,
      event_idempotency_key: `${keyPrefix}:reconcile:${operationKey}`,
      actor_account_id: opts.account_id,
    });
    await setCommercialProviderOperationStatus({
      id: reservation.operation.id,
      status: "succeeded",
      result: { provider_quote_id: quote.provider_quote_id ?? null },
    });
    return updated;
  } catch (err) {
    logger.warn("Stripe quote reconciliation failed", {
      commercial_order_id: order.id,
      commercial_quote_id: quote.id,
      error: `${err}`,
    });
    recordCommercialProviderFailure("quote-reconcile");
    await setCommercialProviderOperationStatus({
      id: reservation.operation.id,
      status: "indeterminate",
      error: err,
    });
    throw err;
  }
}
