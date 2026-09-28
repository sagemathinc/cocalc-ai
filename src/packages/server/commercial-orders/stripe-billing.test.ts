/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

const mockGetOrder = jest.fn();
const mockAllowed = jest.fn();
const mockGetOperation = jest.fn();
const mockReserve = jest.fn();
const mockStatus = jest.fn();
const mockComplete = jest.fn();
const mockIdentity = jest.fn();
const mockStripe = {
  customers: { retrieve: jest.fn(), update: jest.fn() },
  invoices: { list: jest.fn() },
  subscriptions: { list: jest.fn() },
  quotes: { list: jest.fn() },
};
jest.mock("@cocalc/server/stripe/connection", () => ({
  __esModule: true,
  default: async () => mockStripe,
}));
jest.mock("@cocalc/server/purchases/stripe/util", () => ({
  currentStripeSite: async () => "billing.example.test",
}));
jest.mock("./invoices/stripe", () => ({
  approvedInvoiceTerms: (order) => order.terms_snapshot.invoice,
  assertCommercialStripeCustomerIdentity: (...args) => mockIdentity(...args),
}));
jest.mock("./store", () => ({
  getCommercialOrder: (...args) => mockGetOrder(...args),
  assertCommercialStripeBillingSyncAllowed: (...args) => mockAllowed(...args),
  getCommercialProviderOperationByIdempotencyKey: (...args) =>
    mockGetOperation(...args),
  reserveCommercialProviderOperation: (...args) => mockReserve(...args),
  setCommercialProviderOperationStatus: (...args) => mockStatus(...args),
  completeCommercialStripeBillingSync: (...args) => mockComplete(...args),
}));

import { stripeBillingPreview, syncStripeBilling } from "./stripe-billing";

const order = {
  id: "order-1",
  version: 7,
  stripe_customer_id: "cus_test",
  contacts: [{ role: "billing", email_snapshot: "ap@example.edu" }],
  terms_snapshot: {
    invoice: { billing_address: { line1: "Finance Office", country: "GB" } },
  },
};
const request = {
  id: order.id,
  account_id: "admin-1",
  reason: "correct institutional billing",
  expected_version: 7,
  idempotency_key: "sync-test",
};
let customer: any;

beforeEach(() => {
  jest.resetAllMocks();
  customer = {
    id: "cus_test",
    email: "teacher@example.edu",
    address: {
      line1: "Science Building",
      line2: "Old Room",
      state: "Old State",
      country: "GB",
    },
  };
  mockGetOrder.mockResolvedValue(order);
  mockAllowed.mockResolvedValue(undefined);
  mockGetOperation.mockResolvedValue(undefined);
  mockReserve.mockResolvedValue({
    operation: { id: "op-1", status: "reserved" },
  });
  mockComplete.mockResolvedValue({ ...order, version: 8 });
  mockStripe.customers.retrieve.mockImplementation(async () =>
    structuredClone(customer),
  );
  mockStripe.customers.update.mockImplementation(async (_id, params) => {
    customer = { ...customer, ...structuredClone(params) };
    return customer;
  });
  mockStripe.invoices.list.mockResolvedValue({ data: [] });
  mockStripe.quotes.list.mockResolvedValue({ data: [] });
  mockStripe.subscriptions.list.mockResolvedValue({
    data: [],
    has_more: false,
  });
});

it("previews without writes; commits only approved email/address and clears obsolete fields", async () => {
  const preview = await stripeBillingPreview(request);
  expect(preview).toMatchObject({
    changed: true,
    blockers: [],
    after: { email: "ap@example.edu", address: { line2: "", state: "" } },
  });
  expect(mockStripe.customers.update).not.toHaveBeenCalled();
  const result = await syncStripeBilling({
    ...request,
    preview_hash: preview.preview_hash,
  });
  expect(result.version).toBe(8);
  expect(mockStripe.customers.update).toHaveBeenCalledWith(
    "cus_test",
    preview.after,
    {
      idempotencyKey: `commercial-billing-sync:order-1:${preview.preview_hash}`,
    },
  );
  expect(mockIdentity).toHaveBeenCalledWith(
    expect.objectContaining({ id: "cus_test" }),
    order,
    "billing.example.test",
  );
  expect(mockComplete).toHaveBeenCalledWith("op-1");
});

it("rejects a changed Stripe preview before reserving or writing", async () => {
  const preview = await stripeBillingPreview(request);
  customer.email = "changed@example.edu";
  await expect(
    syncStripeBilling({ ...request, preview_hash: preview.preview_hash }),
  ).rejects.toThrow("preview changed");
  expect(mockReserve).not.toHaveBeenCalled();
  expect(mockStripe.customers.update).not.toHaveBeenCalled();
});

it("rejects stale order versions", async () => {
  const preview = await stripeBillingPreview(request);
  await expect(
    syncStripeBilling({
      ...request,
      expected_version: 6,
      preview_hash: preview.preview_hash,
    }),
  ).rejects.toThrow("preview changed");
  expect(mockReserve).not.toHaveBeenCalled();
});

it("fails closed on deleted/wrong-organization customers", async () => {
  mockIdentity.mockImplementation(() => {
    throw Error("customer identity mismatch");
  });
  await expect(stripeBillingPreview(request)).rejects.toThrow(
    "identity mismatch",
  );
  expect(mockStripe.customers.update).not.toHaveBeenCalled();
});

it.each(["shared customer", "active invoice", "unresolved provider operation"])(
  "blocks %s",
  async (message) => {
    mockAllowed.mockRejectedValue(Error(message));
    const preview = await stripeBillingPreview(request);
    expect(preview.blockers).toContain(message);
    await expect(
      syncStripeBilling({ ...request, preview_hash: preview.preview_hash }),
    ).rejects.toThrow(message);
    expect(mockReserve).not.toHaveBeenCalled();
  },
);

it("blocks Stripe-only invoices, quotes and subscriptions", async () => {
  mockStripe.invoices.list.mockResolvedValue({ data: [{ id: "in_unlinked" }] });
  mockStripe.quotes.list.mockResolvedValue({ data: [{ id: "qt_unlinked" }] });
  mockStripe.subscriptions.list.mockResolvedValue({
    data: [{ status: "active" }],
  });
  const preview = await stripeBillingPreview(request);
  expect(preview.blockers).toHaveLength(5);
  await expect(
    syncStripeBilling({ ...request, preview_hash: preview.preview_hash }),
  ).rejects.toThrow("invoice");
  expect(mockStripe.customers.update).not.toHaveBeenCalled();
});

it("reconciles a timed-out successful update without issuing another update", async () => {
  const preview = await stripeBillingPreview(request);
  preview.after = {
    address: Object.fromEntries(
      Object.entries(preview.after.address).reverse(),
    ),
    email: preview.after.email,
  };
  preview.before = {
    address: Object.fromEntries(
      Object.entries(preview.before.address).reverse(),
    ),
    email: preview.before.email,
  };
  mockStripe.customers.update.mockImplementationOnce(async (_id, params) => {
    customer = { ...customer, ...structuredClone(params) };
    throw Error("network timeout");
  });
  await expect(
    syncStripeBilling({ ...request, preview_hash: preview.preview_hash }),
  ).rejects.toThrow("timeout");
  expect(mockStatus).toHaveBeenLastCalledWith(
    expect.objectContaining({ status: "indeterminate" }),
  );
  mockGetOperation.mockResolvedValue({
    id: "op-1",
    operation: "sync-customer-billing",
    commercial_order_id: order.id,
    status: "indeterminate",
    request: { preview },
  });
  await syncStripeBilling({
    ...request,
    idempotency_key: "retry-command",
    preview_hash: preview.preview_hash,
  });
  expect(mockStripe.customers.update).toHaveBeenCalledTimes(1);
  expect(mockComplete).toHaveBeenCalledTimes(1);
});

it("does not overwrite an unrelated change while recovering", async () => {
  const preview = await stripeBillingPreview(request);
  mockGetOperation.mockResolvedValue({
    id: "op-1",
    operation: "sync-customer-billing",
    commercial_order_id: order.id,
    status: "indeterminate",
    request: { preview },
  });
  customer.email = "unreviewed@example.edu";
  await expect(
    syncStripeBilling({ ...request, preview_hash: preview.preview_hash }),
  ).rejects.toThrow("outside the reviewed operation");
  expect(mockStripe.customers.update).not.toHaveBeenCalled();
});

it("verifies no-op operations without updating Stripe", async () => {
  customer = { ...customer, ...(await stripeBillingPreview(request)).after };
  const preview = await stripeBillingPreview(request);
  expect(preview.changed).toBe(false);
  await syncStripeBilling({ ...request, preview_hash: preview.preview_hash });
  expect(mockStripe.customers.update).not.toHaveBeenCalled();
  expect(mockComplete).toHaveBeenCalledTimes(1);
});
