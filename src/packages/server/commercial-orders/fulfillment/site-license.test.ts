/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/** @jest-environment node */

const mockGetPool = jest.fn();
const mockAddSiteLicensePool = jest.fn();
const mockAdminProvisionSiteLicense = jest.fn();
const mockArchiveSiteLicensePool = jest.fn();
const mockGetSiteLicenseOverview = jest.fn();
const mockRemoveSiteLicenseManager = jest.fn();
const mockSetSiteLicenseManager = jest.fn();
const mockUpdateSiteLicense = jest.fn();
const mockUpdateSiteLicensePool = jest.fn();
const mockGetCommercialOrder = jest.fn();
const mockGetCommercialProviderOperationByIdempotencyKey = jest.fn();
const mockReserveCommercialProviderOperation = jest.fn();
const mockSetCommercialFulfillment = jest.fn();
const mockSetCommercialProviderOperationStatus = jest.fn();
const mockRecordCommercialProviderFailure = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetPool(...args),
}));

jest.mock("@cocalc/server/membership/site-licenses", () => ({
  addSiteLicensePool: (...args: any[]) => mockAddSiteLicensePool(...args),
  adminProvisionSiteLicense: (...args: any[]) =>
    mockAdminProvisionSiteLicense(...args),
  archiveSiteLicensePool: (...args: any[]) =>
    mockArchiveSiteLicensePool(...args),
  getSiteLicenseOverview: (...args: any[]) =>
    mockGetSiteLicenseOverview(...args),
  removeSiteLicenseManager: (...args: any[]) =>
    mockRemoveSiteLicenseManager(...args),
  setSiteLicenseManager: (...args: any[]) => mockSetSiteLicenseManager(...args),
  updateSiteLicense: (...args: any[]) => mockUpdateSiteLicense(...args),
  updateSiteLicensePool: (...args: any[]) => mockUpdateSiteLicensePool(...args),
}));

jest.mock("../store", () => ({
  commercialIdempotencyKey: (operation: string) => `${operation}:key`,
  getCommercialOrder: (...args: any[]) => mockGetCommercialOrder(...args),
  getCommercialProviderOperationByIdempotencyKey: (...args: any[]) =>
    mockGetCommercialProviderOperationByIdempotencyKey(...args),
  reserveCommercialProviderOperation: (...args: any[]) =>
    mockReserveCommercialProviderOperation(...args),
  setCommercialFulfillment: (...args: any[]) =>
    mockSetCommercialFulfillment(...args),
  setCommercialProviderOperationStatus: (...args: any[]) =>
    mockSetCommercialProviderOperationStatus(...args),
}));

jest.mock("../observability", () => ({
  recordCommercialProviderFailure: (...args: any[]) =>
    mockRecordCommercialProviderFailure(...args),
}));

import type { CommercialOrder } from "@cocalc/util/commercial-orders";
import {
  commercialFulfillmentPreview,
  endCommercialSiteLicenseFulfillment,
  provisionCommercialSiteLicense,
} from "./site-license";

function orderFixture(changes: Partial<CommercialOrder> = {}): CommercialOrder {
  return {
    id: "co_1",
    order_number: "AR-2026-000001",
    organization_name: "Example University",
    site_license_id: null,
    stripe_customer_id: null,
    zendesk_ticket_ids: [20529],
    workflow_state: "awaiting_payment",
    collection_mode: "stripe_invoice",
    collection_state: "paid",
    fulfillment_state: "not_provisioned",
    currency: "usd",
    agreed_subtotal: "3900.0000000000",
    agreed_total: "3900.0000000000",
    terms_snapshot: {
      site_license: {
        name: "Example University adoption pilot",
        organization_name: "Example University",
        owner_account_id: "owner-1",
        manager_account_ids: ["OWNER-1", "manager-1", "manager-1"],
        allowed_domains: ["EXAMPLE.EDU", "example.edu"],
        pools: [
          {
            membership_class: "student",
            seat_limit: 500,
            label: "Students",
          },
          {
            membership_class: "instructor",
            seat_limit: 25,
            label: "Instructors",
          },
        ],
        starts_at: "2026-08-23T00:00:00.000Z",
        expires_at: "2027-06-30T23:59:59.000Z",
      },
    },
    next_action: "Provision service",
    approved_at: "2026-08-23T00:00:00.000Z",
    approved_by_account_id: "admin-1",
    created_by_account_id: "admin-1",
    created_at: "2026-08-23T00:00:00.000Z",
    updated_at: "2026-08-23T00:00:00.000Z",
    version: 7,
    items: [],
    contacts: [],
    invoices: [],
    payments: [],
    ...changes,
  };
}

function matchingOverview(changes: Record<string, any> = {}) {
  const {
    site_license: siteLicenseChanges,
    pools: poolChanges,
    managers: managerChanges,
    ...otherChanges
  } = changes;
  return {
    site_license: {
      id: "sl_1",
      name: "Example University adoption pilot",
      organization_name: "Example University",
      owner_account_id: "owner-1",
      allowed_domains: ["example.edu"],
      starts_at: "2026-08-23T00:00:00.000Z",
      expires_at: "2027-06-30T23:59:59.000Z",
      metadata: {},
      ...siteLicenseChanges,
    },
    pools: poolChanges ?? [
      {
        id: "student-pool",
        membership_class: "student",
        seat_count: 500,
        active_assignment_count: 0,
        expires_at: "2027-06-30T23:59:59.000Z",
        pool_name: "Students",
        requires_approval: false,
        verification_policy: "email-domain",
        metadata: {
          allowed_domains: ["example.edu"],
        },
      },
      {
        id: "instructor-pool",
        membership_class: "instructor",
        seat_count: 25,
        active_assignment_count: 0,
        expires_at: "2027-06-30T23:59:59.000Z",
        pool_name: "Instructors",
        requires_approval: false,
        verification_policy: "email-domain",
        metadata: {
          allowed_domains: ["example.edu"],
        },
      },
    ],
    managers: managerChanges ?? [
      { account_id: "manager-1", role: "manager", revoked_at: null },
    ],
    ...otherChanges,
  };
}

describe("commercial site-license fulfillment", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCommercialOrder.mockResolvedValue(orderFixture());
    mockGetCommercialProviderOperationByIdempotencyKey.mockResolvedValue(
      undefined,
    );
    mockGetPool.mockReturnValue({
      query: jest.fn().mockResolvedValue({ rows: [] }),
    });
    mockGetSiteLicenseOverview.mockResolvedValue(undefined);
    mockReserveCommercialProviderOperation.mockResolvedValue({
      operation: { id: "op_1", status: "pending" },
    });
    mockSetCommercialFulfillment.mockResolvedValue(
      orderFixture({ fulfillment_state: "provisioned" }),
    );
    mockSetCommercialProviderOperationStatus.mockResolvedValue(undefined);
  });

  it("previews a normalized site-license plan without mutating fulfillment", async () => {
    await expect(
      commercialFulfillmentPreview({
        id: "co_1",
        account_id: "admin-1",
        reason: "Review pilot fulfillment",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        order_id: "co_1",
        adapter: "site_license",
        action: "create",
        ready: true,
        blockers: [],
        planned_changes: [],
        plan: expect.objectContaining({
          name: "Example University adoption pilot",
          manager_account_ids: ["owner-1", "manager-1"],
          allowed_domains: ["example.edu"],
          pools: [
            expect.objectContaining({
              membership_class: "student",
              seat_limit: 500,
            }),
            expect.objectContaining({
              membership_class: "instructor",
              seat_limit: 25,
            }),
          ],
        }),
      }),
    );

    expect(mockAdminProvisionSiteLicense).not.toHaveBeenCalled();
    expect(mockSetCommercialFulfillment).not.toHaveBeenCalled();
    expect(mockReserveCommercialProviderOperation).not.toHaveBeenCalled();
  });

  it("previews correctable existing-license drift as planned changes", async () => {
    mockGetCommercialOrder.mockResolvedValue(
      orderFixture({ site_license_id: "sl_1" }),
    );
    mockGetSiteLicenseOverview.mockResolvedValue({
      ...matchingOverview(),
      site_license: {
        ...matchingOverview().site_license,
        organization_name: "Wrong University",
      },
    });

    await expect(
      commercialFulfillmentPreview({
        id: "co_1",
        account_id: "admin-1",
        reason: "Review existing license",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        action: "update",
        site_license_id: "sl_1",
        ready: true,
        blockers: [],
        planned_changes: ["commercial-order-association", "organization_name"],
      }),
    );
  });

  it("previews an extra manager as a planned removal", async () => {
    mockGetCommercialOrder.mockResolvedValue(
      orderFixture({ site_license_id: "sl_1" }),
    );
    mockGetSiteLicenseOverview.mockResolvedValue({
      ...matchingOverview(),
      managers: [
        { account_id: "manager-1", role: "manager", revoked_at: null },
        { account_id: "unexpected-1", role: "viewer", revoked_at: null },
      ],
    });

    await expect(
      commercialFulfillmentPreview({
        id: "co_1",
        account_id: "admin-1",
        reason: "Review manager access",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        ready: true,
        blockers: [],
        planned_changes: [
          "commercial-order-association",
          "extra-manager:unexpected-1",
        ],
      }),
    );
  });

  it("returns the current order without repeating a succeeded provision operation", async () => {
    const order = orderFixture();
    const provisioned = orderFixture({
      fulfillment_state: "provisioned",
      site_license_id: "sl_1",
      version: 8,
    });
    mockGetCommercialOrder
      .mockResolvedValueOnce(order)
      .mockResolvedValueOnce(provisioned);
    mockReserveCommercialProviderOperation.mockResolvedValue({
      operation: { id: "op_1", status: "succeeded" },
    });

    await expect(
      provisionCommercialSiteLicense({
        id: "co_1",
        account_id: "admin-1",
        expected_version: 7,
        reason: "Provision accepted pilot",
      }),
    ).resolves.toEqual(provisioned);

    expect(mockReserveCommercialProviderOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        order_id: "co_1",
        operation: "provision-site-license",
        expected_version: 7,
        idempotency_key: "site-license-provision:key",
      }),
    );
    expect(mockAdminProvisionSiteLicense).not.toHaveBeenCalled();
    expect(mockUpdateSiteLicense).not.toHaveBeenCalled();
    expect(mockSetCommercialFulfillment).not.toHaveBeenCalled();
    expect(mockSetCommercialProviderOperationStatus).not.toHaveBeenCalled();
  });

  it("repairs an exact provision replay committed before its operation status", async () => {
    const complete = orderFixture({
      workflow_state: "complete",
      fulfillment_state: "provisioned",
      site_license_id: "sl_1",
      version: 8,
    });
    const current = matchingOverview({
      site_license: {
        metadata: {
          commercial_order_id: "co_1",
          commercial_order_number: "AR-2026-000001",
        },
      },
    });
    mockGetCommercialOrder.mockResolvedValue(complete);
    mockGetCommercialProviderOperationByIdempotencyKey.mockResolvedValue({
      id: "op_1",
      status: "indeterminate",
    });
    mockReserveCommercialProviderOperation.mockResolvedValue({
      operation: { id: "op_1", status: "indeterminate" },
    });
    mockGetSiteLicenseOverview.mockResolvedValue(current);

    await expect(
      provisionCommercialSiteLicense({
        id: "co_1",
        account_id: "admin-1",
        expected_version: 7,
        reason: "Provision accepted pilot",
      }),
    ).resolves.toEqual(complete);

    expect(mockSetCommercialFulfillment).not.toHaveBeenCalled();
    expect(mockSetCommercialProviderOperationStatus).toHaveBeenCalledWith({
      id: "op_1",
      status: "succeeded",
      result: { site_license_id: "sl_1", recovered: true },
    });
  });

  it("removes managers not present in the approved plan", async () => {
    const order = orderFixture({ site_license_id: "sl_1" });
    const exactOverview = matchingOverview();
    mockGetCommercialOrder.mockResolvedValue(order);
    mockGetSiteLicenseOverview
      .mockResolvedValueOnce({
        ...exactOverview,
        managers: [
          ...exactOverview.managers,
          { account_id: "old-manager", role: "manager", revoked_at: null },
        ],
      })
      .mockResolvedValue(exactOverview);

    await provisionCommercialSiteLicense({
      id: "co_1",
      account_id: "admin-1",
      expected_version: 7,
      reason: "Apply approved license terms",
    });

    expect(mockRemoveSiteLicenseManager).toHaveBeenCalledWith({
      actor_account_id: "admin-1",
      site_license_id: "sl_1",
      target_account_id: "old-manager",
    });
    expect(mockUpdateSiteLicense).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          commercial_order_id: "co_1",
          commercial_order_number: order.order_number,
        }),
      }),
    );
    expect(mockSetCommercialFulfillment).toHaveBeenCalledWith(
      expect.objectContaining({
        site_license_id: "sl_1",
        fulfillment_state: "provisioned",
      }),
    );
  });

  it.each([
    [
      "unapproved",
      { approved_at: null, approved_by_account_id: null },
      "must be approved",
    ],
    ["complete", { workflow_state: "complete" }, "cannot be provisioned"],
    ["cancelled", { workflow_state: "cancelled" }, "cannot be provisioned"],
  ])(
    "rejects %s orders before reserving or mutating fulfillment",
    async (_label, changes, message) => {
      mockGetCommercialOrder.mockResolvedValue(orderFixture(changes as any));

      await expect(
        provisionCommercialSiteLicense({
          id: "co_1",
          account_id: "admin-1",
          expected_version: 7,
          reason: "Provision accepted pilot",
        }),
      ).rejects.toThrow(message);

      expect(mockReserveCommercialProviderOperation).not.toHaveBeenCalled();
      expect(mockAdminProvisionSiteLicense).not.toHaveBeenCalled();
      expect(mockUpdateSiteLicense).not.toHaveBeenCalled();
    },
  );

  it("rejects a target that differs from the license stored on the order", async () => {
    mockGetCommercialOrder.mockResolvedValue(
      orderFixture({ site_license_id: "sl_1" }),
    );

    await expect(
      provisionCommercialSiteLicense({
        id: "co_1",
        account_id: "admin-1",
        expected_version: 7,
        existing_site_license_id: "sl_unreviewed",
        reason: "Provision accepted pilot",
      }),
    ).rejects.toThrow("must match the target already stored and reviewed");

    expect(mockGetSiteLicenseOverview).not.toHaveBeenCalled();
    expect(mockReserveCommercialProviderOperation).not.toHaveBeenCalled();
  });

  it("links an explicitly named existing license when the order stores none", async () => {
    // An order approved without a site-license plan, whose license was
    // provisioned separately (e.g. by hand before the order was paid).
    mockGetCommercialOrder.mockResolvedValue(
      orderFixture({ site_license_id: null, terms_snapshot: {} }),
    );
    mockGetSiteLicenseOverview.mockResolvedValue(matchingOverview());
    mockUpdateSiteLicense.mockResolvedValue(
      matchingOverview({
        site_license: { metadata: { commercial_order_id: "co_1" } },
      }),
    );

    await provisionCommercialSiteLicense({
      id: "co_1",
      account_id: "admin-1",
      expected_version: 7,
      existing_site_license_id: " sl_1 ",
      reason: "Link the already provisioned campus license",
    });

    expect(mockReserveCommercialProviderOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "provision-site-license",
        exclusive: true,
        // The named target is canonicalized before it is keyed and stored.
        request: {
          existing_site_license_id: "sl_1",
          allow_before_payment: false,
        },
      }),
    );
    expect(mockAdminProvisionSiteLicense).not.toHaveBeenCalled();
    expect(mockUpdateSiteLicense).toHaveBeenCalledWith({
      actor_account_id: "admin-1",
      site_license_id: "sl_1",
      metadata: {
        commercial_order_id: "co_1",
        commercial_order_number: "AR-2026-000001",
      },
    });
    expect(mockSetCommercialFulfillment).toHaveBeenCalledWith(
      expect.objectContaining({
        fulfillment_state: "provisioned",
        site_license_id: "sl_1",
        expected_version: 7,
      }),
    );
  });

  describe("a named license on an order without a plan", () => {
    const customerOrder = () =>
      orderFixture({
        site_license_id: null,
        terms_snapshot: {},
        customer_account_id: "customer-1",
        crm_organization_id: "crm-1",
        service_starts_at: "2026-09-10T00:00:00.000Z",
        service_ends_at: "2027-07-31T23:59:59.000Z",
      });
    const unrelatedLicense = () =>
      matchingOverview({
        site_license: {
          organization_name: "Other College",
          owner_account_id: "stranger-1",
          starts_at: "2025-01-01T00:00:00.000Z",
          expires_at: "2025-12-31T23:59:59.000Z",
        },
        managers: [],
      });

    it("blocks an unrelated license in the preview and shows its identity", async () => {
      mockGetCommercialOrder.mockResolvedValue(customerOrder());
      mockGetSiteLicenseOverview.mockResolvedValue(unrelatedLicense());

      const preview = await commercialFulfillmentPreview({
        id: "co_1",
        account_id: "admin-1",
        reason: "Review linking a license",
        existing_site_license_id: "sl_1",
      });
      expect(preview.ready).toBe(false);
      expect(preview.target_mismatches).toEqual([
        "organization_name",
        "customer_account",
        "expires_at",
      ]);
      expect(preview.blockers).toEqual([
        expect.stringContaining("does not match the commercial order"),
      ]);
      expect(preview.target).toEqual({
        name: "Example University adoption pilot",
        organization_name: "Other College",
        crm_organization_id: null,
        owner_account_id: "stranger-1",
        starts_at: "2025-01-01T00:00:00.000Z",
        expires_at: "2025-12-31T23:59:59.000Z",
      });

      const allowed = await commercialFulfillmentPreview({
        id: "co_1",
        account_id: "admin-1",
        reason: "Review linking a license",
        existing_site_license_id: "sl_1",
        allow_target_mismatch: true,
      });
      expect(allowed.ready).toBe(true);
      expect(allowed.target_mismatches).toHaveLength(3);
    });

    it("refuses to provision an unrelated license before any mutation", async () => {
      mockGetCommercialOrder.mockResolvedValue(customerOrder());
      mockGetSiteLicenseOverview.mockResolvedValue(unrelatedLicense());

      await expect(
        provisionCommercialSiteLicense({
          id: "co_1",
          account_id: "admin-1",
          expected_version: 7,
          existing_site_license_id: "sl_1",
          reason: "Link a license",
        }),
      ).rejects.toThrow("does not match the commercial order");
      expect(mockReserveCommercialProviderOperation).not.toHaveBeenCalled();
      expect(mockUpdateSiteLicense).not.toHaveBeenCalled();
      expect(mockSetCommercialFulfillment).not.toHaveBeenCalled();
    });

    it("links a reviewed mismatch only when explicitly allowed and records it", async () => {
      mockGetCommercialOrder.mockResolvedValue(customerOrder());
      mockGetSiteLicenseOverview.mockResolvedValue(unrelatedLicense());
      mockUpdateSiteLicense.mockResolvedValue(unrelatedLicense());

      await provisionCommercialSiteLicense({
        id: "co_1",
        account_id: "admin-1",
        expected_version: 7,
        existing_site_license_id: "sl_1",
        allow_target_mismatch: true,
        reason: "Link a renamed license after review",
      });
      expect(mockReserveCommercialProviderOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          request: {
            existing_site_license_id: "sl_1",
            allow_before_payment: false,
            allow_target_mismatch: true,
          },
        }),
      );
      expect(mockSetCommercialFulfillment).toHaveBeenCalledWith(
        expect.objectContaining({
          site_license_id: "sl_1",
          metadata: expect.objectContaining({
            accepted_target_mismatches: [
              "organization_name",
              "customer_account",
              "expires_at",
            ],
          }),
        }),
      );
    });

    it("links a congruent license whose customer is a manager", async () => {
      mockGetCommercialOrder.mockResolvedValue(customerOrder());
      const congruent = matchingOverview({
        site_license: {
          organization_name: "example university.",
          owner_account_id: "someone-else",
          crm_organization_id: "crm-1",
          starts_at: "2026-09-01T00:00:00.000Z",
          expires_at: "2027-08-31T23:59:59.000Z",
        },
        managers: [
          { account_id: "customer-1", role: "manager", revoked_at: null },
        ],
      });
      mockGetSiteLicenseOverview.mockResolvedValue(congruent);
      mockUpdateSiteLicense.mockResolvedValue(congruent);

      const preview = await commercialFulfillmentPreview({
        id: "co_1",
        account_id: "admin-1",
        reason: "Review linking a license",
        existing_site_license_id: "sl_1",
      });
      expect(preview.ready).toBe(true);
      expect(preview.target_mismatches).toEqual([]);

      await provisionCommercialSiteLicense({
        id: "co_1",
        account_id: "admin-1",
        expected_version: 7,
        existing_site_license_id: "sl_1",
        reason: "Link the campus license",
      });
      expect(mockSetCommercialFulfillment).toHaveBeenCalledWith(
        expect.objectContaining({
          site_license_id: "sl_1",
          metadata: expect.not.objectContaining({
            accepted_target_mismatches: expect.anything(),
          }),
        }),
      );
    });
  });

  it("refuses to resolve a replayed operation against a different stored license", async () => {
    mockGetCommercialOrder.mockResolvedValue(
      orderFixture({
        workflow_state: "complete",
        fulfillment_state: "provisioned",
        site_license_id: "sl_B",
        terms_snapshot: {},
      }),
    );
    mockGetCommercialProviderOperationByIdempotencyKey.mockResolvedValue({
      id: "op_A",
      status: "indeterminate",
      request: { existing_site_license_id: "sl_A" },
    });

    await expect(
      provisionCommercialSiteLicense({
        id: "co_1",
        account_id: "admin-1",
        expected_version: 7,
        existing_site_license_id: "sl_A",
        reason: "Replay link of license A",
      }),
    ).rejects.toThrow(
      "provision operation targeted site license sl_A, but the order is fulfilled with sl_B",
    );
    expect(mockReserveCommercialProviderOperation).not.toHaveBeenCalled();
    expect(mockSetCommercialProviderOperationStatus).not.toHaveBeenCalled();
    expect(mockGetSiteLicenseOverview).not.toHaveBeenCalled();
  });

  it("preflights an explicitly named license held by another order before mutation", async () => {
    mockGetCommercialOrder.mockResolvedValue(
      orderFixture({ site_license_id: null }),
    );
    mockGetSiteLicenseOverview.mockResolvedValue(
      matchingOverview({
        site_license: { metadata: { commercial_order_id: "co_other" } },
      }),
    );

    await expect(
      provisionCommercialSiteLicense({
        id: "co_1",
        account_id: "admin-1",
        expected_version: 7,
        existing_site_license_id: "sl_1",
        reason: "Link the already provisioned campus license",
      }),
    ).rejects.toThrow("belongs to commercial order co_other");

    expect(mockReserveCommercialProviderOperation).not.toHaveBeenCalled();
    expect(mockUpdateSiteLicense).not.toHaveBeenCalled();
    expect(mockSetCommercialFulfillment).not.toHaveBeenCalled();
  });

  it("previews linking an explicitly named license when the order stores none", async () => {
    mockGetCommercialOrder.mockResolvedValue(
      orderFixture({ site_license_id: null, terms_snapshot: {} }),
    );
    mockGetSiteLicenseOverview.mockResolvedValue(matchingOverview());

    await expect(
      commercialFulfillmentPreview({
        id: "co_1",
        account_id: "admin-1",
        reason: "Review linking the campus license",
        existing_site_license_id: "sl_1",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        action: "update",
        site_license_id: "sl_1",
        ready: true,
        blockers: [],
        planned_changes: [
          "order-site-license-link",
          "commercial-order-association",
        ],
      }),
    );
    expect(mockUpdateSiteLicense).not.toHaveBeenCalled();
    expect(mockSetCommercialFulfillment).not.toHaveBeenCalled();
  });

  it("previews a license that differs from the stored one as a blocker", async () => {
    mockGetCommercialOrder.mockResolvedValue(
      orderFixture({ site_license_id: "sl_1" }),
    );
    mockGetSiteLicenseOverview.mockResolvedValue(
      matchingOverview({
        site_license: { metadata: { commercial_order_id: "co_1" } },
      }),
    );

    const preview = await commercialFulfillmentPreview({
      id: "co_1",
      account_id: "admin-1",
      reason: "Review linking the campus license",
      existing_site_license_id: "sl_other",
    });
    expect(preview.ready).toBe(false);
    expect(preview.site_license_id).toBe("sl_1");
    expect(preview.blockers).toEqual([
      expect.stringContaining("must match the target already stored"),
    ]);
  });

  it("preflights immutable ownership before any external mutation", async () => {
    mockGetCommercialOrder.mockResolvedValue(
      orderFixture({ site_license_id: "sl_1" }),
    );
    mockGetSiteLicenseOverview.mockResolvedValue(
      matchingOverview({
        site_license: { owner_account_id: "different-owner" },
      }),
    );

    await expect(
      provisionCommercialSiteLicense({
        id: "co_1",
        account_id: "admin-1",
        expected_version: 7,
        reason: "Provision accepted pilot",
      }),
    ).rejects.toThrow("owner does not match");

    expect(mockReserveCommercialProviderOperation).not.toHaveBeenCalled();
    expect(mockUpdateSiteLicense).not.toHaveBeenCalled();
    expect(mockUpdateSiteLicensePool).not.toHaveBeenCalled();
  });

  it("preflights another commercial-order association before mutation", async () => {
    mockGetCommercialOrder.mockResolvedValue(
      orderFixture({ site_license_id: "sl_1" }),
    );
    mockGetSiteLicenseOverview.mockResolvedValue(
      matchingOverview({
        site_license: {
          metadata: { commercial_order_id: "co_other" },
        },
      }),
    );

    await expect(
      provisionCommercialSiteLicense({
        id: "co_1",
        account_id: "admin-1",
        expected_version: 7,
        reason: "Provision accepted pilot",
      }),
    ).rejects.toThrow("belongs to commercial order co_other");

    expect(mockReserveCommercialProviderOperation).not.toHaveBeenCalled();
    expect(mockUpdateSiteLicense).not.toHaveBeenCalled();
  });

  it("preflights an association held by another active commercial order", async () => {
    mockGetCommercialOrder.mockResolvedValue(
      orderFixture({ site_license_id: "sl_1" }),
    );
    mockGetSiteLicenseOverview.mockResolvedValue(matchingOverview());
    mockGetPool.mockReturnValue({
      query: jest.fn().mockResolvedValue({
        rows: [{ id: "co_other", order_number: "AR-2026-000099" }],
      }),
    });

    await expect(
      provisionCommercialSiteLicense({
        id: "co_1",
        account_id: "admin-1",
        expected_version: 7,
        reason: "Provision accepted pilot",
      }),
    ).rejects.toThrow("AR-2026-000099");

    expect(mockReserveCommercialProviderOperation).not.toHaveBeenCalled();
    expect(mockUpdateSiteLicense).not.toHaveBeenCalled();
  });

  it("preflights active seats in an extra pool before mutation", async () => {
    mockGetCommercialOrder.mockResolvedValue(
      orderFixture({ site_license_id: "sl_1" }),
    );
    const current = matchingOverview();
    current.pools.push({
      id: "extra-pool",
      membership_class: "member",
      seat_count: 10,
      active_assignment_count: 2,
      expires_at: "2027-06-30T23:59:59.000Z",
      pool_name: "Members",
      requires_approval: false,
      verification_policy: "email-domain",
      metadata: {},
    });
    mockGetSiteLicenseOverview.mockResolvedValue(current);

    await expect(
      provisionCommercialSiteLicense({
        id: "co_1",
        account_id: "admin-1",
        expected_version: 7,
        reason: "Provision accepted pilot",
      }),
    ).rejects.toThrow("has active seats and cannot be archived");

    expect(mockReserveCommercialProviderOperation).not.toHaveBeenCalled();
    expect(mockUpdateSiteLicense).not.toHaveBeenCalled();
  });

  it("expires the linked site license and all pools before ending locally", async () => {
    const order = orderFixture({
      workflow_state: "complete",
      fulfillment_state: "provisioned",
      site_license_id: "sl_1",
    });
    const current = matchingOverview();
    const expired = matchingOverview({
      site_license: { expires_at: "2026-08-22T00:00:00.000Z" },
      pools: current.pools.map((pool) => ({
        ...pool,
        expires_at: "2026-08-22T00:00:00.000Z",
      })),
    });
    mockGetCommercialOrder.mockResolvedValue(order);
    mockGetSiteLicenseOverview
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(expired);
    mockSetCommercialFulfillment.mockResolvedValue(
      orderFixture({
        workflow_state: "complete",
        fulfillment_state: "ended",
        site_license_id: "sl_1",
        version: 8,
      }),
    );

    await expect(
      endCommercialSiteLicenseFulfillment({
        id: "co_1",
        account_id: "admin-1",
        expected_version: 7,
        reason: "End completed pilot access",
      }),
    ).resolves.toEqual(expect.objectContaining({ fulfillment_state: "ended" }));

    expect(mockUpdateSiteLicensePool).toHaveBeenCalledTimes(2);
    expect(mockUpdateSiteLicense).toHaveBeenCalledWith(
      expect.objectContaining({
        site_license_id: "sl_1",
        expires_at: expect.any(String),
      }),
    );
    expect(mockSetCommercialFulfillment).toHaveBeenCalledWith(
      expect.objectContaining({ fulfillment_state: "ended" }),
    );
    expect(mockSetCommercialProviderOperationStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "succeeded" }),
    );
  });

  it("returns an already-ended order without repeating provider mutations", async () => {
    const ended = orderFixture({
      workflow_state: "complete",
      fulfillment_state: "ended",
      site_license_id: "sl_1",
    });
    mockGetCommercialOrder.mockResolvedValue(ended);

    await expect(
      endCommercialSiteLicenseFulfillment({
        id: "co_1",
        account_id: "admin-1",
        expected_version: 7,
        reason: "Confirm pilot is ended",
      }),
    ).resolves.toEqual(ended);

    expect(mockGetSiteLicenseOverview).not.toHaveBeenCalled();
    expect(mockReserveCommercialProviderOperation).not.toHaveBeenCalled();
    expect(mockUpdateSiteLicense).not.toHaveBeenCalled();
  });

  it("rejects ending fulfillment that was never provisioned", async () => {
    await expect(
      endCommercialSiteLicenseFulfillment({
        id: "co_1",
        account_id: "admin-1",
        expected_version: 7,
        reason: "End pilot access",
      }),
    ).rejects.toThrow("was never provisioned");

    expect(mockReserveCommercialProviderOperation).not.toHaveBeenCalled();
    expect(mockUpdateSiteLicense).not.toHaveBeenCalled();
  });

  it("records an indeterminate provider operation when ending access fails", async () => {
    mockGetCommercialOrder.mockResolvedValue(
      orderFixture({
        workflow_state: "complete",
        fulfillment_state: "provisioned",
        site_license_id: "sl_1",
      }),
    );
    mockGetSiteLicenseOverview.mockResolvedValue(matchingOverview());
    mockUpdateSiteLicensePool.mockRejectedValueOnce(
      Error("membership provider unavailable"),
    );

    await expect(
      endCommercialSiteLicenseFulfillment({
        id: "co_1",
        account_id: "admin-1",
        expected_version: 7,
        reason: "End completed pilot access",
      }),
    ).rejects.toThrow("membership provider unavailable");

    expect(mockRecordCommercialProviderFailure).toHaveBeenCalledWith(
      "site-license-end",
    );
    expect(mockSetCommercialProviderOperationStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "indeterminate" }),
    );
    expect(mockSetCommercialFulfillment).not.toHaveBeenCalled();
  });
});
