/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

const mockQuery = jest.fn();
const mockCentralLog = jest.fn();
const mockCapability = jest.fn();
const mockUpdateMetrics = jest.fn();
const mockDiagnostics = jest.fn();
const mockProcessWebhookQueue = jest.fn();
const mockReconcileInvoices = jest.fn();
const mockReconcileQuotes = jest.fn();
const mockBayId = jest.fn();
const mockSeedBayId = jest.fn();
const mockExecuteBillingAuthorityCommand = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: (...args: unknown[]) => mockQuery(...args) }),
}));

jest.mock("@cocalc/database/postgres/central-log", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockCentralLog(...args),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => mockBayId(),
}));

jest.mock("@cocalc/server/cluster-config", () => ({
  getConfiguredClusterSeedBayId: () => mockSeedBayId(),
}));

jest.mock("@cocalc/server/purchases/billing-authority/client", () => ({
  executeBillingAuthorityCommand: (...args: unknown[]) =>
    mockExecuteBillingAuthorityCommand(...args),
}));

jest.mock("./feature-flags", () => ({
  isCommercialReceivablesCapabilityEnabled: (...args: unknown[]) =>
    mockCapability(...args),
}));

jest.mock("./observability", () => ({
  updateCommercialQueueMetrics: (...args: unknown[]) =>
    mockUpdateMetrics(...args),
}));

jest.mock("./store", () => ({
  getCommercialOrderDiagnostics: (...args: unknown[]) =>
    mockDiagnostics(...args),
}));

jest.mock("./reconcile", () => ({
  processCommercialStripeEventQueue: (...args: unknown[]) =>
    mockProcessWebhookQueue(...args),
  reconcileStaleCommercialInvoices: (...args: unknown[]) =>
    mockReconcileInvoices(...args),
  reconcileStaleCommercialQuotes: (...args: unknown[]) =>
    mockReconcileQuotes(...args),
}));

import {
  runCommercialReceivablesMaintenanceOnceForTests,
  stopCommercialReceivablesMaintenanceForTests,
} from "./maintenance";
import { runCommercialReceivablesAuthorityTask } from "./maintenance-task";

describe("commercial receivables maintenance", () => {
  const diagnostics = {
    generated_at: "2026-08-23T00:00:00.000Z",
    counts: { open_orders: 2 },
    amounts: { open_amount: "6630.0000000000" },
    stale_invoice_ids: [],
    stale_quote_ids: [],
    inconsistent_order_ids: [],
    reconciliation: {
      provider_local_mismatch_count: 0,
      oldest_reconciliation_lag_seconds: 0,
    },
    review_queues: {
      truncated: {},
      active_commercial_site_license_ids: [],
      unlinked_commercial_stripe_invoices: [],
      failed_stripe_events: [],
      indeterminate_provider_operations: [],
      failed_stripe_event_ids: [],
      indeterminate_provider_operation_ids: [],
      open_orders_missing_due_date_ids: [],
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    stopCommercialReceivablesMaintenanceForTests();
    mockBayId.mockReturnValue("seed-bay");
    mockSeedBayId.mockReturnValue("seed-bay");
    mockCapability.mockResolvedValue(true);
    mockProcessWebhookQueue.mockResolvedValue({ processed: 1, failed: 0 });
    mockReconcileInvoices.mockResolvedValue({ reconciled: 2, failed: 0 });
    mockReconcileQuotes.mockResolvedValue({ reconciled: 3, failed: 0 });
    mockDiagnostics.mockResolvedValue(diagnostics);
    mockCentralLog.mockResolvedValue(undefined);
    mockExecuteBillingAuthorityCommand
      .mockReset()
      .mockImplementation(async (command) => {
        expect(command).toEqual({ kind: "commercial-maintenance" });
        return await runCommercialReceivablesAuthorityTask();
      });
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("RETURNING last_daily_digest_at")) {
        return { rows: [{ last_daily_digest_at: null }] };
      }
      return { rows: [] };
    });
  });

  afterEach(() => {
    stopCommercialReceivablesMaintenanceForTests();
  });

  it("processes one remote unit and records one durable daily digest", async () => {
    await runCommercialReceivablesMaintenanceOnceForTests();

    expect(mockProcessWebhookQueue).toHaveBeenCalledWith(1);
    expect(mockReconcileInvoices).not.toHaveBeenCalled();
    expect(mockReconcileQuotes).not.toHaveBeenCalled();
    expect(mockUpdateMetrics).toHaveBeenCalledWith(diagnostics);
    expect(mockCentralLog).toHaveBeenCalledWith({
      event: "commercial_receivables_maintenance",
      value: {
        webhook: { processed: 1, failed: 0, disabled: false },
        reconciliation: { reconciled: 0, failed: 0, disabled: true },
        quoteReconciliation: { reconciled: 0, failed: 0, disabled: true },
        diagnostics,
      },
    });
    expect(mockCentralLog).toHaveBeenCalledWith({
      event: "commercial_receivables_daily_digest",
      value: diagnostics,
    });
    expect(
      mockQuery.mock.calls.some(([sql]) =>
        `${sql}`.includes("last_daily_digest_at=CASE"),
      ),
    ).toBe(true);
  });

  it("probes each empty queue with a one-unit bound", async () => {
    mockProcessWebhookQueue.mockResolvedValue({ processed: 0, failed: 0 });
    mockReconcileInvoices.mockResolvedValue({ reconciled: 0, failed: 0 });
    mockReconcileQuotes.mockResolvedValue({ reconciled: 0, failed: 0 });

    await runCommercialReceivablesMaintenanceOnceForTests();

    expect(mockProcessWebhookQueue).toHaveBeenCalledWith(1);
    expect(mockReconcileInvoices).toHaveBeenCalledWith({ limit: 1 });
    expect(mockReconcileQuotes).toHaveBeenCalledWith({ limit: 1 });
  });

  it("does nothing outside the seed bay", async () => {
    mockBayId.mockReturnValue("worker-bay");

    await runCommercialReceivablesMaintenanceOnceForTests();

    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockProcessWebhookQueue).not.toHaveBeenCalled();
    expect(mockCentralLog).not.toHaveBeenCalled();
  });

  it("skips the daily digest when today was already recorded", async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("RETURNING last_daily_digest_at")) {
        return { rows: [{ last_daily_digest_at: new Date() }] };
      }
      return { rows: [] };
    });

    await runCommercialReceivablesMaintenanceOnceForTests();

    expect(
      mockCentralLog.mock.calls.filter(
        ([entry]) => entry.event === "commercial_receivables_daily_digest",
      ),
    ).toHaveLength(0);
  });
});
