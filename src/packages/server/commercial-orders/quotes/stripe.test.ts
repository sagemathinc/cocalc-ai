/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/** @jest-environment node */

import { Readable } from "node:stream";

const mockGetConn = jest.fn();
const mockCurrentStripeSite = jest.fn();
const mockApprovedInvoiceTerms = jest.fn();
const mockCustomFields = jest.fn();
const mockFindExistingCommercialStripeCustomer = jest.fn();
const mockResolveCommercialStripeCustomer = jest.fn();
const mockBuildCommercialQuotePreview = jest.fn();
const mockCompleteCommercialQuoteAcceptance = jest.fn();
const mockCreateCommercialInvoiceIntent = jest.fn();
const mockCreateCommercialStripeQuoteIntent = jest.fn();
const mockGetCommercialOrder = jest.fn();
const mockGetCommercialQuote = jest.fn();
const mockReserveCommercialProviderOperation = jest.fn();
const mockSetCommercialProviderOperationStatus = jest.fn();
const mockUpdateCommercialQuoteProvider = jest.fn();
const mockQuoteValidUntil = jest.fn();
const mockRecordCommercialProviderFailure = jest.fn();

jest.mock("@cocalc/server/stripe/connection", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetConn(...args),
}));

jest.mock("@cocalc/server/purchases/stripe/util", () => ({
  currentStripeSite: (...args: any[]) => mockCurrentStripeSite(...args),
}));

jest.mock("../invoices/stripe", () => ({
  approvedInvoiceTerms: (...args: any[]) => mockApprovedInvoiceTerms(...args),
  customFields: (...args: any[]) => mockCustomFields(...args),
  findExistingCommercialStripeCustomer: (...args: any[]) =>
    mockFindExistingCommercialStripeCustomer(...args),
  resolveCommercialStripeCustomer: (...args: any[]) =>
    mockResolveCommercialStripeCustomer(...args),
}));

jest.mock("../observability", () => ({
  recordCommercialProviderFailure: (...args: any[]) =>
    mockRecordCommercialProviderFailure(...args),
}));

jest.mock("../store", () => ({
  buildCommercialQuotePreview: (...args: any[]) =>
    mockBuildCommercialQuotePreview(...args),
  commercialIdempotencyKey: (operation: string) => `${operation}:key`,
  completeCommercialQuoteAcceptance: (...args: any[]) =>
    mockCompleteCommercialQuoteAcceptance(...args),
  createCommercialInvoiceIntent: (...args: any[]) =>
    mockCreateCommercialInvoiceIntent(...args),
  createCommercialStripeQuoteIntent: (...args: any[]) =>
    mockCreateCommercialStripeQuoteIntent(...args),
  getCommercialOrder: (...args: any[]) => mockGetCommercialOrder(...args),
  getCommercialQuote: (...args: any[]) => mockGetCommercialQuote(...args),
  quoteValidUntil: (...args: any[]) => mockQuoteValidUntil(...args),
  reserveCommercialProviderOperation: (...args: any[]) =>
    mockReserveCommercialProviderOperation(...args),
  setCommercialProviderOperationStatus: (...args: any[]) =>
    mockSetCommercialProviderOperationStatus(...args),
  updateCommercialQuoteProvider: (...args: any[]) =>
    mockUpdateCommercialQuoteProvider(...args),
}));

import type {
  CommercialInvoice,
  CommercialOrder,
  CommercialQuote,
} from "@cocalc/util/commercial-orders";
import {
  acceptStripeCommercialQuote,
  cancelStripeCommercialQuote,
  commercialStripeQuotePreview,
  createStripeCommercialQuote,
  finalizeStripeCommercialQuote,
  reconcileStripeCommercialQuote,
  reconcileStripeCommercialQuoteById,
} from "./stripe";

const SITE = "test.cocalc.ai";
const VALID_UNTIL = "2026-09-25T00:00:00.000Z";
const DUE_AT = "2026-09-25T00:00:00.000Z";
const DUE_DATE = Math.floor(new Date(DUE_AT).getTime() / 1000);

function quoteFixture(changes: Partial<CommercialQuote> = {}): CommercialQuote {
  return {
    id: "cq_1",
    commercial_order_id: "co_1",
    quote_number: "Q-2026-000001-01",
    status: "draft",
    provider: "stripe",
    provider_quote_id: null,
    provider_status: null,
    provider_invoice_id: null,
    currency: "usd",
    subtotal: "3900.0000000000",
    total: "3900.0000000000",
    issued_at: null,
    valid_until: VALID_UNTIL,
    voided_at: null,
    document_filename: null,
    document_mime_type: null,
    document_sha256: null,
    document_size: null,
    snapshot: {},
    provider_snapshot: {},
    provider_updated_at: null,
    last_reconciled_at: null,
    created_by_account_id: "admin-1",
    voided_by_account_id: null,
    idempotency_key: "stripe-quote-intent",
    created_at: "2026-08-26T00:00:00.000Z",
    updated_at: "2026-08-26T00:00:00.000Z",
    ...changes,
  };
}

function invoiceFixture(
  changes: Partial<CommercialInvoice> = {},
): CommercialInvoice {
  return {
    id: "ci_1",
    commercial_order_id: "co_1",
    provider: "stripe",
    provider_customer_id: null,
    provider_invoice_id: null,
    provider_payment_intent_id: null,
    status: "creating",
    currency: "usd",
    subtotal: "3900.0000000000",
    tax: "0.0000000000",
    total: "3900.0000000000",
    amount_due: "3900.0000000000",
    amount_paid: "0.0000000000",
    due_at: DUE_AT,
    hosted_invoice_url: null,
    invoice_pdf_url: null,
    sent_at: null,
    paid_at: null,
    voided_at: null,
    last_reconciled_at: null,
    reconcile_attempt_count: 0,
    last_reconcile_error: null,
    idempotency_key: "commercial:stripe-quote:cq_1:accepted-invoice:v1",
    provider_snapshot: {},
    created_at: "2026-08-26T00:00:00.000Z",
    updated_at: "2026-08-26T00:00:00.000Z",
    ...changes,
  };
}

function orderFixture(changes: Partial<CommercialOrder> = {}): CommercialOrder {
  return {
    id: "co_1",
    order_number: "AR-2026-000001",
    organization_name: "Example University",
    customer_account_id: null,
    stripe_customer_id: "cus_1",
    site_license_id: null,
    zendesk_ticket_ids: [20529],
    workflow_state: "ready_to_invoice",
    collection_mode: "stripe_invoice",
    collection_state: "not_invoiced",
    fulfillment_state: "not_provisioned",
    currency: "usd",
    agreed_subtotal: "3900.0000000000",
    agreed_total: "3900.0000000000",
    service_starts_at: "2026-09-01T00:00:00.000Z",
    service_ends_at: "2027-08-31T00:00:00.000Z",
    payment_terms_days: 30,
    po_number: null,
    customer_reference: null,
    terms_snapshot: {},
    assignee_account_id: "admin-1",
    next_action: "Send quote",
    next_action_due_at: null,
    approved_at: "2026-08-26T00:00:00.000Z",
    approved_by_account_id: "admin-1",
    provisioned_at: null,
    completed_at: null,
    cancelled_at: null,
    created_by_account_id: "admin-1",
    created_at: "2026-08-26T00:00:00.000Z",
    updated_at: "2026-08-26T00:00:00.000Z",
    version: 4,
    items: [
      {
        id: "item_1",
        commercial_order_id: "co_1",
        position: 0,
        description: "Campus adoption pilot",
        quantity: "1.0000000000",
        unit_amount: "3900.0000000000",
        subtotal: "3900.0000000000",
        product_kind: "site_license",
        product_reference: null,
        metadata: {},
        created_at: "2026-08-26T00:00:00.000Z",
        updated_at: "2026-08-26T00:00:00.000Z",
      },
    ],
    contacts: [
      {
        id: "contact_1",
        commercial_order_id: "co_1",
        role: "billing",
        name_snapshot: "Accounts Payable",
        email_snapshot: "ap@example.edu",
        created_at: "2026-08-26T00:00:00.000Z",
        updated_at: "2026-08-26T00:00:00.000Z",
      },
    ],
    quotes: [],
    documents: [],
    invoices: [],
    payments: [],
    ...changes,
  };
}

function stripeQuoteFixture(changes: Record<string, unknown> = {}) {
  return {
    id: "qt_1",
    object: "quote",
    livemode: false,
    status: "draft",
    number: null,
    currency: "usd",
    customer: "cus_1",
    invoice: null,
    amount_subtotal: 390000,
    amount_total: 390000,
    collection_method: "send_invoice",
    invoice_settings: { days_until_due: 30 },
    expires_at: Math.floor(new Date(VALID_UNTIL).getTime() / 1000),
    created: 1787702400,
    description: "Example University: AR-2026-000001",
    header: "CoCalc Commercial Quote",
    footer: null,
    automatic_tax: { enabled: false },
    metadata: {
      flow: "commercial_quote",
      commercial_order_id: "co_1",
      commercial_quote_id: "cq_1",
      order_number: "AR-2026-000001",
      cocalc_site: SITE,
      local_quote_number: "Q-2026-000001-01",
    },
    status_transitions: {},
    ...changes,
  };
}

function stripeQuoteLineFixture(changes: Record<string, unknown> = {}) {
  return {
    id: "qli_1",
    description: "Campus adoption pilot",
    quantity: 1,
    price: {
      product: { id: "prod_site", name: "Campus adoption pilot" },
      unit_amount: 390000,
    },
    amount_subtotal: 390000,
    amount_total: 390000,
    ...changes,
  };
}

function stripeInvoiceFixture(changes: Record<string, unknown> = {}) {
  return {
    id: "in_1",
    object: "invoice",
    livemode: false,
    status: "draft",
    currency: "usd",
    customer: "cus_1",
    auto_advance: false,
    collection_method: "send_invoice",
    subtotal: 390000,
    automatic_tax: { enabled: false },
    total: 390000,
    amount_due: 390000,
    amount_paid: 0,
    amount_remaining: 390000,
    due_date: DUE_DATE,
    hosted_invoice_url: null,
    invoice_pdf: null,
    metadata: {
      flow: "commercial_order",
      commercial_order_id: "co_1",
      commercial_invoice_id: "ci_1",
      commercial_quote_id: "cq_1",
      order_number: "AR-2026-000001",
      cocalc_site: SITE,
    },
    ...changes,
  };
}

describe("commercial Stripe quotes", () => {
  const stripe = {
    publishable_key: "pk_test_123",
    prices: { retrieve: jest.fn() },
    products: {
      create: jest.fn(),
      retrieve: jest.fn(),
      search: jest.fn(),
    },
    quotes: {
      accept: jest.fn(),
      cancel: jest.fn(),
      create: jest.fn(),
      finalizeQuote: jest.fn(),
      list: jest.fn(),
      listLineItems: jest.fn(),
      pdf: jest.fn(),
      retrieve: jest.fn(),
    },
    invoices: {
      finalizeInvoice: jest.fn(),
      listLineItems: jest.fn(),
      retrieve: jest.fn(),
      sendInvoice: jest.fn(),
      update: jest.fn(),
      updateLineItem: jest.fn(),
    },
  };

  beforeEach(() => {
    jest.resetAllMocks();
    const order = orderFixture();
    const quote = quoteFixture();
    const intentOrder = orderFixture({ version: 5, quotes: [quote] });
    mockGetConn.mockResolvedValue(stripe);
    mockCurrentStripeSite.mockResolvedValue(SITE);
    mockApprovedInvoiceTerms.mockReturnValue({});
    mockCustomFields.mockReturnValue([]);
    mockFindExistingCommercialStripeCustomer.mockResolvedValue("cus_1");
    mockResolveCommercialStripeCustomer.mockResolvedValue("cus_1");
    mockBuildCommercialQuotePreview.mockReturnValue({
      order_id: "co_1",
      order_number: "AR-2026-000001",
      organization_name: "Example University",
      billing_contacts: order.contacts,
      items: order.items,
      currency: "usd",
      subtotal: "3900.0000000000",
      total: "3900.0000000000",
      service_starts_at: order.service_starts_at,
      service_ends_at: order.service_ends_at,
      po_number: null,
      customer_reference: null,
      quote_memo: null,
      billing_address: null,
      default_valid_until: VALID_UNTIL,
      ready: true,
      blockers: [],
    });
    mockQuoteValidUntil.mockImplementation(
      (value: string | undefined, fallback: string) => value ?? fallback,
    );
    mockGetCommercialOrder.mockResolvedValue(order);
    mockGetCommercialQuote.mockResolvedValue(quote);
    mockCreateCommercialStripeQuoteIntent.mockResolvedValue({
      order: intentOrder,
      quote,
    });
    mockCreateCommercialInvoiceIntent.mockResolvedValue({
      order: orderFixture({
        version: 5,
        quotes: [quote],
        invoices: [invoiceFixture()],
      }),
      invoice: invoiceFixture(),
    });
    mockReserveCommercialProviderOperation.mockResolvedValue({
      operation: { id: "op_1", status: "reserved" },
    });
    mockSetCommercialProviderOperationStatus.mockResolvedValue(undefined);
    mockUpdateCommercialQuoteProvider.mockResolvedValue(intentOrder);
    mockCompleteCommercialQuoteAcceptance.mockResolvedValue(
      orderFixture({
        version: 6,
        collection_state: "draft_invoice",
        quotes: [quoteFixture({ status: "accepted" })],
        invoices: [invoiceFixture({ status: "draft" })],
      }),
    );
    stripe.products.search.mockResolvedValue({
      data: [
        {
          id: "prod_site",
          object: "product",
          name: "Campus adoption pilot",
          livemode: false,
          active: true,
          deleted: false,
        },
      ],
    });
    stripe.products.create.mockResolvedValue({
      id: "prod_site",
      object: "product",
      name: "Campus adoption pilot",
      livemode: false,
      active: true,
      deleted: false,
    });
    stripe.products.retrieve.mockResolvedValue({
      id: "prod_site",
      object: "product",
      name: "Campus adoption pilot",
      livemode: false,
      active: true,
      deleted: false,
    });
    stripe.quotes.list.mockResolvedValue({ data: [], has_more: false });
    stripe.quotes.listLineItems.mockResolvedValue({
      data: [stripeQuoteLineFixture()],
      has_more: false,
    });
    stripe.quotes.retrieve.mockResolvedValue(stripeQuoteFixture());
    stripe.quotes.create.mockResolvedValue(stripeQuoteFixture());
    stripe.quotes.finalizeQuote.mockResolvedValue(
      stripeQuoteFixture({
        status: "open",
        number: "QT-0001",
        status_transitions: { finalized_at: 1787702400 },
      }),
    );
    stripe.quotes.cancel.mockResolvedValue(
      stripeQuoteFixture({ status: "canceled" }),
    );
    stripe.quotes.accept.mockResolvedValue(
      stripeQuoteFixture({ status: "accepted", invoice: "in_1" }),
    );
    stripe.quotes.pdf.mockImplementation(() =>
      Readable.from([Buffer.from("%PDF-stripe-quote")]),
    );
    stripe.invoices.retrieve.mockResolvedValue(stripeInvoiceFixture());
    stripe.invoices.update.mockResolvedValue(stripeInvoiceFixture());
    stripe.invoices.listLineItems.mockResolvedValue({
      data: [
        {
          id: "il_1",
          amount: 390000,
          quantity: 1,
          pricing: {
            type: "price_details",
            price_details: { price: "price_site", product: "prod_site" },
            unit_amount_decimal: "390000",
          },
        },
      ],
      has_more: false,
    });
    stripe.invoices.updateLineItem.mockResolvedValue({ id: "il_1" });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("reports Stripe-specific blockers without mutating local or remote state", async () => {
    const order = orderFixture({
      agreed_total: "4000.0000000000",
      items: [
        {
          ...orderFixture().items[0],
          quantity: "1.5000000000",
          product_kind: "unknown_product",
        },
      ],
      quotes: [quoteFixture({ status: "issued" })],
    });
    mockGetCommercialOrder.mockResolvedValue(order);

    const preview = await commercialStripeQuotePreview({
      id: "co_1",
      reason: "Review Stripe quote readiness",
    });

    expect(preview.ready).toBe(false);
    expect(preview.blockers).toEqual(
      expect.arrayContaining([
        expect.stringContaining("agreed_total must equal agreed_subtotal"),
        expect.stringContaining("quantity must be a positive integer"),
        expect.stringContaining("supported product_kind"),
        "the order already has an active Stripe quote",
      ]),
    );
    expect(mockCreateCommercialStripeQuoteIntent).not.toHaveBeenCalled();
    expect(mockReserveCommercialProviderOperation).not.toHaveBeenCalled();
    expect(stripe.products.search).not.toHaveBeenCalled();
    expect(stripe.products.create).not.toHaveBeenCalled();
    expect(stripe.quotes.create).not.toHaveBeenCalled();
  });

  it("creates an exact draft mapping with stable provider idempotency", async () => {
    await createStripeCommercialQuote({
      id: "co_1",
      account_id: "admin-1",
      expected_version: 4,
      valid_until: VALID_UNTIL,
      reason: "Create reviewed Stripe quote",
    });

    expect(mockCreateCommercialStripeQuoteIntent).toHaveBeenCalledTimes(1);
    expect(mockReserveCommercialProviderOperation).toHaveBeenCalledWith({
      order_id: "co_1",
      quote_id: "cq_1",
      operation: "quote_create",
      expected_version: 5,
      idempotency_key:
        "cocalc:test.cocalc.ai:commercial-quote:cq_1:v1:operation:create",
      request: { commercial_quote_id: "cq_1" },
    });
    expect(stripe.quotes.create).toHaveBeenCalledWith(
      {
        customer: "cus_1",
        collection_method: "send_invoice",
        invoice_settings: { days_until_due: 30 },
        expires_at: Math.floor(new Date(VALID_UNTIL).getTime() / 1000),
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              product: "prod_site",
              unit_amount: 390000,
            },
          },
        ],
        automatic_tax: { enabled: false },
        description: "Example University: AR-2026-000001",
        header: "CoCalc Commercial Quote",
        footer: "",
        metadata: {
          flow: "commercial_quote",
          commercial_order_id: "co_1",
          order_number: "AR-2026-000001",
          cocalc_site: SITE,
          commercial_quote_id: "cq_1",
          local_quote_number: "Q-2026-000001-01",
        },
      },
      {
        idempotencyKey: "cocalc:test.cocalc.ai:commercial-quote:cq_1:v1:quote",
      },
    );
    expect(mockUpdateCommercialQuoteProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        quote_id: "cq_1",
        status: "draft",
        provider_quote_id: "qt_1",
        provider_status: "draft",
        provider_snapshot: expect.objectContaining({
          reviewed_text: {
            description: "Example University: AR-2026-000001",
            header: "CoCalc Commercial Quote",
            footer: "",
          },
        }),
        event_type: "stripe-quote-draft-created",
      }),
    );
  });

  function enableReviewedTax() {
    const terms = {
      automatic_tax: true,
      tax_code: "txcd_10103000",
      billing_address: { country: "GB" },
    };
    const quote = quoteFixture({
      total: "4680.0000000000",
      provider_quote_id: "qt_1",
    });
    const order = orderFixture({
      terms_snapshot: { invoice: terms },
      agreed_total: quote.total,
      quotes: [],
    });
    const provider = stripeQuoteFixture({
      amount_total: 468000,
      automatic_tax: { enabled: true, status: "complete" },
    });
    mockGetCommercialOrder.mockResolvedValue(order);
    mockGetCommercialQuote.mockResolvedValue(quote);
    mockBuildCommercialQuotePreview.mockReturnValue({
      ...mockBuildCommercialQuotePreview(),
      total: quote.total,
    });
    mockCreateCommercialStripeQuoteIntent.mockResolvedValue({
      order: { ...order, version: 5, quotes: [quote] },
      quote,
    });
    stripe.products.search.mockResolvedValue({
      data: [
        {
          id: "prod_site",
          name: "Campus adoption pilot",
          active: true,
          livemode: false,
          tax_code: terms.tax_code,
        },
      ],
    });
    stripe.quotes.create.mockResolvedValue(provider);
    stripe.prices.retrieve.mockResolvedValue({
      id: "price_site",
      tax_behavior: "exclusive",
      product: { id: "prod_site", tax_code: terms.tax_code },
    });
    stripe.quotes.retrieve.mockResolvedValue(provider);
    stripe.quotes.listLineItems.mockResolvedValue({
      data: [
        stripeQuoteLineFixture({
          amount_total: 468000,
          price: {
            unit_amount: 390000,
            tax_behavior: "exclusive",
            product: { id: "prod_site", tax_code: terms.tax_code },
          },
        }),
      ],
    });
    return { order, quote, provider };
  }

  it("creates reviewed automatic-tax quotes with exclusive prices", async () => {
    const { order, quote } = enableReviewedTax();
    mockCreateCommercialStripeQuoteIntent.mockResolvedValue({
      order,
      quote: { ...quote, provider_quote_id: null },
    });
    await createStripeCommercialQuote({
      id: "co_1",
      account_id: "admin-1",
      expected_version: 4,
      reason: "Reviewed automatic tax",
    });
    expect(stripe.quotes.create).toHaveBeenCalledWith(
      expect.objectContaining({
        automatic_tax: { enabled: true },
        line_items: [
          expect.objectContaining({
            price_data: expect.objectContaining({ tax_behavior: "exclusive" }),
          }),
        ],
      }),
      expect.anything(),
    );
  });

  it("does not finalize a quote whose product tax settings drifted", async () => {
    enableReviewedTax();
    stripe.quotes.listLineItems.mockResolvedValue({
      data: [stripeQuoteLineFixture()],
    });
    await expect(
      finalizeStripeCommercialQuote({
        id: "co_1",
        commercial_quote_id: "cq_1",
        account_id: "admin-1",
        expected_version: 4,
        reason: "Review quote",
      }),
    ).rejects.toThrow("line tax settings");
    expect(stripe.quotes.finalizeQuote).not.toHaveBeenCalled();
  });

  it("preserves automatic tax and its amount when accepting a quote", async () => {
    const { order, quote, provider } = enableReviewedTax();
    const issued = {
      ...quote,
      status: "issued" as const,
      document_sha256: "a".repeat(64),
    };
    mockGetCommercialQuote.mockResolvedValue(issued);
    mockGetCommercialOrder.mockResolvedValue({ ...order, quotes: [issued] });
    stripe.quotes.retrieve.mockResolvedValue({ ...provider, status: "open" });
    stripe.quotes.accept.mockResolvedValue({
      ...provider,
      status: "accepted",
      invoice: "in_1",
    });
    const invoice = stripeInvoiceFixture({
      total: 468000,
      amount_due: 468000,
      amount_remaining: 468000,
      automatic_tax: { enabled: true, status: "complete" },
      total_taxes: [{ amount: 78000 }],
    });
    stripe.invoices.retrieve.mockResolvedValue(invoice);
    await acceptStripeCommercialQuote({
      id: "co_1",
      commercial_quote_id: "cq_1",
      account_id: "admin-1",
      expected_version: 4,
      customer_acceptance_confirmed: true,
      reason: "Customer accepted",
    });
    expect(stripe.invoices.update).toHaveBeenCalledWith(
      "in_1",
      expect.objectContaining({ automatic_tax: { enabled: true } }),
      expect.anything(),
    );
    expect(mockCompleteCommercialQuoteAcceptance).toHaveBeenCalledWith(
      expect.objectContaining({
        tax: "780.0000000000",
        total: "4680.0000000000",
      }),
    );
    expect(stripe.invoices.sendInvoice).not.toHaveBeenCalled();
  });

  it.each(["changed", "missing"])(
    "rejects %s invoice product tax code after quote acceptance",
    async (change) => {
      const { order, quote, provider } = enableReviewedTax();
      const issued = {
        ...quote,
        status: "issued" as const,
        document_sha256: "a".repeat(64),
      };
      mockGetCommercialQuote.mockResolvedValue(issued);
      mockGetCommercialOrder.mockResolvedValue({ ...order, quotes: [issued] });
      stripe.quotes.retrieve.mockResolvedValue({ ...provider, status: "open" });
      stripe.quotes.accept.mockResolvedValue({
        ...provider,
        status: "accepted",
        invoice: "in_1",
      });
      stripe.prices.retrieve.mockResolvedValue({
        id: "price_site",
        tax_behavior: "exclusive",
        product: {
          id: "prod_site",
          tax_code: change === "missing" ? null : "txcd_10000000",
        },
      });
      await expect(
        acceptStripeCommercialQuote({
          id: "co_1",
          commercial_quote_id: "cq_1",
          account_id: "admin-1",
          expected_version: 4,
          customer_acceptance_confirmed: true,
          reason: "Customer accepted",
        }),
      ).rejects.toThrow("line tax settings");
      expect(mockCompleteCommercialQuoteAcceptance).not.toHaveBeenCalled();
      expect(stripe.invoices.updateLineItem).not.toHaveBeenCalled();
      expect(stripe.invoices.sendInvoice).not.toHaveBeenCalled();
      expect(mockSetCommercialProviderOperationStatus).toHaveBeenCalledWith(
        expect.objectContaining({ status: "indeterminate" }),
      );
    },
  );

  it.each(["exclusive", "inclusive"])(
    "checks %s invoice pricing when recovering an accepted taxable quote",
    async (taxBehavior) => {
      const { order, quote, provider } = enableReviewedTax();
      const issued = {
        ...quote,
        status: "issued" as const,
        document_sha256: "a".repeat(64),
      };
      mockGetCommercialQuote.mockResolvedValue(issued);
      mockGetCommercialOrder.mockResolvedValue({ ...order, quotes: [issued] });
      stripe.quotes.retrieve.mockResolvedValue({
        ...provider,
        status: "accepted",
        invoice: "in_1",
      });
      stripe.invoices.retrieve.mockResolvedValue(
        stripeInvoiceFixture({
          total: 468000,
          amount_due: 468000,
          amount_remaining: 468000,
          automatic_tax: { enabled: true, status: "complete" },
        }),
      );
      stripe.prices.retrieve.mockResolvedValue({
        id: "price_site",
        tax_behavior: taxBehavior,
        product: { id: "prod_site", tax_code: "txcd_10103000" },
      });
      const recover = reconcileStripeCommercialQuoteById({
        order_id: "co_1",
        commercial_quote_id: "cq_1",
        source: "stripe-webhook",
        reason: "Recover accepted taxable quote",
        event_idempotency_key: "evt_tax_recovery",
      });
      if (taxBehavior === "exclusive") {
        await recover;
        expect(mockCompleteCommercialQuoteAcceptance).toHaveBeenCalledWith(
          expect.objectContaining({
            tax: "780.0000000000",
            acceptance_source: "provider_reconciliation",
          }),
        );
      } else {
        await expect(recover).rejects.toThrow("line tax settings");
        expect(mockCompleteCommercialQuoteAcceptance).not.toHaveBeenCalled();
      }
      expect(stripe.quotes.accept).not.toHaveBeenCalled();
      expect(stripe.invoices.sendInvoice).not.toHaveBeenCalled();
    },
  );

  it("uses the reviewed line description as the Stripe Product name", async () => {
    stripe.products.search.mockResolvedValue({ data: [] });

    await createStripeCommercialQuote({
      id: "co_1",
      account_id: "admin-1",
      expected_version: 4,
      valid_until: VALID_UNTIL,
      reason: "Create reviewed Stripe quote",
    });

    expect(stripe.products.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Campus adoption pilot",
        metadata: expect.objectContaining({
          purpose: "commercial_quote_line_product",
          product_kind: "site_license",
          line_description_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringContaining(
          "commercial-quote-line-product:site_license:",
        ),
      }),
    );
  });

  it("rejects account-level Stripe text that was not reviewed", async () => {
    stripe.quotes.create.mockResolvedValue(
      stripeQuoteFixture({ footer: "Unexpected account default" }),
    );

    await expect(
      createStripeCommercialQuote({
        id: "co_1",
        account_id: "admin-1",
        expected_version: 4,
        valid_until: VALID_UNTIL,
        reason: "Create reviewed Stripe quote",
      }),
    ).rejects.toThrow("Stripe quote text does not match reviewed terms");

    expect(mockUpdateCommercialQuoteProvider).not.toHaveBeenCalled();
    expect(mockSetCommercialProviderOperationStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "indeterminate" }),
    );
  });

  it("rejects a Stripe line description that was not reviewed", async () => {
    stripe.quotes.listLineItems.mockResolvedValue({
      data: [
        stripeQuoteLineFixture({
          description: "Generic site license",
        }),
      ],
      has_more: false,
    });

    await expect(
      createStripeCommercialQuote({
        id: "co_1",
        account_id: "admin-1",
        expected_version: 4,
        valid_until: VALID_UNTIL,
        reason: "Create reviewed Stripe quote",
      }),
    ).rejects.toThrow("line items do not match reviewed terms");

    expect(mockUpdateCommercialQuoteProvider).not.toHaveBeenCalled();
  });

  it.each([
    [
      { expires_at: Math.floor(new Date(VALID_UNTIL).getTime() / 1000) + 60 },
      "Stripe quote expiration does not match reviewed terms",
    ],
    [
      { invoice_settings: { days_until_due: 45 } },
      "Stripe quote payment-term settings do not match reviewed terms",
    ],
  ])("rejects changed Stripe quote settings", async (changes, error) => {
    stripe.quotes.create.mockResolvedValue(stripeQuoteFixture(changes));

    await expect(
      createStripeCommercialQuote({
        id: "co_1",
        account_id: "admin-1",
        expected_version: 4,
        valid_until: VALID_UNTIL,
        reason: "Create reviewed Stripe quote",
      }),
    ).rejects.toThrow(error);

    expect(mockUpdateCommercialQuoteProvider).not.toHaveBeenCalled();
  });

  it("replays a provider-attached create without another Stripe mutation", async () => {
    const quote = quoteFixture({
      provider_quote_id: "qt_1",
      provider_status: "draft",
      idempotency_key: "stripe-quote-create:key",
    });
    const order = orderFixture({ quotes: [quote] });
    mockGetCommercialOrder.mockResolvedValue(order);

    await expect(
      createStripeCommercialQuote({
        id: "co_1",
        account_id: "admin-1",
        expected_version: 4,
        reason: "Replay Stripe quote creation",
      }),
    ).resolves.toBe(order);

    expect(mockCreateCommercialStripeQuoteIntent).not.toHaveBeenCalled();
    expect(mockReserveCommercialProviderOperation).not.toHaveBeenCalled();
    expect(stripe.quotes.create).not.toHaveBeenCalled();
  });

  it("finalizes a reviewed draft and retains the Stripe PDF bytes", async () => {
    const quote = quoteFixture({
      provider_quote_id: "qt_1",
      provider_status: "draft",
      provider_snapshot: { customer: "cus_1" },
    });
    const order = orderFixture({ quotes: [quote] });
    mockGetCommercialOrder.mockResolvedValue(order);
    mockGetCommercialQuote.mockResolvedValue(quote);

    await finalizeStripeCommercialQuote({
      id: "co_1",
      commercial_quote_id: "cq_1",
      account_id: "admin-1",
      expected_version: 4,
      reason: "Finalize reviewed Stripe quote",
    });

    expect(stripe.quotes.finalizeQuote).toHaveBeenCalledWith(
      "qt_1",
      {},
      {
        idempotencyKey:
          "cocalc:test.cocalc.ai:commercial-quote:cq_1:v1:finalize",
      },
    );
    expect(stripe.quotes.pdf).toHaveBeenCalledWith("qt_1");
    expect(mockUpdateCommercialQuoteProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        quote_id: "cq_1",
        status: "issued",
        provider_status: "open",
        document_filename: "QT-0001.pdf",
        document_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        document_data: Buffer.from("%PDF-stripe-quote"),
      }),
    );
  });

  it("requires explicit customer acceptance before any lookup or mutation", async () => {
    await expect(
      acceptStripeCommercialQuote({
        id: "co_1",
        commercial_quote_id: "cq_1",
        account_id: "admin-1",
        expected_version: 4,
        customer_acceptance_confirmed: false,
        reason: "Record customer acceptance",
      }),
    ).rejects.toThrow("confirmed customer acceptance is required");

    expect(mockGetCommercialOrder).not.toHaveBeenCalled();
    expect(mockCreateCommercialInvoiceIntent).not.toHaveBeenCalled();
    expect(stripe.quotes.accept).not.toHaveBeenCalled();
  });

  it("rejects acceptance until the commercial order is approved", async () => {
    mockGetCommercialOrder.mockResolvedValue(
      orderFixture({ approved_at: null, approved_by_account_id: null }),
    );

    await expect(
      acceptStripeCommercialQuote({
        id: "co_1",
        commercial_quote_id: "cq_1",
        account_id: "admin-1",
        expected_version: 4,
        customer_acceptance_confirmed: true,
        reason: "Record customer acceptance",
      }),
    ).rejects.toThrow(
      "the commercial order must be approved before quote acceptance",
    );

    expect(mockGetCommercialQuote).not.toHaveBeenCalled();
    expect(mockCreateCommercialInvoiceIntent).not.toHaveBeenCalled();
    expect(stripe.quotes.accept).not.toHaveBeenCalled();
  });

  it("accepts into exactly one draft invoice without finalizing or sending it", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-08-26T00:00:00.000Z"));
    const quote = quoteFixture({
      status: "issued",
      provider_quote_id: "qt_1",
      provider_status: "open",
      document_filename: "QT-0001.pdf",
      document_mime_type: "application/pdf",
      document_sha256: "a".repeat(64),
      document_size: 100,
    });
    const order = orderFixture({ quotes: [quote] });
    const invoice = invoiceFixture();
    mockGetCommercialOrder.mockResolvedValue(order);
    mockGetCommercialQuote.mockResolvedValue(quote);
    mockCreateCommercialInvoiceIntent.mockResolvedValue({
      order: orderFixture({ version: 5, quotes: [quote], invoices: [invoice] }),
      invoice,
    });
    stripe.quotes.retrieve.mockResolvedValue(
      stripeQuoteFixture({ status: "open", number: "QT-0001" }),
    );
    stripe.quotes.accept.mockResolvedValue(
      stripeQuoteFixture({
        status: "accepted",
        number: "QT-0001",
        invoice: "in_1",
      }),
    );
    stripe.invoices.retrieve
      .mockResolvedValueOnce(
        stripeInvoiceFixture({
          metadata: { commercial_quote_id: "cq_1" },
        }),
      )
      .mockResolvedValueOnce(stripeInvoiceFixture());

    await acceptStripeCommercialQuote({
      id: "co_1",
      commercial_quote_id: "cq_1",
      account_id: "admin-1",
      expected_version: 4,
      customer_acceptance_confirmed: true,
      reason: "Customer accepted the reviewed quote",
    });

    expect(mockCreateCommercialInvoiceIntent).toHaveBeenCalledTimes(1);
    expect(stripe.quotes.accept).toHaveBeenCalledTimes(1);
    expect(stripe.invoices.update).toHaveBeenCalledWith(
      "in_1",
      expect.objectContaining({
        auto_advance: false,
        collection_method: "send_invoice",
        due_date: DUE_DATE,
        automatic_tax: { enabled: false },
        metadata: expect.objectContaining({
          flow: "commercial_order",
          commercial_order_id: "co_1",
          commercial_invoice_id: "ci_1",
        }),
      }),
      expect.objectContaining({
        idempotencyKey:
          "cocalc:test.cocalc.ai:commercial-quote:cq_1:v1:invoice:normalize",
      }),
    );
    expect(stripe.invoices.updateLineItem).toHaveBeenCalledTimes(1);
    expect(mockCompleteCommercialQuoteAcceptance).toHaveBeenCalledTimes(1);
    expect(mockCompleteCommercialQuoteAcceptance).toHaveBeenCalledWith(
      expect.objectContaining({
        quote_id: "cq_1",
        invoice_id: "ci_1",
        provider_quote_id: "qt_1",
        provider_invoice_id: "in_1",
        subtotal: "3900.0000000000",
        total: "3900.0000000000",
        amount_due: "3900.0000000000",
      }),
    );
    expect(stripe.invoices.finalizeInvoice).not.toHaveBeenCalled();
    expect(stripe.invoices.sendInvoice).not.toHaveBeenCalled();
  });

  it("cancels a draft using a stable key and records a void quote", async () => {
    const quote = quoteFixture({
      provider_quote_id: "qt_1",
      provider_status: "draft",
    });
    const order = orderFixture({ quotes: [quote] });
    mockGetCommercialOrder.mockResolvedValue(order);
    mockGetCommercialQuote.mockResolvedValue(quote);

    await cancelStripeCommercialQuote({
      id: "co_1",
      commercial_quote_id: "cq_1",
      account_id: "admin-1",
      expected_version: 4,
      reason: "Cancel superseded Stripe quote",
    });

    expect(stripe.quotes.cancel).toHaveBeenCalledWith(
      "qt_1",
      {},
      {
        idempotencyKey: "cocalc:test.cocalc.ai:commercial-quote:cq_1:v1:cancel",
      },
    );
    expect(mockUpdateCommercialQuoteProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        quote_id: "cq_1",
        status: "void",
        provider_quote_id: "qt_1",
        provider_status: "canceled",
        event_type: "stripe-quote-canceled",
      }),
    );
  });

  it("can cancel using the immutable quote snapshot after item identities change", async () => {
    const originalItem = orderFixture().items[0];
    const quote = quoteFixture({
      provider_quote_id: "qt_1",
      provider_status: "draft",
      snapshot: { items: [originalItem] },
      provider_snapshot: {
        customer: "cus_1",
        products: [
          {
            commercial_order_item_id: originalItem.id,
            provider_product_id: "prod_site",
            quantity: 1,
            unit_amount: 390000,
          },
        ],
      },
    });
    const order = orderFixture({
      items: [
        {
          ...originalItem,
          id: "replacement_item",
          description: "Revised campus adoption pilot",
        },
      ],
      quotes: [quote],
    });
    mockGetCommercialOrder.mockResolvedValue(order);
    mockGetCommercialQuote.mockResolvedValue(quote);

    await cancelStripeCommercialQuote({
      id: "co_1",
      commercial_quote_id: "cq_1",
      account_id: "admin-1",
      expected_version: 4,
      reason: "Cancel stale Stripe quote safely",
    });

    expect(stripe.quotes.cancel).toHaveBeenCalledTimes(1);
    expect(stripe.products.search).not.toHaveBeenCalled();
  });

  it("recovers an unlinked open quote and retains its PDF during reconciliation", async () => {
    const quote = quoteFixture({ provider_snapshot: { customer: "cus_1" } });
    const order = orderFixture({ quotes: [quote] });
    const remote = stripeQuoteFixture({
      status: "open",
      number: "QT-0001",
      status_transitions: { finalized_at: 1787702400 },
    });
    mockGetCommercialOrder.mockResolvedValue(order);
    mockGetCommercialQuote.mockResolvedValue(quote);
    stripe.quotes.list.mockResolvedValue({ data: [remote], has_more: false });

    await reconcileStripeCommercialQuoteById({
      order_id: "co_1",
      commercial_quote_id: "cq_1",
      source: "stripe-webhook",
      reason: "Recover finalized Stripe quote",
      event_idempotency_key: "evt_qt_1",
    });

    expect(stripe.quotes.list).toHaveBeenCalledWith({
      customer: "cus_1",
      limit: 100,
    });
    expect(mockUpdateCommercialQuoteProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "issued",
        provider_quote_id: "qt_1",
        provider_status: "open",
        document_data: Buffer.from("%PDF-stripe-quote"),
        event_idempotency_key: "evt_qt_1",
        skip_if_unchanged: true,
      }),
    );
  });

  it("replays a completed reconciliation without another provider request", async () => {
    const quote = quoteFixture({
      provider_quote_id: "qt_1",
      provider_status: "draft",
    });
    const order = orderFixture({ quotes: [quote] });
    mockGetCommercialOrder.mockResolvedValue(order);
    mockGetCommercialQuote.mockResolvedValue(quote);
    mockReserveCommercialProviderOperation.mockResolvedValue({
      operation: { id: "op_1", status: "succeeded" },
    });

    await expect(
      reconcileStripeCommercialQuote({
        id: "co_1",
        commercial_quote_id: "cq_1",
        account_id: "admin-1",
        expected_version: 4,
        reason: "Replay Stripe quote reconciliation",
      }),
    ).resolves.toBe(order);

    expect(stripe.quotes.retrieve).not.toHaveBeenCalled();
    expect(mockUpdateCommercialQuoteProvider).not.toHaveBeenCalled();
    expect(mockSetCommercialProviderOperationStatus).not.toHaveBeenCalled();
  });

  it("fails reconciliation closed when remote identity or totals drift", async () => {
    const quote = quoteFixture({
      provider_quote_id: "qt_1",
      provider_status: "draft",
    });
    const order = orderFixture({ quotes: [quote] });
    mockGetCommercialOrder.mockResolvedValue(order);
    mockGetCommercialQuote.mockResolvedValue(quote);
    stripe.quotes.retrieve.mockResolvedValue(
      stripeQuoteFixture({
        amount_total: 390001,
        metadata: {
          ...stripeQuoteFixture().metadata,
          commercial_quote_id: "cq_other",
        },
      }),
    );

    await expect(
      reconcileStripeCommercialQuoteById({
        order_id: "co_1",
        commercial_quote_id: "cq_1",
        source: "reconciler",
        reason: "Verify Stripe quote identity",
        event_idempotency_key: "reconcile-mismatch",
      }),
    ).rejects.toThrow("metadata does not match");

    expect(mockUpdateCommercialQuoteProvider).not.toHaveBeenCalled();
    expect(mockCompleteCommercialQuoteAcceptance).not.toHaveBeenCalled();
  });

  it("does not create a second invoice when accepted reconciliation is replayed", async () => {
    const invoice = invoiceFixture({ status: "draft" });
    const quote = quoteFixture({
      status: "accepted",
      provider_quote_id: "qt_1",
      provider_status: "accepted",
      provider_invoice_id: "in_1",
      document_filename: "QT-0001.pdf",
      document_mime_type: "application/pdf",
      document_sha256: "a".repeat(64),
      document_size: 100,
    });
    const order = orderFixture({ quotes: [quote], invoices: [invoice] });
    mockGetCommercialOrder.mockResolvedValue(order);
    mockGetCommercialQuote.mockResolvedValue(quote);
    stripe.quotes.retrieve.mockResolvedValue(
      stripeQuoteFixture({ status: "accepted", invoice: "in_1" }),
    );

    await expect(
      reconcileStripeCommercialQuoteById({
        order_id: "co_1",
        commercial_quote_id: "cq_1",
        source: "stripe-webhook",
        reason: "Replay accepted Stripe quote",
        event_idempotency_key: "evt_accepted_replay",
      }),
    ).resolves.toBe(order);

    expect(mockCreateCommercialInvoiceIntent).not.toHaveBeenCalled();
    expect(mockReserveCommercialProviderOperation).not.toHaveBeenCalled();
    expect(stripe.invoices.retrieve).not.toHaveBeenCalled();
    expect(stripe.invoices.finalizeInvoice).not.toHaveBeenCalled();
    expect(stripe.invoices.sendInvoice).not.toHaveBeenCalled();
  });
});
