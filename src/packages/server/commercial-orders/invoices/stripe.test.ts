/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/** @jest-environment node */

const mockGetConn = jest.fn();
const mockDbQuery = jest.fn();
const mockCurrentStripeSite = jest.fn();
const mockGetConfiguredBayId = jest.fn();
const mockGetConfiguredClusterSeedBayId = jest.fn();
const mockGetInterBayBridge = jest.fn();
const mockEnqueueCommercialStripeEvent = jest.fn();
const mockCreateCommercialInvoiceIntent = jest.fn();
const mockGetCommercialInvoice = jest.fn();
const mockGetCommercialOrder = jest.fn();
const mockReserveCommercialProviderOperation = jest.fn();
const mockSetCommercialProviderOperationStatus = jest.fn();
const mockUpdateCommercialInvoiceProvider = jest.fn();
const mockRecordManualCommercialPayment = jest.fn();

jest.mock("@cocalc/server/stripe/connection", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetConn(...args),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: (...args: unknown[]) => mockDbQuery(...args) }),
}));

jest.mock("@cocalc/server/purchases/stripe/util", () => ({
  currentStripeSite: (...args: any[]) => mockCurrentStripeSite(...args),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: (...args: any[]) => mockGetConfiguredBayId(...args),
}));

jest.mock("@cocalc/server/cluster-config", () => ({
  getConfiguredClusterSeedBayId: (...args: any[]) =>
    mockGetConfiguredClusterSeedBayId(...args),
}));

jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  getInterBayBridge: (...args: any[]) => mockGetInterBayBridge(...args),
}));

jest.mock("../reconcile", () => ({
  enqueueCommercialStripeEvent: (...args: any[]) =>
    mockEnqueueCommercialStripeEvent(...args),
}));

jest.mock("../store", () => ({
  commercialIdempotencyKey: (operation: string) => `${operation}:key`,
  createCommercialInvoiceIntent: (...args: any[]) =>
    mockCreateCommercialInvoiceIntent(...args),
  getCommercialInvoice: (...args: any[]) => mockGetCommercialInvoice(...args),
  getCommercialOrder: (...args: any[]) => mockGetCommercialOrder(...args),
  normalizeInvoiceRow: jest.fn(),
  recordManualCommercialPayment: (...args: any[]) =>
    mockRecordManualCommercialPayment(...args),
  reserveCommercialProviderOperation: (...args: any[]) =>
    mockReserveCommercialProviderOperation(...args),
  setCommercialProviderOperationStatus: (...args: any[]) =>
    mockSetCommercialProviderOperationStatus(...args),
  updateCommercialInvoiceProvider: (...args: any[]) =>
    mockUpdateCommercialInvoiceProvider(...args),
}));

import type {
  CommercialInvoice,
  CommercialOrder,
} from "@cocalc/util/commercial-orders";
import {
  acceptCommercialStripeWebhookEvent,
  createStripeCommercialInvoiceDraft,
  findUnlinkedCommercialStripeInvoices,
  linkExistingStripeCommercialInvoice,
  reconcileStripeCommercialInvoice,
  recordStripeAwareCommercialManualPayment,
  sendStripeCommercialInvoice,
} from "./stripe";

const SITE = "test.cocalc.ai";

// Linking an already-prepared Stripe invoice checks its due date against
// `now + payment_terms_days` (dueAt() in ./stripe), because at that point no
// local invoice with a stored due_at exists yet.  These fixtures therefore
// have to move with the clock: the hard-coded date they used before only
// matched on the day it was written, and the suite failed every day after.
const PAYMENT_TERMS_DAYS = 30;
const DUE_DATE = (() => {
  const due = new Date();
  due.setUTCDate(due.getUTCDate() + PAYMENT_TERMS_DAYS);
  due.setUTCHours(0, 0, 0, 0);
  return Math.floor(due.getTime() / 1000);
})();
// the stored due_at of an already-created invoice, which the exact-match paths
// compare against DUE_DATE
const DUE_AT = new Date(DUE_DATE * 1000).toISOString();

function customerFixture(changes: Record<string, unknown> = {}) {
  return {
    id: "cus_1",
    deleted: false,
    name: "Example University",
    email: "ap@example.edu",
    metadata: {
      flow: "commercial_order",
      commercial_organization_key: "example university",
      commercial_organization_name: "Example University",
      cocalc_site: SITE,
    },
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
    provider_customer_id: "cus_1",
    provider_invoice_id: "in_1",
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
    idempotency_key: "invoice-intent",
    provider_snapshot: {},
    created_at: "2026-08-23T00:00:00.000Z",
    updated_at: "2026-08-23T00:00:00.000Z",
    ...changes,
  };
}

function orderFixture(changes: Partial<CommercialOrder> = {}): CommercialOrder {
  const invoice = invoiceFixture();
  return {
    id: "co_1",
    order_number: "AR-2026-000001",
    organization_name: "Example University",
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
    payment_terms_days: PAYMENT_TERMS_DAYS,
    terms_snapshot: {},
    next_action: "Send invoice",
    approved_at: "2026-08-23T00:00:00.000Z",
    approved_by_account_id: "admin-1",
    created_by_account_id: "admin-1",
    created_at: "2026-08-23T00:00:00.000Z",
    updated_at: "2026-08-23T00:00:00.000Z",
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
        metadata: {},
        created_at: "2026-08-23T00:00:00.000Z",
        updated_at: "2026-08-23T00:00:00.000Z",
      },
    ],
    contacts: [
      {
        id: "contact_1",
        commercial_order_id: "co_1",
        role: "billing",
        name_snapshot: "Accounts Payable",
        email_snapshot: "ap@example.edu",
        created_at: "2026-08-23T00:00:00.000Z",
        updated_at: "2026-08-23T00:00:00.000Z",
      },
    ],
    invoices: [],
    payments: [],
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
    custom_fields: [],
    description: "Example University: AR-2026-000001",
    automatic_tax: { enabled: false },
    payment_settings: {
      payment_method_types: ["card", "us_bank_account"],
    },
    subtotal: 390000,
    total: 390000,
    total_taxes: [],
    amount_due: 390000,
    amount_remaining: 390000,
    amount_paid: 0,
    due_date: DUE_DATE,
    hosted_invoice_url: null,
    invoice_pdf: null,
    metadata: {
      flow: "commercial_order",
      commercial_order_id: "co_1",
      commercial_invoice_id: "ci_1",
      order_number: "AR-2026-000001",
      cocalc_site: SITE,
    },
    payments: { data: [] },
    status_transitions: {},
    ...changes,
  };
}

describe("commercial Stripe invoices", () => {
  const stripe = {
    publishable_key: "pk_test_123",
    customers: {
      create: jest.fn(),
      retrieve: jest.fn(),
      search: jest.fn(),
    },
    invoiceItems: {
      create: jest.fn(),
    },
    invoices: {
      create: jest.fn(),
      finalizeInvoice: jest.fn(),
      listLineItems: jest.fn(),
      pay: jest.fn(),
      retrieve: jest.fn(),
      search: jest.fn(),
      sendInvoice: jest.fn(),
      update: jest.fn(),
    },
  };

  beforeEach(() => {
    jest.resetAllMocks();
    const order = orderFixture();
    const invoice = invoiceFixture();
    const stripeInvoice = stripeInvoiceFixture();
    mockGetConn.mockResolvedValue(stripe);
    mockDbQuery.mockResolvedValue({ rows: [] });
    mockCurrentStripeSite.mockResolvedValue(SITE);
    mockGetConfiguredBayId.mockReturnValue("seed-bay");
    mockGetConfiguredClusterSeedBayId.mockReturnValue("seed-bay");
    mockGetCommercialOrder.mockResolvedValue(order);
    mockGetCommercialInvoice.mockResolvedValue(invoice);
    mockCreateCommercialInvoiceIntent.mockResolvedValue({ order, invoice });
    mockReserveCommercialProviderOperation.mockResolvedValue({
      operation: { id: "op_1", status: "pending" },
    });
    mockSetCommercialProviderOperationStatus.mockResolvedValue(undefined);
    mockUpdateCommercialInvoiceProvider.mockResolvedValue({
      ...order,
      collection_state: "draft_invoice",
      invoices: [invoiceFixture({ status: "draft" })],
    });
    mockRecordManualCommercialPayment.mockResolvedValue({
      ...order,
      collection_state: "paid",
    });
    mockEnqueueCommercialStripeEvent.mockResolvedValue(undefined);
    stripe.customers.create.mockResolvedValue(customerFixture());
    stripe.customers.retrieve.mockResolvedValue(customerFixture());
    stripe.customers.search.mockResolvedValue({ data: [] });
    stripe.invoices.create.mockResolvedValue(stripeInvoice);
    stripe.invoiceItems.create.mockResolvedValue({ id: "ii_1" });
    stripe.invoices.retrieve.mockResolvedValue(stripeInvoice);
    stripe.invoices.pay.mockResolvedValue(
      stripeInvoiceFixture({
        status: "paid",
        amount_due: 390000,
        amount_remaining: 0,
        amount_paid: 390000,
      }),
    );
    stripe.invoices.search.mockResolvedValue({ data: [] });
    stripe.invoices.update.mockImplementation(
      async (_id: string, changes: Record<string, unknown>) =>
        stripeInvoiceFixture(changes),
    );
    stripe.invoices.listLineItems.mockResolvedValue({
      data: [
        {
          amount: 390000,
          currency: "usd",
          description: "Campus adoption pilot",
          metadata: { commercial_order_item_id: "item_1" },
        },
      ],
    });
  });

  it("creates a Stripe draft with stable metadata and idempotency keys", async () => {
    stripe.invoices.listLineItems.mockResolvedValueOnce({ data: [] });

    await createStripeCommercialInvoiceDraft({
      id: "co_1",
      account_id: "admin-1",
      expected_version: 4,
      reason: "Customer accepted the pilot",
      source: "admin-ui",
    });

    expect(stripe.invoices.create).toHaveBeenCalledWith(
      expect.objectContaining({
        auto_advance: false,
        collection_method: "send_invoice",
        customer: "cus_1",
        due_date: DUE_DATE,
        payment_settings: {
          payment_method_types: ["card", "us_bank_account"],
        },
        metadata: expect.objectContaining({
          flow: "commercial_order",
          commercial_order_id: "co_1",
          commercial_invoice_id: "ci_1",
          cocalc_site: SITE,
        }),
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringContaining(
          ":commercial-invoice:ci_1:v1:invoice",
        ),
      }),
    );
    expect(stripe.invoiceItems.create).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 390000,
        invoice: "in_1",
        metadata: {
          commercial_order_item_id: "item_1",
          product_kind: "site_license",
        },
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringContaining(":item:item_1"),
      }),
    );
    expect(mockUpdateCommercialInvoiceProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        invoice_id: "ci_1",
        provider_invoice_id: "in_1",
        status: "draft",
        collection_state: "draft_invoice",
        event_type: "invoice-draft-created",
      }),
    );
    expect(mockSetCommercialProviderOperationStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "op_1", status: "succeeded" }),
    );
  });

  it("reports only unlinked invoices from the exact commercial Stripe flow", async () => {
    stripe.invoices.search.mockResolvedValue({
      data: [
        stripeInvoiceFixture({ id: "in_linked", created: 1787529600 }),
        stripeInvoiceFixture({ id: "in_unlinked", created: 1787529700 }),
      ],
      has_more: false,
    });
    mockDbQuery.mockResolvedValue({
      rows: [{ provider_invoice_id: "in_linked" }],
    });

    await expect(findUnlinkedCommercialStripeInvoices()).resolves.toEqual({
      invoices: [
        expect.objectContaining({
          provider_invoice_id: "in_unlinked",
          status: "draft",
          currency: "usd",
          amount_due: "3900.0000000000",
          commercial_order_id: "co_1",
          commercial_invoice_id: "ci_1",
          order_number: "AR-2026-000001",
        }),
      ],
      truncated: false,
    });
    expect(stripe.invoices.search).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining("metadata['flow']:'commercial_order'"),
        limit: 100,
      }),
    );
  });

  it("fails closed when Stripe draft metadata does not identify the internal invoice", async () => {
    stripe.invoices.listLineItems.mockResolvedValueOnce({ data: [] });
    stripe.invoices.retrieve.mockResolvedValue(
      stripeInvoiceFixture({
        metadata: {
          flow: "commercial_order",
          commercial_order_id: "co_other",
          commercial_invoice_id: "ci_1",
          cocalc_site: SITE,
        },
      }),
    );

    await expect(
      createStripeCommercialInvoiceDraft({
        id: "co_1",
        account_id: "admin-1",
        expected_version: 4,
        reason: "Customer accepted the pilot",
      }),
    ).rejects.toThrow("metadata does not match");

    expect(mockUpdateCommercialInvoiceProvider).not.toHaveBeenCalled();
    expect(mockSetCommercialProviderOperationStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "op_1", status: "indeterminate" }),
    );
  });

  it("fails closed when multiple Stripe invoices claim the same internal invoice", async () => {
    stripe.invoices.search.mockResolvedValue({
      data: [stripeInvoiceFixture(), stripeInvoiceFixture({ id: "in_2" })],
    });

    await expect(
      createStripeCommercialInvoiceDraft({
        id: "co_1",
        account_id: "admin-1",
        expected_version: 4,
        reason: "Customer accepted the pilot",
      }),
    ).rejects.toThrow("multiple Stripe invoices reference ci_1");

    expect(stripe.invoices.create).not.toHaveBeenCalled();
    expect(mockUpdateCommercialInvoiceProvider).not.toHaveBeenCalled();
  });

  it("recovers a creating invoice after a timeout without creating another Stripe invoice", async () => {
    const creating = invoiceFixture({
      idempotency_key: "invoice-draft:key",
      provider_customer_id: null,
      provider_invoice_id: null,
    });
    const items = [
      {
        ...orderFixture().items[0],
        id: "item_1",
        description: "Pilot phase one",
        unit_amount: "1000.0000000000",
        subtotal: "1000.0000000000",
      },
      {
        ...orderFixture().items[0],
        id: "item_2",
        position: 1,
        description: "Pilot phase two",
        unit_amount: "2900.0000000000",
        subtotal: "2900.0000000000",
      },
    ];
    const order = orderFixture({
      collection_state: "draft_invoice",
      invoices: [creating],
      items,
    });
    const partial = stripeInvoiceFixture({
      subtotal: 100000,
      total: 100000,
      amount_due: 100000,
      amount_remaining: 100000,
    });
    mockGetCommercialOrder.mockResolvedValue(order);
    stripe.invoices.search.mockResolvedValue({ data: [partial] });
    stripe.invoices.listLineItems.mockResolvedValueOnce({
      data: [
        {
          id: "il_1",
          amount: 100000,
          currency: "usd",
          description: "Pilot phase one",
          metadata: { commercial_order_item_id: "item_1" },
        },
      ],
    });
    stripe.invoices.retrieve.mockResolvedValue(stripeInvoiceFixture());

    await createStripeCommercialInvoiceDraft({
      id: "co_1",
      account_id: "admin-1",
      expected_version: 4,
      reason: "Retry invoice creation after Stripe timed out",
    });

    expect(mockCreateCommercialInvoiceIntent).not.toHaveBeenCalled();
    expect(stripe.invoices.create).not.toHaveBeenCalled();
    expect(stripe.invoiceItems.create).toHaveBeenCalledTimes(1);
    expect(stripe.invoiceItems.create).toHaveBeenCalledWith(
      expect.objectContaining({
        invoice: "in_1",
        amount: 290000,
        description: "Pilot phase two",
        metadata: expect.objectContaining({
          commercial_order_item_id: "item_2",
        }),
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringContaining(":item:item_2"),
      }),
    );
    expect(mockUpdateCommercialInvoiceProvider).toHaveBeenCalled();
  });

  it("returns the prior result when a completed draft command is replayed", async () => {
    const invoice = invoiceFixture({
      status: "draft",
      idempotency_key: "invoice-draft:key",
    });
    const order = orderFixture({
      collection_state: "draft_invoice",
      invoices: [invoice],
    });
    mockGetCommercialOrder.mockResolvedValue(order);

    await expect(
      createStripeCommercialInvoiceDraft({
        id: "co_1",
        account_id: "admin-1",
        expected_version: 4,
        reason: "Customer accepted the pilot",
      }),
    ).resolves.toBe(order);

    expect(mockCreateCommercialInvoiceIntent).not.toHaveBeenCalled();
    expect(stripe.invoices.search).not.toHaveBeenCalled();
    expect(stripe.invoices.create).not.toHaveBeenCalled();
  });

  it("links only an invoice explicitly prepared for the exact commercial order", async () => {
    const prepared = stripeInvoiceFixture({
      metadata: {
        flow: "commercial_order",
        commercial_order_id: "co_1",
        order_number: "AR-2026-000001",
        cocalc_site: SITE,
      },
    });
    stripe.invoices.retrieve
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce(stripeInvoiceFixture());

    await linkExistingStripeCommercialInvoice({
      id: "co_1",
      provider_invoice_id: "in_1",
      account_id: "admin-1",
      expected_version: 4,
      reason: "Link the reviewed institutional invoice",
    });

    expect(mockCreateCommercialInvoiceIntent).toHaveBeenCalledTimes(1);
    expect(stripe.invoices.update).toHaveBeenCalledWith(
      "in_1",
      expect.objectContaining({
        metadata: expect.objectContaining({
          flow: "commercial_order",
          commercial_order_id: "co_1",
          commercial_invoice_id: "ci_1",
          order_number: "AR-2026-000001",
          cocalc_site: SITE,
        }),
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringContaining(":metadata"),
      }),
    );
    expect(mockUpdateCommercialInvoiceProvider).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: "existing-invoice-linked" }),
    );
  });

  it("rejects an ordinary Stripe invoice before creating a local intent", async () => {
    stripe.invoices.retrieve.mockResolvedValue(
      stripeInvoiceFixture({
        metadata: {
          purchase_id: "purchase_1",
          cocalc_site: SITE,
        },
      }),
    );

    await expect(
      linkExistingStripeCommercialInvoice({
        id: "co_1",
        provider_invoice_id: "in_1",
        account_id: "admin-1",
        expected_version: 4,
        reason: "Link the reviewed institutional invoice",
      }),
    ).rejects.toThrow("explicitly prepared for this commercial order");

    expect(mockCreateCommercialInvoiceIntent).not.toHaveBeenCalled();
    expect(mockReserveCommercialProviderOperation).not.toHaveBeenCalled();
  });

  it("rejects a prepared invoice with unsafe delivery settings", async () => {
    stripe.invoices.retrieve.mockResolvedValue(
      stripeInvoiceFixture({
        auto_advance: true,
        metadata: {
          flow: "commercial_order",
          commercial_order_id: "co_1",
          order_number: "AR-2026-000001",
          cocalc_site: SITE,
        },
      }),
    );

    await expect(
      linkExistingStripeCommercialInvoice({
        id: "co_1",
        provider_invoice_id: "in_1",
        account_id: "admin-1",
        expected_version: 4,
        reason: "Link the reviewed institutional invoice",
      }),
    ).rejects.toThrow("auto_advance");

    expect(mockCreateCommercialInvoiceIntent).not.toHaveBeenCalled();
  });

  it.each([
    [
      "customer",
      stripeInvoiceFixture({
        customer: "cus_other",
        metadata: {
          flow: "commercial_order",
          commercial_order_id: "co_1",
          order_number: "AR-2026-000001",
          cocalc_site: SITE,
        },
      }),
      "customer does not match",
    ],
    [
      "line items",
      stripeInvoiceFixture({
        metadata: {
          flow: "commercial_order",
          commercial_order_id: "co_1",
          order_number: "AR-2026-000001",
          cocalc_site: SITE,
        },
      }),
      "line items no longer match",
    ],
  ])(
    "rejects a prepared invoice with mismatched %s before creating a local intent",
    async (kind, prepared, expectedError) => {
      if (kind === "line items") {
        stripe.invoices.listLineItems.mockResolvedValue({
          data: [
            {
              amount: 390001,
              currency: "usd",
              description: "Campus adoption pilot",
              metadata: { commercial_order_item_id: "item_1" },
            },
          ],
        });
      }
      stripe.invoices.retrieve.mockResolvedValue(prepared);

      await expect(
        linkExistingStripeCommercialInvoice({
          id: "co_1",
          provider_invoice_id: "in_1",
          account_id: "admin-1",
          expected_version: 4,
          reason: "Link the reviewed institutional invoice",
        }),
      ).rejects.toThrow(expectedError as string);

      expect(mockCreateCommercialInvoiceIntent).not.toHaveBeenCalled();
    },
  );

  it("replays a creating link intent without rejecting its active invoice", async () => {
    const creating = invoiceFixture({ idempotency_key: "invoice-link:key" });
    const order = orderFixture({
      collection_state: "draft_invoice",
      invoices: [creating],
    });
    mockGetCommercialOrder.mockResolvedValue(order);
    stripe.invoices.retrieve.mockResolvedValue(stripeInvoiceFixture());

    await linkExistingStripeCommercialInvoice({
      id: "co_1",
      provider_invoice_id: "in_1",
      account_id: "admin-1",
      expected_version: 4,
      reason: "Retry the reviewed invoice link",
    });

    expect(mockCreateCommercialInvoiceIntent).not.toHaveBeenCalled();
    expect(mockReserveCommercialProviderOperation).toHaveBeenCalledTimes(1);
  });

  it("rejects a reused Stripe customer with stale billing details", async () => {
    stripe.customers.retrieve.mockResolvedValue(
      customerFixture({ email: "former-contact@example.edu" }),
    );

    await expect(
      createStripeCommercialInvoiceDraft({
        id: "co_1",
        account_id: "admin-1",
        expected_version: 4,
        reason: "Customer accepted the pilot",
      }),
    ).rejects.toThrow("email does not match");

    expect(stripe.invoices.create).not.toHaveBeenCalled();
  });

  it("reuses one exact organization customer instead of creating a duplicate", async () => {
    const invoice = invoiceFixture({
      provider_customer_id: null,
      provider_invoice_id: null,
    });
    const order = orderFixture({ stripe_customer_id: null });
    mockGetCommercialOrder.mockResolvedValue(order);
    mockCreateCommercialInvoiceIntent.mockResolvedValue({ order, invoice });
    stripe.customers.search.mockResolvedValue({ data: [customerFixture()] });
    stripe.invoices.listLineItems.mockResolvedValueOnce({ data: [] });

    await createStripeCommercialInvoiceDraft({
      id: "co_1",
      account_id: "admin-1",
      expected_version: 4,
      reason: "Customer accepted the pilot",
    });

    expect(stripe.customers.search).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining(
          "commercial_organization_key']:'example university'",
        ),
      }),
    );
    expect(stripe.customers.create).not.toHaveBeenCalled();
    expect(stripe.invoices.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_1" }),
      expect.anything(),
    );
  });

  it("finalizes and sends only a draft that still matches the approved order", async () => {
    const invoice = invoiceFixture({ status: "draft" });
    const order = orderFixture({ invoices: [invoice] });
    const finalized = stripeInvoiceFixture({
      status: "open",
      hosted_invoice_url: null,
    });
    const sent = stripeInvoiceFixture({
      status: "open",
      hosted_invoice_url: "https://invoice.test/in_1",
      status_transitions: { finalized_at: 1787529600 },
    });
    mockGetCommercialOrder.mockResolvedValue(order);
    mockGetCommercialInvoice.mockResolvedValue(invoice);
    stripe.invoices.retrieve.mockResolvedValue(stripeInvoiceFixture());
    stripe.invoices.finalizeInvoice.mockResolvedValue(finalized);
    stripe.invoices.sendInvoice.mockResolvedValue(sent);

    await sendStripeCommercialInvoice({
      id: "co_1",
      commercial_invoice_id: "ci_1",
      account_id: "admin-1",
      expected_version: 4,
      reason: "Send approved invoice",
    });

    expect(stripe.invoices.listLineItems).toHaveBeenCalledWith("in_1", {
      limit: 100,
    });
    expect(stripe.invoices.finalizeInvoice).toHaveBeenCalledWith(
      "in_1",
      expect.objectContaining({ auto_advance: false }),
      expect.objectContaining({ idempotencyKey: "invoice-send:key:finalize" }),
    );
    expect(stripe.invoices.sendInvoice).toHaveBeenCalledWith(
      "in_1",
      expect.anything(),
      expect.objectContaining({ idempotencyKey: "invoice-send:key:send" }),
    );
    expect(mockUpdateCommercialInvoiceProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "open",
        hosted_invoice_url: "https://invoice.test/in_1",
        event_type: "invoice-sent",
      }),
    );
  });

  it("rejects finalization when the Stripe recipient no longer matches", async () => {
    const invoice = invoiceFixture({ status: "draft" });
    const order = orderFixture({ invoices: [invoice] });
    mockGetCommercialOrder.mockResolvedValue(order);
    mockGetCommercialInvoice.mockResolvedValue(invoice);
    stripe.customers.retrieve.mockResolvedValue(
      customerFixture({ name: "Different University" }),
    );

    await expect(
      sendStripeCommercialInvoice({
        id: "co_1",
        commercial_invoice_id: "ci_1",
        account_id: "admin-1",
        expected_version: 4,
        reason: "Send approved invoice",
      }),
    ).rejects.toThrow("name does not match");

    expect(stripe.invoices.finalizeInvoice).not.toHaveBeenCalled();
    expect(stripe.invoices.sendInvoice).not.toHaveBeenCalled();
  });

  it("rejects finalization when Stripe delivery settings have drifted", async () => {
    const invoice = invoiceFixture({ status: "draft" });
    const order = orderFixture({ invoices: [invoice] });
    mockGetCommercialOrder.mockResolvedValue(order);
    mockGetCommercialInvoice.mockResolvedValue(invoice);
    stripe.invoices.retrieve.mockResolvedValue(
      stripeInvoiceFixture({ collection_method: "charge_automatically" }),
    );

    await expect(
      sendStripeCommercialInvoice({
        id: "co_1",
        commercial_invoice_id: "ci_1",
        account_id: "admin-1",
        expected_version: 4,
        reason: "Send approved invoice",
      }),
    ).rejects.toThrow("collection method");

    expect(stripe.invoices.finalizeInvoice).not.toHaveBeenCalled();
  });

  it.each([
    ["automatic advancement", { auto_advance: true }, "auto_advance"],
    ["due date", { due_date: DUE_DATE + 86_400 }, "due terms"],
    [
      "custom reference",
      { custom_fields: [{ name: "PO number", value: "wrong" }] },
      "custom fields",
    ],
    ["description", { description: "Wrong invoice" }, "description"],
    [
      "order metadata",
      {
        metadata: {
          ...stripeInvoiceFixture().metadata,
          order_number: "AR-OTHER",
        },
      },
      "order reference",
    ],
    ["tax", { automatic_tax: { enabled: true } }, "tax configuration"],
    [
      "payment methods",
      { payment_settings: { payment_method_types: ["card"] } },
      "payment settings",
    ],
  ])(
    "rejects finalization when the Stripe %s setting has drifted",
    async (_label, changes, expectedError) => {
      const invoice = invoiceFixture({ status: "draft" });
      const order = orderFixture({ invoices: [invoice] });
      mockGetCommercialOrder.mockResolvedValue(order);
      mockGetCommercialInvoice.mockResolvedValue(invoice);
      stripe.invoices.retrieve.mockResolvedValue(
        stripeInvoiceFixture(changes as Record<string, unknown>),
      );

      await expect(
        sendStripeCommercialInvoice({
          id: "co_1",
          commercial_invoice_id: "ci_1",
          account_id: "admin-1",
          expected_version: 4,
          reason: "Send approved invoice",
        }),
      ).rejects.toThrow(expectedError as string);

      expect(stripe.invoices.finalizeInvoice).not.toHaveBeenCalled();
    },
  );

  it("rejects reconciliation across Stripe test/live modes before updating state", async () => {
    const invoice = invoiceFixture({ status: "open" });
    mockGetCommercialInvoice.mockResolvedValue(invoice);
    stripe.invoices.retrieve.mockResolvedValue(
      stripeInvoiceFixture({ status: "paid", livemode: true }),
    );

    await expect(
      reconcileStripeCommercialInvoice({
        id: "co_1",
        commercial_invoice_id: "ci_1",
        reason: "Reconcile Stripe invoice",
      }),
    ).rejects.toThrow("mode does not match");

    expect(mockUpdateCommercialInvoiceProvider).not.toHaveBeenCalled();
  });

  it("fails closed when the provider amount differs from the approved order", async () => {
    const invoice = invoiceFixture({ status: "open" });
    mockGetCommercialInvoice.mockResolvedValue(invoice);
    stripe.invoices.retrieve.mockResolvedValue(
      stripeInvoiceFixture({ status: "paid", total: 390001 }),
    );

    await expect(
      reconcileStripeCommercialInvoice({
        id: "co_1",
        commercial_invoice_id: "ci_1",
        reason: "Verify the provider state",
      }),
    ).rejects.toThrow("total does not match");
    expect(mockUpdateCommercialInvoiceProvider).not.toHaveBeenCalled();
  });

  it("does not turn Stripe's unpaid invoice-payment placeholder into a payment", async () => {
    const invoice = invoiceFixture({ status: "open" });
    mockGetCommercialInvoice.mockResolvedValue(invoice);
    stripe.invoices.retrieve.mockResolvedValue(
      stripeInvoiceFixture({
        status: "open",
        payments: {
          data: [
            {
              id: "inpay_pending",
              amount_paid: null,
              amount_requested: 390000,
              created: 1787529500,
              status: "open",
              status_transitions: { paid_at: null },
              payment: {
                type: "payment_intent",
                payment_intent: {
                  id: "pi_pending",
                  status: "requires_payment_method",
                  payment_method_types: ["card", "us_bank_account"],
                },
              },
            },
          ],
        },
      }),
    );

    await reconcileStripeCommercialInvoice({
      id: "co_1",
      commercial_invoice_id: "ci_1",
      reason: "Reconcile unpaid Stripe invoice",
    });

    expect(mockUpdateCommercialInvoiceProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        provider_payments: [],
        skip_if_unchanged: true,
        provider_snapshot: expect.objectContaining({
          payments: [
            expect.objectContaining({
              id: "inpay_pending",
              status: "open",
              payment_intent_status: "requires_payment_method",
            }),
          ],
        }),
      }),
    );
  });

  it("reconciles paid amounts and provider payments without account credit", async () => {
    const invoice = invoiceFixture({ status: "open" });
    mockGetCommercialInvoice.mockResolvedValue(invoice);
    stripe.invoices.retrieve.mockResolvedValue(
      stripeInvoiceFixture({
        status: "paid",
        amount_due: 390000,
        amount_remaining: 0,
        amount_paid: 390000,
        status_transitions: { paid_at: 1787529600 },
        payments: {
          data: [
            {
              id: "inpay_1",
              amount_paid: 390000,
              status: "paid",
              status_transitions: { paid_at: 1787529600 },
              payment: {
                type: "payment_intent",
                payment_intent: {
                  id: "pi_1",
                  payment_method_types: ["card"],
                },
              },
            },
          ],
        },
      }),
    );

    await reconcileStripeCommercialInvoice({
      id: "co_1",
      commercial_invoice_id: "ci_1",
      reason: "Reconcile Stripe invoice",
      event_source: "stripe-webhook",
      event_idempotency_key: "evt_1",
    });

    expect(mockUpdateCommercialInvoiceProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        amount_due: "0.0000000000",
        amount_paid: "3900.0000000000",
        collection_state: "paid",
        event_source: "stripe-webhook",
        event_idempotency_key: "evt_1",
        provider_payments: [
          expect.objectContaining({
            id: "inpay_1",
            amount: "3900.0000000000",
            method: "card",
            status: "succeeded",
          }),
        ],
      }),
    );
  });

  it("marks an open Stripe invoice paid out of band before recording manual evidence", async () => {
    const invoice = invoiceFixture({ status: "open" });
    const order = orderFixture({ invoices: [invoice] });
    const providerApplied = {
      ...order,
      version: 5,
      collection_state: "paid" as const,
    };
    mockGetCommercialOrder.mockResolvedValue(order);
    mockGetCommercialInvoice.mockResolvedValue(invoice);
    mockUpdateCommercialInvoiceProvider.mockResolvedValue(providerApplied);
    stripe.invoices.retrieve.mockResolvedValue(
      stripeInvoiceFixture({ status: "open" }),
    );

    await recordStripeAwareCommercialManualPayment({
      id: "co_1",
      account_id: "admin-1",
      expected_version: 4,
      amount: "3900",
      currency: "usd",
      method: "check",
      evidence_reference: "check-123",
      reason: "Check cleared at the bank",
    });

    expect(stripe.invoices.pay).toHaveBeenCalledWith(
      "in_1",
      { paid_out_of_band: true },
      expect.objectContaining({
        idempotencyKey: "manual-settlement-provider:key:pay-out-of-band",
      }),
    );
    expect(mockUpdateCommercialInvoiceProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        collection_state: "paid",
        provider_payments: [],
      }),
    );
    expect(mockRecordManualCommercialPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        expected_version: 5,
        evidence_reference: "check-123",
        idempotency_key: "manual-settlement-provider:key:manual-evidence",
      }),
    );
  });

  it("returns the prior result when manual Stripe settlement is replayed", async () => {
    const invoice = invoiceFixture({ status: "paid" });
    const order = orderFixture({
      collection_state: "paid",
      invoices: [invoice],
      payments: [
        {
          id: "payment_1",
          commercial_order_id: "co_1",
          commercial_invoice_id: "ci_1",
          provider: "manual",
          amount: "3900.0000000000",
          currency: "usd",
          status: "succeeded",
          received_at: "2026-08-23T00:00:00.000Z",
          method: "check",
          recorded_by_account_id: "admin-1",
          evidence_reference: "check-123",
          idempotency_key: "manual-settlement-provider:key:manual-evidence",
          created_at: "2026-08-23T00:00:00.000Z",
          updated_at: "2026-08-23T00:00:00.000Z",
        },
      ],
    });
    mockGetCommercialOrder.mockResolvedValue(order);

    await expect(
      recordStripeAwareCommercialManualPayment({
        id: "co_1",
        account_id: "admin-1",
        expected_version: 4,
        amount: "3900",
        currency: "usd",
        method: "check",
        evidence_reference: "check-123",
        reason: "Check cleared at the bank",
      }),
    ).resolves.toBe(order);

    expect(mockReserveCommercialProviderOperation).not.toHaveBeenCalled();
    expect(stripe.invoices.pay).not.toHaveBeenCalled();
    expect(mockRecordManualCommercialPayment).not.toHaveBeenCalled();
  });

  it("queues same-site commercial metadata and rejects foreign-site events", async () => {
    await expect(
      acceptCommercialStripeWebhookEvent({
        id: "evt_1",
        type: "invoice.paid",
        livemode: false,
        created: 1787529600,
        data: { object: stripeInvoiceFixture({ status: "paid" }) },
      }),
    ).resolves.toBe(true);

    expect(mockEnqueueCommercialStripeEvent).toHaveBeenCalledWith({
      event_id: "evt_1",
      event_type: "invoice.paid",
      livemode: false,
      commercial_order_id: "co_1",
      commercial_invoice_id: "ci_1",
      provider_invoice_id: "in_1",
      created: 1787529600,
    });

    mockEnqueueCommercialStripeEvent.mockClear();
    await expect(
      acceptCommercialStripeWebhookEvent({
        id: "evt_2",
        type: "invoice.paid",
        data: {
          object: stripeInvoiceFixture({
            metadata: {
              flow: "commercial_order",
              cocalc_site: SITE,
            },
          }),
        },
      }),
    ).resolves.toBe(true);
    expect(mockEnqueueCommercialStripeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_id: "evt_2",
        commercial_order_id: undefined,
      }),
    );
    mockEnqueueCommercialStripeEvent.mockClear();
    await expect(
      acceptCommercialStripeWebhookEvent({
        id: "evt_3",
        type: "invoice.paid",
        data: {
          object: stripeInvoiceFixture({
            metadata: {
              flow: "commercial_order",
              commercial_order_id: "co_1",
              commercial_invoice_id: "ci_1",
              cocalc_site: "other.cocalc.ai",
            },
          }),
        },
      }),
    ).resolves.toBe(false);
    expect(mockEnqueueCommercialStripeEvent).not.toHaveBeenCalled();

    await expect(
      acceptCommercialStripeWebhookEvent({
        id: "evt_4",
        type: "invoice.paid",
        data: {
          object: stripeInvoiceFixture({
            metadata: {
              flow: "commercial_order",
              commercial_order_id: "co_1",
              commercial_invoice_id: "ci_1",
            },
          }),
        },
      }),
    ).resolves.toBe(false);
    expect(mockEnqueueCommercialStripeEvent).not.toHaveBeenCalled();
  });

  it("routes accepted commercial webhooks from a non-seed bay to the seed", async () => {
    const commercialOrders = jest.fn().mockResolvedValue(undefined);
    const bayOps = jest.fn(() => ({ commercialOrders }));
    mockGetConfiguredBayId.mockReturnValue("worker-bay");
    mockGetInterBayBridge.mockReturnValue({ bayOps });

    await expect(
      acceptCommercialStripeWebhookEvent({
        id: "evt_remote",
        type: "invoice.updated",
        livemode: false,
        data: { object: stripeInvoiceFixture() },
      }),
    ).resolves.toBe(true);

    expect(bayOps).toHaveBeenCalledWith("seed-bay", { timeout_ms: 30_000 });
    expect(commercialOrders).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "stripeWebhook",
        actor_account_id: "00000000-0000-0000-0000-000000000000",
        payload: expect.objectContaining({ event_id: "evt_remote" }),
      }),
    );
    expect(mockEnqueueCommercialStripeEvent).not.toHaveBeenCalled();
  });
});
