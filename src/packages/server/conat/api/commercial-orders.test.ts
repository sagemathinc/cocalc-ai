/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/** @jest-environment node */

const mockCentralLog = jest.fn();
const mockIsAdmin = jest.fn();
const mockGetConfiguredBayId = jest.fn();
const mockGetConfiguredClusterSeedBayId = jest.fn();
const mockDispatchCommercialSeedRequest = jest.fn();
const mockAssertCommercialReceivablesCapability = jest.fn();
const mockRecordCommercialOperator = jest.fn();
const mockGetInterBayBridge = jest.fn();
const mockRequireDangerousSessionAuth = jest.fn();

jest.mock("@cocalc/database/postgres/central-log", () => ({
  __esModule: true,
  default: (...args: any[]) => mockCentralLog(...args),
}));

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: any[]) => mockIsAdmin(...args),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: (...args: any[]) => mockGetConfiguredBayId(...args),
}));

jest.mock("@cocalc/server/cluster-config", () => ({
  getConfiguredClusterSeedBayId: (...args: any[]) =>
    mockGetConfiguredClusterSeedBayId(...args),
}));

jest.mock("@cocalc/server/commercial-orders/dispatch", () => ({
  dispatchCommercialSeedRequest: (...args: any[]) =>
    mockDispatchCommercialSeedRequest(...args),
}));

jest.mock("@cocalc/server/commercial-orders/feature-flags", () => ({
  assertCommercialReceivablesCapability: (...args: any[]) =>
    mockAssertCommercialReceivablesCapability(...args),
}));

jest.mock("@cocalc/server/commercial-orders/observability", () => ({
  recordCommercialOperator: (...args: any[]) =>
    mockRecordCommercialOperator(...args),
}));

jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  getInterBayBridge: (...args: any[]) => mockGetInterBayBridge(...args),
}));

jest.mock("./dangerous-session-auth", () => ({
  requireDangerousSessionAuth: (...args: any[]) =>
    mockRequireDangerousSessionAuth(...args),
}));

import {
  approve,
  create,
  createPreview,
  createInvoiceDraft,
  issueManualInvoice,
  issueQuoteLink,
  revokeQuoteLink,
  list,
  listAssignees,
  provision,
  revise,
  retryStripeEvent,
  siteLicenseRevenueAnalytics,
} from "./commercial-orders";

const BASE = {
  account_id: "admin-1",
  browser_id: "browser-1",
  session_hash: "session-1",
  reason: "Handle accepted institutional order",
};

describe("commercial orders public Conat API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsAdmin.mockResolvedValue(true);
    mockGetConfiguredBayId.mockReturnValue("seed-bay");
    mockGetConfiguredClusterSeedBayId.mockReturnValue("seed-bay");
    mockDispatchCommercialSeedRequest.mockResolvedValue({ orders: [] });
    mockAssertCommercialReceivablesCapability.mockResolvedValue(undefined);
    mockCentralLog.mockResolvedValue(undefined);
    mockRequireDangerousSessionAuth.mockResolvedValue(undefined);
  });

  it("rejects unauthenticated and non-admin reads before seed dispatch", async () => {
    await expect(list({ reason: BASE.reason } as any)).rejects.toThrow(
      "must be signed in",
    );

    mockIsAdmin.mockResolvedValue(false);
    const failure = await list(BASE as any).catch((err) => err);
    expect(failure).toMatchObject({
      message: "admin privileges required",
      code: 403,
    });
    expect(mockDispatchCommercialSeedRequest).not.toHaveBeenCalled();
    expect(mockGetInterBayBridge).not.toHaveBeenCalled();
  });

  it.each([issueQuoteLink, revokeQuoteLink])(
    "requires fresh non-impersonated admin auth for link mutations",
    async (method) => {
      const opts = {
        ...BASE,
        id: "order",
        commercial_quote_id: "quote",
        expires_at: "2026-10-01",
      };
      mockIsAdmin.mockResolvedValue(false);
      await expect(method(opts as any)).rejects.toThrow("admin privileges");
      expect(mockDispatchCommercialSeedRequest).not.toHaveBeenCalled();
      mockIsAdmin.mockResolvedValue(true);
      mockRequireDangerousSessionAuth.mockRejectedValueOnce(
        Error("fresh auth required"),
      );
      await expect(method(opts as any)).rejects.toThrow("fresh auth");
      expect(mockDispatchCommercialSeedRequest).not.toHaveBeenCalled();
      await method(opts as any);
      expect(mockRequireDangerousSessionAuth).toHaveBeenCalledWith(
        expect.objectContaining({ allow_actor_impersonation: false }),
      );
      expect(mockAssertCommercialReceivablesCapability).toHaveBeenCalledWith(
        "mutate",
      );
    },
  );

  it("dispatches admin reads locally to the seed without session credentials", async () => {
    await list({
      ...BASE,
      search: "Example University",
      limit: 25,
    });

    expect(mockRequireDangerousSessionAuth).not.toHaveBeenCalled();
    expect(mockAssertCommercialReceivablesCapability).toHaveBeenCalledWith(
      "visible",
    );
    expect(mockDispatchCommercialSeedRequest).toHaveBeenCalledWith({
      action: "list",
      actor_account_id: "admin-1",
      payload: {
        reason: BASE.reason,
        search: "Example University",
        limit: 25,
        source: "admin-ui",
      },
    });
    expect(mockCentralLog).toHaveBeenCalledWith({
      event: "commercial_order_operator",
      value: expect.objectContaining({
        actor_account_id: "admin-1",
        action: "list",
        fresh_auth: false,
        ok: true,
      }),
    });
  });

  it("lists eligible assignees through the same audited seed authority", async () => {
    mockDispatchCommercialSeedRequest.mockResolvedValue([
      { account_id: "admin-1", display_name: "Admin One", is_admin: true },
    ]);

    const result = await listAssignees({
      ...BASE,
      reason: "List eligible receivables assignees",
    });

    expect(result).toEqual([
      { account_id: "admin-1", display_name: "Admin One", is_admin: true },
    ]);
    expect(mockRequireDangerousSessionAuth).not.toHaveBeenCalled();
    expect(mockDispatchCommercialSeedRequest).toHaveBeenCalledWith({
      action: "listAssignees",
      actor_account_id: "admin-1",
      payload: {
        reason: "List eligible receivables assignees",
        source: "admin-ui",
      },
    });
  });

  it("validates create previews as a read without fresh auth", async () => {
    mockDispatchCommercialSeedRequest.mockResolvedValue({
      normalized_request: { organization_name: "Example University" },
      approval_ready: false,
      approval_blockers: ["exactly one billing contact is required"],
    });

    await createPreview({
      ...BASE,
      organization_name: "Example University",
    } as any);

    expect(mockRequireDangerousSessionAuth).not.toHaveBeenCalled();
    expect(mockAssertCommercialReceivablesCapability).toHaveBeenCalledWith(
      "visible",
    );
    expect(mockDispatchCommercialSeedRequest).toHaveBeenCalledWith({
      action: "createPreview",
      actor_account_id: "admin-1",
      payload: expect.objectContaining({
        organization_name: "Example University",
        reason: BASE.reason,
        source: "admin-ui",
      }),
    });
  });

  it("routes site license analytics as an audited seed read", async () => {
    mockDispatchCommercialSeedRequest.mockResolvedValue({
      start: "2026-01-01",
      end: "2026-02-01",
      rows: [],
    });

    await siteLicenseRevenueAnalytics({
      ...BASE,
      start: "2026-01-01",
      end: "2026-02-01",
      reason: "Review site license revenue analytics",
    });

    expect(mockRequireDangerousSessionAuth).not.toHaveBeenCalled();
    expect(mockAssertCommercialReceivablesCapability).toHaveBeenCalledWith(
      "visible",
    );
    expect(mockDispatchCommercialSeedRequest).toHaveBeenCalledWith({
      action: "siteLicenseRevenueAnalytics",
      actor_account_id: "admin-1",
      payload: {
        start: "2026-01-01",
        end: "2026-02-01",
        reason: "Review site license revenue analytics",
        source: "admin-ui",
      },
    });
  });

  it.each([
    ["create", create, { organization_name: "Example University" }],
    ["approve", approve, { id: "co_1", expected_version: 2 }],
    [
      "revise",
      revise,
      { id: "co_1", expected_version: 2, changes: { agreed_total: "4000" } },
    ],
    [
      "issueManualInvoice",
      issueManualInvoice,
      { id: "co_1", expected_version: 3, invoice_reference: "INV-42" },
    ],
    [
      "createInvoiceDraft",
      createInvoiceDraft,
      { id: "co_1", expected_version: 3 },
    ],
    ["provision", provision, { id: "co_1", expected_version: 4 }],
    ["retryStripeEvent", retryStripeEvent, { event_id: "evt_retry123" }],
  ])(
    "requires fresh auth for %s before dispatch",
    async (action, fn, payload) => {
      mockDispatchCommercialSeedRequest.mockResolvedValue({ id: "co_1" });

      await (fn as any)({ ...BASE, ...payload });

      expect(mockRequireDangerousSessionAuth).toHaveBeenCalledWith({
        account_id: "admin-1",
        browser_id: "browser-1",
        session_hash: "session-1",
        require_second_factor: "if_enabled",
        allow_actor_impersonation: false,
      });
      expect(mockAssertCommercialReceivablesCapability).toHaveBeenCalledWith(
        action === "create"
          ? "mutate"
          : action === "issueManualInvoice"
            ? "manualSettlement"
            : action === "createInvoiceDraft"
              ? "stripeDraft"
              : action === "provision"
                ? "fulfillment"
                : action === "retryStripeEvent"
                  ? "reconciliation"
                  : "mutate",
      );
      expect(mockDispatchCommercialSeedRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          action,
          actor_account_id: "admin-1",
          payload: expect.not.objectContaining({
            account_id: expect.anything(),
            browser_id: expect.anything(),
            session_hash: expect.anything(),
          }),
        }),
      );
    },
  );

  it.each(["stripe-webhook", "reconciler", "system"])(
    "rejects the reserved public mutation source %s",
    async (source) => {
      await expect(
        approve({
          ...BASE,
          id: "co_1",
          expected_version: 2,
          source: source as any,
        }),
      ).rejects.toThrow("may only use admin-ui, cli, or migration");
      expect(mockRequireDangerousSessionAuth).not.toHaveBeenCalled();
      expect(mockDispatchCommercialSeedRequest).not.toHaveBeenCalled();
    },
  );

  it("does not route a dangerous mutation when fresh auth fails", async () => {
    mockRequireDangerousSessionAuth.mockRejectedValue(
      Object.assign(Error("fresh auth required"), {
        code: "fresh_auth_required",
      }),
    );

    await expect(
      approve({ ...BASE, id: "co_1", expected_version: 2 }),
    ).rejects.toMatchObject({ code: "fresh_auth_required" });

    expect(mockDispatchCommercialSeedRequest).not.toHaveBeenCalled();
    expect(mockGetInterBayBridge).not.toHaveBeenCalled();
  });

  it("routes non-seed requests only to the configured seed bay", async () => {
    const commercialOrders = jest.fn().mockResolvedValue({ orders: [] });
    const bayOps = jest.fn(() => ({ commercialOrders }));
    mockGetConfiguredBayId.mockReturnValue("worker-bay");
    mockGetInterBayBridge.mockReturnValue({ bayOps });

    await list({ ...BASE, needs_action: true });

    expect(mockDispatchCommercialSeedRequest).not.toHaveBeenCalled();
    expect(bayOps).toHaveBeenCalledWith("seed-bay", { timeout_ms: 120_000 });
    expect(commercialOrders).toHaveBeenCalledWith({
      action: "list",
      actor_account_id: "admin-1",
      payload: {
        reason: BASE.reason,
        needs_action: true,
        source: "admin-ui",
      },
    });
    expect(mockAssertCommercialReceivablesCapability).toHaveBeenCalledWith(
      "visible",
    );
  });
});
