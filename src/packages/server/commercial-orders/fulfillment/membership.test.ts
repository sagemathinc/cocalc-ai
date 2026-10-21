/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/** @jest-environment node */

const mockQuery = jest.fn();
const mockGetCommercialOrder = jest.fn();
const mockSetCommercialFulfillment = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: (...args: any[]) => mockQuery(...args) }),
}));

jest.mock("../store", () => ({
  commercialIdempotencyKey: (operation: string) => `${operation}:key`,
  getCommercialOrder: (...args: any[]) => mockGetCommercialOrder(...args),
  setCommercialFulfillment: (...args: any[]) =>
    mockSetCommercialFulfillment(...args),
}));

import { recordCommercialMembershipFulfillment } from "./membership";

const CUSTOMER = "8c64771e-8f3d-45d1-a016-52bf88605454";
const STUDENTS = "7b378d3c-28d8-4a03-8d30-98cec8926a53";
const INSTRUCTOR = "8fabbf12-8111-45bd-ab99-bdcd6a27bd31";
const FUTURE = new Date(Date.now() + 90 * 24 * 3600 * 1000);

function order(changes: Record<string, unknown> = {}) {
  return {
    id: "co_1",
    order_number: "AR-2026-170745EA",
    workflow_state: "awaiting_payment",
    collection_state: "paid",
    fulfillment_state: "not_provisioned",
    site_license_id: null,
    customer_account_id: CUSTOMER,
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
    starts_at: new Date("2026-10-17T19:35:00Z"),
    expires_at: FUTURE,
    ...changes,
  };
}

const request = {
  id: "co_1",
  account_id: "admin_1",
  expected_version: 14,
  reason: "record bridge packages",
  membership_package_ids: [STUDENTS, INSTRUCTOR],
};

describe("recordCommercialMembershipFulfillment", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockGetCommercialOrder.mockReset().mockResolvedValue(order());
    mockSetCommercialFulfillment
      .mockReset()
      .mockImplementation(async (opts) => ({
        ...order(),
        fulfillment_state: opts.fulfillment_state,
      }));
    mockQuery.mockResolvedValue({
      rows: [
        pkg(STUDENTS),
        pkg(INSTRUCTOR, {
          membership_class: "instructor-purchase",
          seat_count: 1,
        }),
      ],
    });
  });

  it("records provisioned fulfillment with the package references", async () => {
    const result = await recordCommercialMembershipFulfillment(request as any);

    expect(result.fulfillment_state).toBe("provisioned");
    expect(mockSetCommercialFulfillment).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "co_1",
        account_id: "admin_1",
        expected_version: 14,
        reason: "record bridge packages",
        fulfillment_state: "provisioned",
        idempotency_key: "membership-fulfillment:key",
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
    expect(mockQuery.mock.calls[0][1]).toEqual([[STUDENTS, INSTRUCTOR]]);
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
      "already provisioned",
      { fulfillment_state: "provisioned" },
      /already provisioned/,
    ],
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
      "an expired package",
      [
        pkg(STUDENTS),
        pkg(INSTRUCTOR, { expires_at: new Date(Date.now() - 1000) }),
      ],
      /already expired/,
    ],
  ])("rejects %s", async (_label, rows, error) => {
    mockQuery.mockResolvedValue({ rows });
    await expect(
      recordCommercialMembershipFulfillment(request as any),
    ).rejects.toThrow(error);
    expect(mockSetCommercialFulfillment).not.toHaveBeenCalled();
  });
});
