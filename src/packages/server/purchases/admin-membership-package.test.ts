/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getPool } from "@cocalc/server/test";
import { after, before } from "@cocalc/server/test";
import { uuid } from "@cocalc/util/misc";
import adminCreateMembershipPackagePurchase from "./admin-membership-package";
import { createTestAccount, createTestMembershipTier } from "./test-data";

const mockCreatePaymentIntent = jest.fn();

jest.mock("@cocalc/server/purchases/stripe/create-payment-intent", () => ({
  __esModule: true,
  default: (...args: any[]) => mockCreatePaymentIntent(...args),
}));

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);

afterAll(after);

describe("admin membership package purchase", () => {
  const membershipClass = `admin-package-${uuid()}`;

  beforeAll(async () => {
    await createTestMembershipTier({
      id: membershipClass,
      priority: 25,
      price_monthly: 20,
      price_yearly: 200,
      team_visible: true,
    });
  });

  beforeEach(() => {
    mockCreatePaymentIntent.mockReset();
  });

  it("atomically creates a custom-price package and reuses its idempotency key", async () => {
    const admin_account_id = uuid();
    const user_account_id = uuid();
    await createTestAccount(admin_account_id);
    await createTestAccount(user_account_id);
    await getPool().query(
      "UPDATE accounts SET groups=$2::TEXT[] WHERE account_id=$1",
      [admin_account_id, ["admin"]],
    );
    const starts_at = new Date("2026-08-10T00:00:00Z");
    const expires_at = new Date("2026-08-22T00:00:00Z");
    const options = {
      admin_account_id,
      user_account_id,
      product: {
        type: "membership-package" as const,
        kind: "team" as const,
        membership_class: membershipClass,
        seat_count: 5,
        interval: "month" as const,
        starts_at,
        expires_at,
      },
      price: 25,
      source: "free" as const,
      reason: "support ticket 20443 approved offer",
      idempotency_key: "ticket-20443-test",
      pricing_note: "custom camp package",
    };

    const created = await adminCreateMembershipPackagePurchase(options);
    expect(created).toMatchObject({
      price: 25,
      standard_price: 100,
      existing: false,
    });
    expect(created.credit_id).toBeDefined();
    expect(created.starts_at).toEqual(starts_at);
    expect(created.expires_at).toEqual(expires_at);

    const repeated = await adminCreateMembershipPackagePurchase(options);
    expect(repeated).toMatchObject({
      package_id: created.package_id,
      purchase_id: created.purchase_id,
      credit_id: created.credit_id,
      existing: true,
    });

    const packages = await getPool().query(
      `SELECT purchase_id, seat_count, starts_at, expires_at, metadata
         FROM membership_packages
        WHERE id=$1 AND owner_account_id=$2`,
      [created.package_id, user_account_id],
    );
    expect(packages.rows).toHaveLength(1);
    expect(packages.rows[0]).toMatchObject({
      purchase_id: created.purchase_id,
      seat_count: 5,
    });
    expect(packages.rows[0].metadata).toMatchObject({
      admin_custom_price: 25,
      standard_total_price: 100,
    });

    const audit = await getPool().query(
      `SELECT reason, metadata
         FROM account_admin_audit_log
        WHERE account_id=$1 AND action='membership-package-purchase'`,
      [user_account_id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].reason).toBe("support ticket 20443 approved offer");
    expect(audit.rows[0].metadata).toMatchObject({
      package_id: created.package_id,
      purchase_id: created.purchase_id,
      custom_price: 25,
      standard_price: 100,
      seat_count: 5,
      source: "free",
    });
  });

  it("charges a saved card before creating the custom package", async () => {
    const admin_account_id = uuid();
    const user_account_id = uuid();
    await createTestAccount(admin_account_id);
    await createTestAccount(user_account_id);
    await getPool().query(
      "UPDATE accounts SET groups=$2::TEXT[] WHERE account_id=$1",
      [admin_account_id, ["admin"]],
    );
    mockCreatePaymentIntent.mockImplementation(
      async ({ account_id, lineItems }) => {
        const payment_intent = `pi_${uuid()}`;
        await getPool().query(
          `INSERT INTO purchases
             (service, time, account_id, cost, description, invoice_id)
           VALUES ('credit', NOW(), $1, $2, $3::jsonb, $4)`,
          [
            account_id,
            -lineItems[0].amount,
            { type: "credit", purpose: "admin-membership-package-purchase" },
            payment_intent,
          ],
        );
        return {
          payment_intent,
          hosted_invoice_url: `https://stripe.test/${payment_intent}`,
        };
      },
    );

    const created = await adminCreateMembershipPackagePurchase({
      admin_account_id,
      user_account_id,
      product: {
        type: "membership-package",
        kind: "team",
        membership_class: membershipClass,
        seat_count: 5,
        interval: "month",
      },
      price: 25,
      source: "card",
      reason: "support ticket 20443 accepted offer",
      idempotency_key: "ticket-20443-card-test",
    });

    expect(mockCreatePaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: user_account_id,
        allowedPaymentMethodTypes: ["card"],
        lineItems: [
          expect.objectContaining({
            amount: 25,
          }),
        ],
      }),
    );
    expect(created).toMatchObject({
      price: 25,
      existing: false,
      payment_intent_id: expect.stringMatching(/^pi_/),
      hosted_invoice_url: expect.stringContaining("https://stripe.test/pi_"),
    });
    expect(created.credit_id).toBeDefined();

    const purchase = await getPool().query(
      `SELECT cost, description
         FROM purchases
        WHERE id=$1`,
      [created.purchase_id],
    );
    expect(Number(purchase.rows[0].cost)).toBe(25);
    expect(purchase.rows[0].description).toMatchObject({
      admin_funding_credit_id: created.credit_id,
      admin_payment_intent_id: created.payment_intent_id,
    });

    const repeated = await adminCreateMembershipPackagePurchase({
      admin_account_id,
      user_account_id,
      product: {
        type: "membership-package",
        kind: "team",
        membership_class: membershipClass,
        seat_count: 5,
        interval: "month",
      },
      price: 25,
      source: "card",
      reason: "support ticket 20443 accepted offer",
      idempotency_key: "ticket-20443-card-test",
    });
    expect(repeated).toMatchObject({
      package_id: created.package_id,
      purchase_id: created.purchase_id,
      existing: true,
      payment_intent_id: created.payment_intent_id,
    });
    expect(mockCreatePaymentIntent).toHaveBeenCalledTimes(1);
  });

  it("fulfills the immutable approved quote when tier configuration changes after funding", async () => {
    const admin_account_id = uuid();
    const user_account_id = uuid();
    const mutableMembershipClass = `admin-package-mutable-${uuid()}`;
    await createTestAccount(admin_account_id);
    await createTestAccount(user_account_id);
    await createTestMembershipTier({
      id: mutableMembershipClass,
      priority: 25,
      price_monthly: 20,
      price_yearly: 200,
      team_visible: true,
    });
    await getPool().query(
      "UPDATE accounts SET groups=$2::TEXT[] WHERE account_id=$1",
      [admin_account_id, ["admin"]],
    );
    mockCreatePaymentIntent.mockImplementation(async ({ account_id }) => {
      const payment_intent = `pi_${uuid()}`;
      await getPool().query(
        `INSERT INTO purchases
           (service, time, account_id, cost, description, invoice_id)
         VALUES ('credit', NOW(), $1, -25, $2::jsonb, $3)`,
        [
          account_id,
          { type: "credit", purpose: "admin-membership-package-purchase" },
          payment_intent,
        ],
      );
      await getPool().query(
        "UPDATE membership_tiers SET disabled=TRUE, updated=NOW() WHERE id=$1",
        [mutableMembershipClass],
      );
      return {
        payment_intent,
        hosted_invoice_url: `https://stripe.test/${payment_intent}`,
      };
    });

    try {
      const created = await adminCreateMembershipPackagePurchase({
        admin_account_id,
        user_account_id,
        product: {
          type: "membership-package",
          kind: "team",
          membership_class: mutableMembershipClass,
          seat_count: 5,
          interval: "month",
        },
        price: 25,
        source: "card",
        reason: "approved quote must survive post-funding configuration drift",
        idempotency_key: "post-funding-tier-drift",
      });

      expect(created).toMatchObject({
        price: 25,
        standard_price: 100,
        existing: false,
      });
      const pkg = await getPool().query(
        `SELECT membership_class, seat_count, metadata
           FROM membership_packages
          WHERE id=$1`,
        [created.package_id],
      );
      expect(pkg.rows[0]).toMatchObject({
        membership_class: mutableMembershipClass,
        seat_count: 5,
        metadata: expect.objectContaining({ standard_total_price: 100 }),
      });
      const intents = await getPool().query(
        "SELECT invoice_id FROM admin_membership_package_intents WHERE account_id=$1",
        [user_account_id],
      );
      expect(intents.rows).toHaveLength(0);
    } finally {
      await getPool().query(
        "UPDATE membership_tiers SET disabled=FALSE, updated=NOW() WHERE id=$1",
        [mutableMembershipClass],
      );
    }
  });

  it("validates package dates before attempting card funding", async () => {
    const admin_account_id = uuid();
    const user_account_id = uuid();
    await createTestAccount(admin_account_id);
    await createTestAccount(user_account_id);
    await getPool().query(
      "UPDATE accounts SET groups=$2::TEXT[] WHERE account_id=$1",
      [admin_account_id, ["admin"]],
    );

    await expect(
      adminCreateMembershipPackagePurchase({
        admin_account_id,
        user_account_id,
        product: {
          type: "membership-package",
          kind: "team",
          membership_class: membershipClass,
          seat_count: 1,
          interval: "month",
          starts_at: new Date("2026-10-02T00:00:00Z"),
          expires_at: new Date("2026-10-01T00:00:00Z"),
        },
        price: 25,
        source: "card",
        reason: "invalid date ordering must fail before Stripe",
        idempotency_key: "invalid-dates-before-card",
      }),
    ).rejects.toThrow("expires_at must be after starts_at");
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
  });

  it("does not create a package when card funding needs user action", async () => {
    const admin_account_id = uuid();
    const user_account_id = uuid();
    await createTestAccount(admin_account_id);
    await createTestAccount(user_account_id);
    await getPool().query(
      "UPDATE accounts SET groups=$2::TEXT[] WHERE account_id=$1",
      [admin_account_id, ["admin"]],
    );
    mockCreatePaymentIntent.mockResolvedValue({
      payment_intent: `pi_${uuid()}`,
      hosted_invoice_url: "https://stripe.test/action-required",
    });

    await expect(
      adminCreateMembershipPackagePurchase({
        admin_account_id,
        user_account_id,
        product: {
          type: "membership-package",
          kind: "team",
          membership_class: membershipClass,
          seat_count: 5,
          interval: "month",
        },
        price: 25,
        source: "card",
        reason: "support ticket 20443 accepted offer",
        idempotency_key: "ticket-20443-card-action-test",
      }),
    ).rejects.toThrow(
      "The saved card could not be charged automatically. Complete the invoice and retry: https://stripe.test/action-required",
    );

    const packages = await getPool().query(
      `SELECT id
         FROM membership_packages
        WHERE owner_account_id=$1`,
      [user_account_id],
    );
    expect(packages.rows).toHaveLength(0);
    const purchases = await getPool().query(
      `SELECT id
         FROM purchases
        WHERE account_id=$1
          AND invoice_id LIKE 'admin-membership-package:%'`,
      [user_account_id],
    );
    expect(purchases.rows).toHaveLength(0);
    const intents = await getPool().query(
      "SELECT invoice_id FROM admin_membership_package_intents WHERE account_id=$1",
      [user_account_id],
    );
    expect(intents.rows).toHaveLength(1);
  });
});
