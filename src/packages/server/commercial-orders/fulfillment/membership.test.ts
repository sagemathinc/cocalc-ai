/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/** @jest-environment node */

const mockGetMembershipPackages = jest.fn();
const mockGetCommercialOrder = jest.fn();
const mockSetCommercialFulfillment = jest.fn();

jest.mock("@cocalc/server/conat/api/purchases", () => ({
  getMembershipPackages: (...args: any[]) => mockGetMembershipPackages(...args),
}));

jest.mock("../store", () => ({
  commercialIdempotencyKey: (operation: string, opts: any) =>
    opts.idempotency_key ?? `${operation}:key`,
  getCommercialOrder: (...args: any[]) => mockGetCommercialOrder(...args),
  setCommercialFulfillment: (...args: any[]) =>
    mockSetCommercialFulfillment(...args),
}));

import { recordCommercialMembershipFulfillment } from "./membership";

const CUSTOMER = "8c64771e-8f3d-45d1-a016-52bf88605454";
const STUDENTS = "7b378d3c-28d8-4a03-8d30-98cec8926a53";
const INSTRUCTOR = "8fabbf12-8111-45bd-ab99-bdcd6a27bd31";
const DAY = 24 * 3600 * 1000;
const SERVICE_ENDS = new Date(Date.now() + 100 * DAY);

function order(changes: Record<string, unknown> = {}) {
  return {
    id: "170745ea-7d8c-4a2c-b8c7-69f6e7445667",
    order_number: "AR-2026-170745EA",
    workflow_state: "awaiting_payment",
    collection_state: "paid",
    fulfillment_state: "not_provisioned",
    site_license_id: null,
    customer_account_id: CUSTOMER,
    service_ends_at: SERVICE_ENDS.toISOString(),
    version: 14,
    items: [
      { product_kind: "membership_package" },
      { product_kind: "membership_package" },
    ],
    ...changes,
  };
}

function pkg(id: string, changes: Record<string, unknown> = {}) {
  return {
    id,
    owner_account_id: CUSTOMER,
    kind: "team",
    membership_class: "student",
    seat_count: 26,
    starts_at: new Date(Date.now() - 3 * DAY),
    expires_at: new Date(SERVICE_ENDS.valueOf() + 3 * DAY),
    metadata: { commercial_order_number: "AR-2026-170745EA" },
    ...changes,
  };
}

const request = {
  id: "AR-2026-170745EA",
  account_id: "admin_1",
  expected_version: 14,
  reason: "record bridge packages",
  idempotency_key: "cli-key-1",
  membership_package_ids: [STUDENTS, INSTRUCTOR],
};

describe("recordCommercialMembershipFulfillment", () => {
  beforeEach(() => {
    mockGetCommercialOrder.mockReset().mockResolvedValue(order());
    mockSetCommercialFulfillment
      .mockReset()
      .mockImplementation(async (opts) => ({
        ...order(),
        fulfillment_state: opts.fulfillment_state,
      }));
    mockGetMembershipPackages.mockReset().mockResolvedValue([
      pkg(STUDENTS),
      pkg(INSTRUCTOR, {
        membership_class: "instructor-purchase",
        seat_count: 1,
      }),
      pkg("11111111-1111-4111-8111-111111111111"),
    ]);
  });

  it("reads the customer's packages through their home bay and records provisioned fulfillment", async () => {
    const result = await recordCommercialMembershipFulfillment(request as any);

    expect(result.fulfillment_state).toBe("provisioned");
    expect(mockGetMembershipPackages).toHaveBeenCalledWith({
      account_id: "admin_1",
      user_account_id: CUSTOMER,
    });
    expect(mockSetCommercialFulfillment).toHaveBeenCalledWith(
      expect.objectContaining({
        id: order().id,
        account_id: "admin_1",
        expected_version: 14,
        reason: "record bridge packages",
        fulfillment_state: "provisioned",
        expected_fulfillment_state: "not_provisioned",
        idempotency_key: "cli-key-1",
        metadata: expect.objectContaining({
          membership_package_ids: [STUDENTS, INSTRUCTOR],
          membership_packages: [
            expect.objectContaining({ id: STUDENTS, seat_count: 26 }),
            expect.objectContaining({
              id: INSTRUCTOR,
              membership_class: "instructor-purchase",
            }),
          ],
        }),
      }),
    );
  });

  it("leaves an exact retry after success to the store's replay", async () => {
    // The order is already provisioned by the first attempt; the retried
    // request must still reach setCommercialFulfillment with the same key,
    // which returns the replay instead of failing.
    mockGetCommercialOrder.mockResolvedValue(
      order({ fulfillment_state: "provisioned" }),
    );
    await recordCommercialMembershipFulfillment(request as any);
    expect(mockSetCommercialFulfillment).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotency_key: "cli-key-1",
        expected_fulfillment_state: "not_provisioned",
      }),
    );
  });

  it("accepts provenance by order id", async () => {
    mockGetMembershipPackages.mockResolvedValue([
      pkg(STUDENTS, { metadata: { commercial_order_id: order().id } }),
      pkg(INSTRUCTOR),
    ]);
    await expect(
      recordCommercialMembershipFulfillment(request as any),
    ).resolves.toBeDefined();
  });

  it.each([
    ["no package ids", { membership_package_ids: [] }, /at least one/],
    [
      "an invalid id",
      { membership_package_ids: ["nope"] },
      /invalid membership package id/,
    ],
    ["no reason", { reason: "" }, /reason/i],
    [
      "no expected version",
      { expected_version: undefined },
      /expected_version/,
    ],
  ])("rejects a request with %s", async (_label, changes, error) => {
    await expect(
      recordCommercialMembershipFulfillment({ ...request, ...changes } as any),
    ).rejects.toThrow(error);
    expect(mockSetCommercialFulfillment).not.toHaveBeenCalled();
  });

  it.each([
    ["cancelled", { workflow_state: "cancelled" }, /cancelled/],
    [
      "a site-license order",
      { site_license_id: "sl_1" },
      /fulfillment provision/,
    ],
    [
      "a mixed order",
      {
        items: [
          { product_kind: "membership_package" },
          { product_kind: "site_license" },
        ],
      },
      /all membership packages/,
    ],
    [
      "an order without a customer",
      { customer_account_id: null },
      /no customer account/,
    ],
  ])("rejects %s", async (_label, changes, error) => {
    mockGetCommercialOrder.mockResolvedValue(order(changes));
    await expect(
      recordCommercialMembershipFulfillment(request as any),
    ).rejects.toThrow(error);
    expect(mockSetCommercialFulfillment).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing package", [pkg(STUDENTS)], /not found/],
    [
      "a package owned by someone else",
      [pkg(STUDENTS), pkg(INSTRUCTOR, { owner_account_id: "someone-else" })],
      /not owned by the order's customer/,
    ],
    [
      "a site-license pool",
      [pkg(STUDENTS), pkg(INSTRUCTOR, { kind: "site" })],
      /site-license pool/,
    ],
    [
      "a package created for another order",
      [
        pkg(STUDENTS),
        pkg(INSTRUCTOR, {
          metadata: { commercial_order_number: "AR-2026-OTHER" },
        }),
      ],
      /not created for AR-2026-170745EA/,
    ],
    [
      "a package without order provenance",
      [pkg(STUDENTS), pkg(INSTRUCTOR, { metadata: {} })],
      /not created for/,
    ],
    [
      "a package that has not started",
      [
        pkg(STUDENTS),
        pkg(INSTRUCTOR, { starts_at: new Date(Date.now() + DAY) }),
      ],
      /not started/,
    ],
    [
      "an expired package",
      [
        pkg(STUDENTS),
        pkg(INSTRUCTOR, { expires_at: new Date(Date.now() - 1000) }),
      ],
      /already expired/,
    ],
    [
      "a package ending before the service term",
      [
        pkg(STUDENTS),
        pkg(INSTRUCTOR, {
          expires_at: new Date(SERVICE_ENDS.valueOf() - DAY),
        }),
      ],
      /ends before the order's service term/,
    ],
  ])("rejects %s", async (_label, rows, error) => {
    mockGetMembershipPackages.mockResolvedValue(rows);
    await expect(
      recordCommercialMembershipFulfillment(request as any),
    ).rejects.toThrow(error);
    expect(mockSetCommercialFulfillment).not.toHaveBeenCalled();
  });
});
