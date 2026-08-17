/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

const mockUserIsInGroup = jest.fn();
const mockGetConn = jest.fn();
const mockSend = jest.fn();

jest.mock("@cocalc/server/accounts/is-in-group", () => ({
  __esModule: true,
  default: (...args: any[]) => mockUserIsInGroup(...args),
}));

jest.mock("@cocalc/server/stripe/connection", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetConn(...args),
}));

jest.mock("@cocalc/server/messages/send", () => ({
  __esModule: true,
  default: (...args: any[]) => mockSend(...args),
  name: jest.fn().mockResolvedValue("Test User"),
  support: jest.fn().mockResolvedValue("Support"),
  url: jest.fn(async (...args) => args.join("/")),
}));

import { uuid } from "@cocalc/util/misc";
import { after, before, getPool } from "@cocalc/server/test";
import createCredit from "./create-credit";
import createPurchase from "./create-purchase";
import createRefund from "./create-refund";
import getBalance from "./get-balance";
import {
  createTestAccount,
  createTestMembershipPackage,
  createTestMembershipSubscription,
} from "./test-data";
import {
  assignMembershipPackageSeat,
  listMembershipPackageAssignments,
} from "@cocalc/server/membership/packages";
import { recordPersonalMembershipPeriod } from "@cocalc/server/membership/personal-allocation-analytics";

beforeAll(async () => {
  await before({ noConat: true });
}, 15_000);
afterAll(after);

describe("membership admin refund", () => {
  beforeEach(() => {
    mockUserIsInGroup.mockReset().mockResolvedValue(true);
    mockSend.mockReset().mockResolvedValue(undefined);
    mockGetConn.mockReset().mockResolvedValue({
      charges: {
        list: jest.fn().mockResolvedValue({ data: [{ id: "ch_membership" }] }),
        retrieve: jest.fn().mockResolvedValue({
          id: "ch_membership",
          amount: 2400,
          amount_refunded: 0,
          refunded: false,
        }),
      },
      invoicePayments: {
        list: jest.fn().mockResolvedValue({ data: [] }),
      },
      invoices: {
        retrieve: jest.fn().mockResolvedValue({
          id: "in_membership",
          charge: "ch_membership",
          payment_intent: "pi_membership",
        }),
      },
      paymentIntents: {
        retrieve: jest.fn().mockResolvedValue({
          id: "pi_membership",
          invoice: "in_membership",
          latest_charge: "ch_membership",
          metadata: { invoice_id: "in_membership" },
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      refunds: {
        create: jest.fn().mockResolvedValue({
          id: "re_membership",
          status: "succeeded",
        }),
        list: jest.fn().mockResolvedValue({ data: [] }),
      },
    });
  });

  it("refunds membership and Stripe credit independently", async () => {
    const account_id = uuid();
    const admin_account_id = uuid();
    await createTestAccount(account_id);
    const creditId = await createCredit({
      account_id,
      amount: 24,
      invoice_id: "pi_membership",
      description: { purpose: "membership-change" },
    });
    const { subscription_id } = await createTestMembershipSubscription(
      account_id,
      {
        cost: 24,
        end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    );
    const membershipPurchaseId = await createPurchase({
      account_id,
      service: "membership",
      cost: 24,
      description: {
        type: "membership",
        subscription_id,
        credit_id: creditId,
        class: "member",
        interval: "month",
      },
      tag: "membership-change",
      period_start: new Date(),
      period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      client: null,
    });
    await getPool().query(
      `UPDATE subscriptions
          SET latest_purchase_id=$2,
              payment=$3
        WHERE id=$1`,
      [
        subscription_id,
        membershipPurchaseId,
        {
          payment_intent_id: "pi_membership",
          amount: 24,
          created: Date.now(),
          status: "paid",
          new_expires_ms: Date.now() + 30 * 24 * 60 * 60 * 1000,
        },
      ],
    );

    const refundPurchaseId = await createRefund({
      account_id: admin_account_id,
      purchase_id: membershipPurchaseId,
      reason: "duplicate",
      notes: "Duplicate membership charge",
    });
    await expect(
      createRefund({
        account_id: admin_account_id,
        purchase_id: membershipPurchaseId,
        reason: "duplicate",
        notes: "Duplicate membership charge",
      }),
    ).resolves.toBe(refundPurchaseId);

    expect(mockGetConn).not.toHaveBeenCalled();

    const { rows: subscriptions } = await getPool().query(
      `SELECT status, current_period_end, canceled_reason,
              payment#>>'{status}' AS payment_status
         FROM subscriptions
        WHERE id=$1`,
      [subscription_id],
    );
    expect(subscriptions[0].status).toBe("canceled");
    expect(subscriptions[0].payment_status).toBe("canceled");
    expect(
      new Date(subscriptions[0].current_period_end).getTime(),
    ).toBeLessThanOrEqual(Date.now());
    expect(subscriptions[0].canceled_reason).toContain("Admin refund");

    const { rows: originals } = await getPool().query(
      `SELECT id, description->>'refund_purchase_id' AS refund_purchase_id
         FROM purchases
        WHERE id IN ($1,$2)
        ORDER BY id`,
      [creditId, membershipPurchaseId],
    );
    expect(originals).toEqual([
      { id: creditId, refund_purchase_id: null },
      {
        id: membershipPurchaseId,
        refund_purchase_id: `${refundPurchaseId}`,
      },
    ]);

    const { rows: refunds } = await getPool().query(
      `SELECT cost, description
         FROM purchases
        WHERE service='refund'
          AND account_id=$1
        ORDER BY id`,
      [account_id],
    );
    expect(refunds).toHaveLength(1);
    expect(Number(refunds[0].cost)).toBe(-24);
    expect(refunds[0].description).toMatchObject({
      purchase_id: membershipPurchaseId,
    });
    expect(Number(await getBalance({ account_id }))).toBe(24);
    expect(mockSend).toHaveBeenCalledTimes(1);

    await createRefund({
      account_id: admin_account_id,
      purchase_id: creditId,
      reason: "duplicate",
      notes: "Refund the related Stripe charge",
    });

    const stripe = await mockGetConn.mock.results[0].value;
    expect(stripe.refunds.create).toHaveBeenCalledTimes(1);
    expect(stripe.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({
        charge: "ch_membership",
        reason: "duplicate",
      }),
      { idempotencyKey: `cocalc-refund-purchase-${creditId}` },
    );
    expect(Number(await getBalance({ account_id }))).toBe(0);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("refunds an older membership period without touching its credit", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    const creditId = await createCredit({
      account_id,
      amount: 24,
      invoice_id: "pi_old_membership",
      description: { purpose: "subscription-renewal" },
    });
    const { subscription_id } = await createTestMembershipSubscription(
      account_id,
      {
        cost: 24,
      },
    );
    const oldPurchaseId = await createPurchase({
      account_id,
      service: "membership",
      cost: 24,
      description: {
        type: "membership",
        subscription_id,
        credit_id: creditId,
        class: "member",
        interval: "month",
      },
      client: null,
    });
    const latestPurchaseId = await createPurchase({
      account_id,
      service: "membership",
      cost: 24,
      description: {
        type: "membership",
        subscription_id,
        class: "member",
        interval: "month",
      },
      client: null,
    });
    await getPool().query(
      "UPDATE subscriptions SET latest_purchase_id=$2 WHERE id=$1",
      [subscription_id, latestPurchaseId],
    );

    const refundPurchaseId = await createRefund({
      account_id: uuid(),
      purchase_id: oldPurchaseId,
      reason: "requested_by_customer",
      notes: "Wrong period",
    });

    expect(mockGetConn).not.toHaveBeenCalled();
    const { rows: purchases } = await getPool().query(
      `SELECT id, description
         FROM purchases
        WHERE id IN ($1,$2,$3)
        ORDER BY id`,
      [creditId, oldPurchaseId, latestPurchaseId],
    );
    expect(purchases[0]?.description?.refund_purchase_id).toBeUndefined();
    expect(purchases[1]?.description?.refund_purchase_id).toBe(
      refundPurchaseId,
    );
    expect(purchases[2]?.description?.refund_purchase_id).toBeUndefined();
    const { rows: subscriptions } = await getPool().query(
      "SELECT status, latest_purchase_id FROM subscriptions WHERE id=$1",
      [subscription_id],
    );
    expect(subscriptions[0]).toMatchObject({
      latest_purchase_id: latestPurchaseId,
      status: "canceled",
    });
  });

  it("restores balance-funded membership cost without calling Stripe", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    await createCredit({
      account_id,
      amount: 24,
      description: { purpose: "account-credit" },
    });
    const { subscription_id, start, end, membershipClass, interval } =
      await createTestMembershipSubscription(account_id, { cost: 24 });
    const membershipPurchaseId = await createPurchase({
      account_id,
      service: "membership",
      cost: 24,
      description: {
        type: "membership",
        subscription_id,
        class: "member",
        interval: "month",
      },
      tag: "membership-change",
      client: null,
    });
    await getPool().query(
      "UPDATE subscriptions SET latest_purchase_id=$2 WHERE id=$1",
      [subscription_id, membershipPurchaseId],
    );
    await recordPersonalMembershipPeriod({
      account_id,
      subscription_id,
      purchase_id: membershipPurchaseId,
      membership_class: membershipClass,
      billing_interval: interval,
      lifecycle: "first_paid",
      allocation_start: start,
      allocation_end: end,
      revenue: 24,
      client: getPool(),
    });

    const refundPurchaseId = await createRefund({
      account_id: uuid(),
      purchase_id: membershipPurchaseId,
      reason: "requested_by_customer",
      notes: "Balance-funded membership",
    });

    expect(mockGetConn).not.toHaveBeenCalled();
    expect(Number(await getBalance({ account_id }))).toBe(24);
    const { rows } = await getPool().query(
      "SELECT status, current_period_end FROM subscriptions WHERE id=$1",
      [subscription_id],
    );
    expect(rows[0]?.status).toBe("canceled");
    expect(new Date(rows[0]?.current_period_end).getTime()).toBeLessThanOrEqual(
      Date.now(),
    );
    const { rows: allocations } = await getPool().query(
      `SELECT purchase_id, source_kind, active_memberships, revenue_cents,
              reverses_fact_key
         FROM membership_allocation_facts
        WHERE purchase_id IN ($1,$2)
        ORDER BY active_memberships DESC`,
      [membershipPurchaseId, refundPurchaseId],
    );
    expect(allocations).toEqual([
      {
        purchase_id: membershipPurchaseId,
        source_kind: "purchase",
        active_memberships: 1,
        revenue_cents: "2400",
        reverses_fact_key: null,
      },
      {
        purchase_id: refundPurchaseId,
        source_kind: "refund",
        active_memberships: -1,
        revenue_cents: "-2400",
        reverses_fact_key: `personal:purchase:${membershipPurchaseId}:first_paid`,
      },
    ]);
  });

  it("creates an accounting reversal for another finalized service", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    const purchaseId = await createPurchase({
      account_id,
      service: "dedicated-host",
      cost: 3,
      description: {
        type: "dedicated-host",
        host_id: uuid(),
        provider: "test",
        funding_lane: "prepaid",
        hourly_cost_usd: 1,
      },
      client: null,
    });

    const refundPurchaseId = await createRefund({
      account_id: uuid(),
      purchase_id: purchaseId,
      reason: "duplicate",
      notes: "Duplicate accounting transaction",
    });

    expect(mockGetConn).not.toHaveBeenCalled();
    const { rows } = await getPool().query(
      "SELECT cost, description FROM purchases WHERE id=$1",
      [refundPurchaseId],
    );
    expect(Number(rows[0]?.cost)).toBe(-3);
    expect(rows[0]?.description).toMatchObject({
      purchase_id: purchaseId,
      reason: "duplicate",
      type: "refund",
    });
    expect(Number(await getBalance({ account_id }))).toBe(0);
  });

  it("expires a refunded membership package and revokes its seats", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    const packageId = await createTestMembershipPackage({
      owner_account_id: account_id,
      kind: "team",
      membership_class: "member",
      seat_count: 1,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    const purchaseId = await createPurchase({
      account_id,
      service: "membership",
      cost: 30,
      description: {
        type: "membership-package",
        package_id: packageId,
        kind: "team",
        membership_class: "member",
        seat_count: 1,
        seat_price: 30,
        total_price: 30,
        expanded_existing_package: false,
      },
      client: null,
    });
    await getPool().query(
      "UPDATE membership_packages SET purchase_id=$2 WHERE id=$1",
      [packageId, purchaseId],
    );
    await assignMembershipPackageSeat({
      package_id: packageId,
      account_id,
      assigned_by_account_id: account_id,
    });

    const refundPurchaseId = await createRefund({
      account_id: uuid(),
      purchase_id: purchaseId,
      reason: "duplicate",
      notes: "Duplicate package transaction",
    });
    await expect(
      createRefund({
        account_id: uuid(),
        purchase_id: purchaseId,
        reason: "duplicate",
        notes: "Duplicate package transaction",
      }),
    ).resolves.toBe(refundPurchaseId);

    expect(mockGetConn).not.toHaveBeenCalled();
    const { rows: refunds } = await getPool().query(
      "SELECT cost, description FROM purchases WHERE id=$1",
      [refundPurchaseId],
    );
    expect(Number(refunds[0]?.cost)).toBe(-30);
    expect(refunds[0]?.description?.purchase_id).toBe(purchaseId);
    const { rows: packages } = await getPool().query(
      "SELECT expires_at FROM membership_packages WHERE id=$1",
      [packageId],
    );
    expect(new Date(packages[0]?.expires_at).getTime()).toBeLessThanOrEqual(
      Date.now(),
    );
    const assignments = await listMembershipPackageAssignments({
      package_id: packageId,
      include_revoked: true,
    });
    expect(assignments).toHaveLength(1);
    expect(assignments[0]?.revoked_at).toBeInstanceOf(Date);
    const { rows: grants } = await getPool().query(
      "SELECT revoked_at FROM membership_grants WHERE package_id=$1",
      [packageId],
    );
    expect(grants).toHaveLength(1);
    expect(grants[0]?.revoked_at).not.toBeNull();
    expect(Number(await getBalance({ account_id }))).toBe(0);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("refunds an unassigned package seat expansion", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    const packageId = await createTestMembershipPackage({
      owner_account_id: account_id,
      kind: "team",
      membership_class: "member",
      seat_count: 3,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    await assignMembershipPackageSeat({
      package_id: packageId,
      account_id,
      assigned_by_account_id: account_id,
    });
    const purchaseId = await createPurchase({
      account_id,
      service: "membership",
      cost: 60,
      description: {
        type: "membership-package",
        package_id: packageId,
        kind: "team",
        membership_class: "member",
        seat_count: 2,
        seat_price: 30,
        total_price: 60,
        expanded_existing_package: true,
      },
      client: null,
    });

    await createRefund({
      account_id: uuid(),
      purchase_id: purchaseId,
      reason: "requested_by_customer",
      notes: "Unused expansion",
    });

    const { rows: packages } = await getPool().query(
      "SELECT seat_count, expires_at FROM membership_packages WHERE id=$1",
      [packageId],
    );
    expect(packages[0]?.seat_count).toBe(1);
    expect(new Date(packages[0]?.expires_at).getTime()).toBeGreaterThan(
      Date.now(),
    );
    const assignments = await listMembershipPackageAssignments({
      package_id: packageId,
      include_revoked: true,
    });
    expect(assignments[0]?.revoked_at).toBeUndefined();
    expect(Number(await getBalance({ account_id }))).toBe(0);
  });

  it("does not refund a package expansion while its seats are assigned", async () => {
    const account_id = uuid();
    const second_account_id = uuid();
    await createTestAccount(account_id);
    await createTestAccount(second_account_id);
    const packageId = await createTestMembershipPackage({
      owner_account_id: account_id,
      kind: "team",
      membership_class: "member",
      seat_count: 3,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    for (const target of [account_id, second_account_id]) {
      await assignMembershipPackageSeat({
        package_id: packageId,
        account_id: target,
        assigned_by_account_id: account_id,
      });
    }
    const purchaseId = await createPurchase({
      account_id,
      service: "membership",
      cost: 60,
      description: {
        type: "membership-package",
        package_id: packageId,
        kind: "team",
        membership_class: "member",
        seat_count: 2,
        seat_price: 30,
        total_price: 60,
        expanded_existing_package: true,
      },
      client: null,
    });

    await expect(
      createRefund({
        account_id: uuid(),
        purchase_id: purchaseId,
        reason: "requested_by_customer",
        notes: "Seats still assigned",
      }),
    ).rejects.toThrow("Revoke at least 1 assigned seat");

    const { rows: packages } = await getPool().query(
      "SELECT seat_count FROM membership_packages WHERE id=$1",
      [packageId],
    );
    expect(packages[0]?.seat_count).toBe(3);
    const { rows: refunds } = await getPool().query(
      `SELECT id FROM purchases
        WHERE service='refund'
          AND description->>'purchase_id'=$1`,
      [`${purchaseId}`],
    );
    expect(refunds).toHaveLength(0);
  });

  it("requires expansions to be refunded before the original package", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    const packageId = await createTestMembershipPackage({
      owner_account_id: account_id,
      kind: "team",
      membership_class: "member",
      seat_count: 2,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    const originalPurchaseId = await createPurchase({
      account_id,
      service: "membership",
      cost: 30,
      description: {
        type: "membership-package",
        package_id: packageId,
        kind: "team",
        membership_class: "member",
        seat_count: 1,
        seat_price: 30,
        total_price: 30,
        expanded_existing_package: false,
      },
      client: null,
    });
    await getPool().query(
      "UPDATE membership_packages SET purchase_id=$2 WHERE id=$1",
      [packageId, originalPurchaseId],
    );
    const expansionPurchaseId = await createPurchase({
      account_id,
      service: "membership",
      cost: 30,
      description: {
        type: "membership-package",
        package_id: packageId,
        kind: "team",
        membership_class: "member",
        seat_count: 1,
        seat_price: 30,
        total_price: 30,
        expanded_existing_package: true,
      },
      client: null,
    });

    await expect(
      createRefund({
        account_id: uuid(),
        purchase_id: originalPurchaseId,
        reason: "requested_by_customer",
        notes: "Refund package",
      }),
    ).rejects.toThrow(
      `Refund membership package expansion transaction ${expansionPurchaseId}`,
    );

    const { rows: packages } = await getPool().query(
      "SELECT expires_at FROM membership_packages WHERE id=$1",
      [packageId],
    );
    expect(new Date(packages[0]?.expires_at).getTime()).toBeGreaterThan(
      Date.now(),
    );
  });
});
