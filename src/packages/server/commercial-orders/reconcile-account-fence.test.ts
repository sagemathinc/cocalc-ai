/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

const queryMock = jest.fn();
const getCommercialOrderMock = jest.fn();
const getCommercialInvoiceMock = jest.fn();
const getStaleCommercialInvoiceIdsMock = jest.fn();
const getStaleCommercialQuoteIdsMock = jest.fn();
const reconcileInvoiceMock = jest.fn();
const reconcileQuoteMock = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: queryMock }),
}));

jest.mock("@cocalc/database/postgres/central-log", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "seed",
}));

jest.mock("@cocalc/server/cluster-config", () => ({
  getConfiguredClusterSeedBayId: () => "seed",
}));

jest.mock("@cocalc/server/stripe/connection", () => ({
  __esModule: true,
  default: async () => ({ publishable_key: "pk_test_authority" }),
}));

jest.mock("./store", () => ({
  getCommercialInvoice: (...args: unknown[]) =>
    getCommercialInvoiceMock(...args),
  getCommercialOrder: (...args: unknown[]) => getCommercialOrderMock(...args),
  getStaleCommercialInvoiceIds: (...args: unknown[]) =>
    getStaleCommercialInvoiceIdsMock(...args),
  getStaleCommercialQuoteIds: (...args: unknown[]) =>
    getStaleCommercialQuoteIdsMock(...args),
}));

jest.mock("./invoices/stripe", () => ({
  reconcileStripeCommercialInvoice: (...args: unknown[]) =>
    reconcileInvoiceMock(...args),
}));

jest.mock("./quotes/stripe", () => ({
  reconcileStripeCommercialQuoteById: (...args: unknown[]) =>
    reconcileQuoteMock(...args),
}));

jest.mock("./observability", () => ({
  recordCommercialReconciliation: jest.fn(),
  recordCommercialWebhookLatency: jest.fn(),
}));

import { runInBillingAuthorityContext } from "@cocalc/server/purchases/billing-authority/context";
import {
  reconcileStaleCommercialInvoices,
  reconcileStaleCommercialQuotes,
} from "./reconcile";

const ACCOUNT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ORDER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const INVOICE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const QUOTE_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

async function runWithFrozenAccount<T>(fn: () => Promise<T>): Promise<T> {
  return await runInBillingAuthorityContext({
    operation: "commercial-maintenance",
    request_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    register_account: async () => {
      throw Object.assign(new Error("billing is frozen for this account"), {
        status: 423,
      });
    },
    fn,
  });
}

describe("commercial reconciliation account fencing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getCommercialOrderMock.mockResolvedValue({
      id: ORDER_ID,
      customer_account_id: ACCOUNT_ID,
    });
    getCommercialInvoiceMock.mockResolvedValue({
      id: INVOICE_ID,
      commercial_order_id: ORDER_ID,
    });
    getStaleCommercialInvoiceIdsMock.mockResolvedValue([INVOICE_ID]);
    getStaleCommercialQuoteIdsMock.mockResolvedValue([QUOTE_ID]);
    reconcileInvoiceMock.mockResolvedValue({ id: ORDER_ID });
    reconcileQuoteMock.mockResolvedValue({ id: ORDER_ID });
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM commercial_invoices WHERE id=")) {
        return { rows: [{ commercial_order_id: ORDER_ID }] };
      }
      if (sql.includes("FROM commercial_quotes WHERE id=")) {
        return { rows: [{ commercial_order_id: ORDER_ID }] };
      }
      return { rows: [] };
    });
  });

  it("stops scheduled invoice reconciliation before its financial handler", async () => {
    await expect(
      runWithFrozenAccount(
        async () => await reconcileStaleCommercialInvoices({ limit: 1 }),
      ),
    ).resolves.toEqual({ reconciled: 0, failed: 1 });
    expect(reconcileInvoiceMock).not.toHaveBeenCalled();
  });

  it("stops scheduled quote reconciliation before its financial handler", async () => {
    await expect(
      runWithFrozenAccount(
        async () => await reconcileStaleCommercialQuotes({ limit: 1 }),
      ),
    ).resolves.toEqual({ reconciled: 0, failed: 1 });
    expect(reconcileQuoteMock).not.toHaveBeenCalled();
  });
});
