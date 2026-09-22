/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getPool } from "@cocalc/server/test";
import { after, before } from "@cocalc/server/test";
import { uuid } from "@cocalc/util/misc";
import {
  normalizeAdminMembershipPackageProduct,
  normalizeAdminMembershipPackageBusinessIdentity,
  adminMembershipPackageBusinessIdentityHash,
  legacyAdminMembershipPackageRequestHash,
  adminMembershipPackageInvoiceId,
} from "./admin-membership-package-identity";
import adminCreateMembershipPackagePurchase from "./admin-membership-package";
import { createTestAccount, createTestMembershipTier } from "./test-data";
import type { AdminMembershipPackagePurchaseOptions } from "./admin-membership-package";
import { bindAdminMembershipPayment } from "./admin-membership-orders";
import { processPaymentIntent } from "./stripe/process-payment-intents";
import getSpendableBalance from "./get-spendable-balance";
import getBalance from "./get-balance";
import createCredit from "./create-credit";
import {
  withFundingAccountTransaction,
  reserveAccountFundingBacking,
} from "../compute/funding/backing";
import {
  assignMembershipPackageSeat,
  revokeMembershipPackageSeat,
} from "@cocalc/server/membership/packages";
import { resolveMembershipForAccount } from "@cocalc/server/membership/resolve";

const mockCreatePaymentIntent = jest.fn();
const mockGetStripe = jest.fn();
jest.mock("@cocalc/server/stripe/connection", () => ({
  __esModule: true,
  default: (...args) => mockGetStripe(...args),
}));
jest.mock("./stripe/util", () => ({
  ...jest.requireActual("./stripe/util"),
  getStripeCustomerId: jest.fn(async ({ account_id }) => `cus_${account_id}`),
  currentStripeSite: jest.fn(async () => "test.cocalc.ai"),
}));
jest.mock("@cocalc/server/messages/send", () => ({
  __esModule: true,
  default: jest.fn(async () => undefined),
  name: jest.fn(async () => "Customer"),
  support: jest.fn(async () => "Support"),
  url: jest.fn(async () => "https://test.cocalc.ai"),
}));
jest.mock("@cocalc/server/messages/admin-alert", () => ({
  __esModule: true,
  default: jest.fn(async () => undefined),
}));
jest.mock("@cocalc/server/email/send-email", () => ({
  __esModule: true,
  default: jest.fn(async () => undefined),
}));

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
    mockGetStripe.mockReset();
  });

  it("creates a free fixed-term Student team package the owner can assign without renewal", async () => {
    const admin_account_id = uuid();
    const user_account_id = uuid();
    const student_account_id = uuid();
    for (const account_id of [
      admin_account_id,
      user_account_id,
      student_account_id,
    ]) {
      await createTestAccount(account_id);
    }
    await getPool().query(
      "UPDATE accounts SET groups=ARRAY['admin'] WHERE account_id=$1",
      [admin_account_id],
    );
    const studentTier = `student-${uuid()}`;
    await createTestMembershipTier({
      id: studentTier,
      priority: 12,
      team_visible: false,
      course_store_visible: true,
      price_monthly: 8,
    });
    const expires_at = new Date(Date.now() + 90 * 86400000);
    const options = {
      admin_account_id,
      user_account_id,
      product: {
        type: "membership-package" as const,
        kind: "team" as const,
        membership_class: studentTier,
        seat_count: 10,
        interval: "month" as const,
        expires_at,
      },
      price: 0,
      source: "free" as const,
      reason: "approved hardship seats",
      idempotency_key: `hardship-${uuid()}`,
    };
    await expect(
      adminCreateMembershipPackagePurchase({
        ...options,
        admin_account_id: user_account_id,
      }),
    ).rejects.toThrow("must be an admin");
    const result = await adminCreateMembershipPackagePurchase(options);
    expect(result.price).toBe(0);
    expect(result.expires_at).toEqual(expires_at);
    expect(
      (await adminCreateMembershipPackagePurchase(options)).package_id,
    ).toBe(result.package_id);
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
    const assignment = await assignMembershipPackageSeat({
      assigned_by_account_id: user_account_id,
      package_id: result.package_id,
      account_id: student_account_id,
    });
    expect(assignment.account_id).toBe(student_account_id);
    const membership = await resolveMembershipForAccount(student_account_id);
    expect(membership.class).toBe(studentTier);
    expect(new Date(membership.expires!).valueOf()).toBe(expires_at.valueOf());
    expect(
      (
        await getPool().query(
          "SELECT id FROM team_licenses WHERE owner_account_id=$1",
          [user_account_id],
        )
      ).rows,
    ).toHaveLength(0);
    await revokeMembershipPackageSeat({
      package_id: result.package_id,
      account_id: student_account_id,
    });
    expect(
      (await resolveMembershipForAccount(student_account_id)).class,
    ).not.toBe(studentTier);
  });

  it("canonicalizes and validates course project identity", () => {
    const course_project_id = uuid();
    expect(
      normalizeAdminMembershipPackageProduct({
        type: "membership-package",
        kind: "course",
        membership_class: membershipClass,
        seat_count: 1,
        course_project_id: course_project_id.toUpperCase(),
      }),
    ).toMatchObject({ course_project_id });
    expect(() =>
      normalizeAdminMembershipPackageProduct({
        type: "membership-package",
        kind: "course",
        membership_class: membershipClass,
        seat_count: 1,
        course_project_id: "not-a-project-id",
      }),
    ).toThrow("course_project_id must be a valid UUID");
  });

  it("uses one canonical identity for equivalent billing input", () => {
    const admin_account_id = uuid();
    const user_account_id = uuid();
    const product = {
      type: "membership-package" as const,
      kind: "team" as const,
      membership_class: `  ${membershipClass}  `,
      seat_count: 1,
      interval: "month" as const,
      starts_at: "2026-10-01T00:00:00-07:00",
      expires_at: "2026-11-01T00:00:00-07:00",
    };
    const first = normalizeAdminMembershipPackageBusinessIdentity({
      admin_account_id: admin_account_id.toUpperCase(),
      user_account_id: user_account_id.toUpperCase(),
      product,
      price: "25.001",
      source: "card",
      reason: "  approved package  ",
      idempotency_key: "  stable-key  ",
      pricing_note: "  approved price  ",
    });
    const second = normalizeAdminMembershipPackageBusinessIdentity({
      admin_account_id,
      user_account_id,
      product: {
        ...product,
        membership_class: membershipClass,
        starts_at: new Date("2026-10-01T07:00:00.000Z"),
        expires_at: "2026-11-01T07:00:00.000Z",
      },
      price: 25.01,
      source: "card",
      reason: "approved package",
      idempotency_key: "stable-key",
      pricing_note: "approved price",
    });

    expect(first).toEqual(second);
    expect(first.version).toBe(2);
    expect(first.custom_price).toBe(25.01);
    expect(adminMembershipPackageBusinessIdentityHash(first)).toBe(
      adminMembershipPackageBusinessIdentityHash(second),
    );
    expect(() =>
      normalizeAdminMembershipPackageBusinessIdentity({
        admin_account_id,
        user_account_id,
        product,
        price: true,
        source: "card",
        reason: "approved package",
        idempotency_key: "stable-key",
      }),
    ).toThrow("price must be a number");
  });

  it("reproduces the persisted PR #2 package request hash", () => {
    expect(
      legacyAdminMembershipPackageRequestHash({
        admin_account_id: "11111111-1111-4111-8111-111111111111",
        user_account_id: "22222222-2222-4222-8222-222222222222",
        product: {
          type: "membership-package",
          kind: "team",
          membership_class: " standard ",
          seat_count: 2,
          interval: "month",
          starts_at: "2026-10-01T00:00:00-07:00",
          expires_at: "2026-11-01T00:00:00-07:00",
          metadata: { z: 1, a: "x" },
        },
        custom_price: 25.01,
        source: "card",
        reason: "approved",
        pricing_note: "note",
      }),
    ).toBe("f13889fb4a8dc3c489b00c22b8cbb69e2e8c237cc97b0459aac89ccc2f9d9f63");
  });

  it("canonicalizes distinct Unicode keys independently of insertion order", () => {
    const precomposed = "\u00e9";
    const decomposed = "e\u0301";
    const common = {
      admin_account_id: "11111111-1111-4111-8111-111111111111",
      user_account_id: "22222222-2222-4222-8222-222222222222",
      price: 25,
      source: "card" as const,
      reason: "approved",
      idempotency_key: "unicode-metadata",
    };
    const identity = (metadata: Record<string, unknown>) =>
      normalizeAdminMembershipPackageBusinessIdentity({
        ...common,
        product: {
          type: "membership-package",
          kind: "team",
          membership_class: membershipClass,
          seat_count: 1,
          metadata,
        },
      });
    const first = identity({ [precomposed]: 1, [decomposed]: 2 });
    const second = identity({ [decomposed]: 2, [precomposed]: 1 });

    expect(adminMembershipPackageBusinessIdentityHash(first)).toBe(
      adminMembershipPackageBusinessIdentityHash(second),
    );
  });

  it("consumes PR #2 intents and completed purchase hashes", async () => {
    const admin_account_id = uuid();
    const user_account_id = uuid();
    await createTestAccount(admin_account_id);
    await createTestAccount(user_account_id);
    await getPool().query(
      "UPDATE accounts SET groups=$2::TEXT[] WHERE account_id=$1",
      [admin_account_id, ["admin"]],
    );
    const options = {
      admin_account_id,
      user_account_id,
      product: {
        type: "membership-package" as const,
        kind: "team" as const,
        membership_class: membershipClass,
        seat_count: 1,
        interval: "month" as const,
        starts_at: new Date("2026-10-01T00:00:00Z"),
        expires_at: new Date("2026-11-01T00:00:00Z"),
      },
      price: 15,
      source: "free" as const,
      reason: "approved before the authority rollout",
      idempotency_key: `legacy-package-${uuid()}`,
      pricing_note: "legacy approved quote",
    };
    const legacyHash = legacyAdminMembershipPackageRequestHash({
      admin_account_id,
      user_account_id,
      product: options.product,
      custom_price: options.price,
      source: options.source,
      reason: options.reason,
      pricing_note: options.pricing_note,
    });
    const currentHash = adminMembershipPackageBusinessIdentityHash(
      normalizeAdminMembershipPackageBusinessIdentity(options),
    );
    const invoiceId = adminMembershipPackageInvoiceId(
      admin_account_id,
      options.idempotency_key,
    );
    await getPool().query(
      `INSERT INTO admin_membership_package_intents
         (invoice_id, account_id, admin_account_id, request_hash, snapshot)
       VALUES ($1, $2, $3, $4, $5::JSONB)`,
      [
        invoiceId,
        user_account_id,
        admin_account_id,
        legacyHash,
        {
          version: 1,
          quote: {
            kind: "team",
            membership_class: membershipClass,
            seat_count: 1,
            seat_price: 20,
            total_price: 20,
            interval: "month",
          },
          starts_at: options.product.starts_at.toISOString(),
          expires_at: options.product.expires_at.toISOString(),
          custom_price: options.price,
          source: options.source,
          reason: options.reason,
          pricing_note: options.pricing_note,
          metadata: {
            admin_custom_price: options.price,
            standard_total_price: 20,
          },
        },
      ],
    );

    const created = await adminCreateMembershipPackagePurchase(options);
    const { rows } = await getPool().query(
      `SELECT description->>'admin_request_hash' AS request_hash
         FROM purchases WHERE id=$1`,
      [created.purchase_id],
    );
    expect(rows).toEqual([{ request_hash: currentHash }]);

    await getPool().query(
      `UPDATE purchases
          SET description=jsonb_set(
            description, '{admin_request_hash}', to_jsonb($2::TEXT))
        WHERE id=$1`,
      [created.purchase_id, legacyHash],
    );
    await expect(
      adminCreateMembershipPackagePurchase(options),
    ).resolves.toMatchObject({
      package_id: created.package_id,
      purchase_id: created.purchase_id,
      existing: true,
    });
  });
  function installCardProcessor() {
    const payments = new Map<string, any>();
    const invoices = new Map<string, any>();
    const keys = new Map<string, any>();
    const stripe = {
      paymentIntents: {
        retrieve: jest.fn(async (id) => payments.get(id)),
        update: jest.fn(async (id, opts) => {
          Object.assign(payments.get(id).metadata, opts.metadata);
          return payments.get(id);
        }),
      },
      invoices: { retrieve: jest.fn(async (id) => invoices.get(id)) },
    };
    mockGetStripe.mockResolvedValue(stripe);
    mockCreatePaymentIntent.mockImplementation(
      async ({
        account_id,
        purpose,
        lineItems,
        metadata,
        idempotencyKeyPrefix,
      }) => {
        let payment = keys.get(idempotencyKeyPrefix);
        if (!payment) {
          const invoice = {
            id: `in_${uuid()}`,
            customer: `cus_${account_id}`,
            hosted_invoice_url: `https://stripe.test/${idempotencyKeyPrefix}`,
            lines: { data: [] },
          };
          payment = {
            id: `pi_${uuid()}`,
            customer: invoice.customer,
            status: "succeeded",
            metadata: {
              ...metadata,
              account_id,
              purpose,
              confirm: "true",
              recorded: "true",
              cocalc_site: "test.cocalc.ai",
              invoice_id: invoice.id,
              total_excluding_tax_usd: `${lineItems[0].amount * 100}`,
            },
          };
          keys.set(idempotencyKeyPrefix, payment);
          payments.set(payment.id, payment);
          invoices.set(invoice.id, invoice);
        }
        await bindAdminMembershipPayment({
          account_id,
          order_id: metadata.admin_membership_order_id,
          payment_intent_id: payment.id,
          stripe_invoice_id: payment.metadata.invoice_id,
          amount: lineItems[0].amount,
        });
        await processPaymentIntent(payment);
        return {
          payment_intent: payment.id,
          hosted_invoice_url: invoices.get(payment.metadata.invoice_id)
            .hosted_invoice_url,
        };
      },
    );
    return { stripe, payments };
  }

  async function cardOptions(): Promise<AdminMembershipPackagePurchaseOptions> {
    const admin_account_id = uuid(),
      user_account_id = uuid();
    await createTestAccount(admin_account_id);
    await createTestAccount(user_account_id);
    await getPool().query(
      "UPDATE accounts SET groups=ARRAY['admin'] WHERE account_id=$1",
      [admin_account_id],
    );
    return {
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
      reason: "approved custom package",
      idempotency_key: uuid(),
    };
  }

  it("does not dispatch a new card identity for an unresolved pre-upgrade intent", async () => {
    const opts = await cardOptions();
    const invoice = adminMembershipPackageInvoiceId(
      opts.admin_account_id,
      opts.idempotency_key,
    );
    await getPool().query(
      "INSERT INTO admin_membership_package_intents(invoice_id,account_id,admin_account_id,request_hash,snapshot) VALUES($1,$2,$3,$4,'{}')",
      [
        invoice,
        opts.user_account_id,
        opts.admin_account_id,
        adminMembershipPackageBusinessIdentityHash(
          normalizeAdminMembershipPackageBusinessIdentity(opts),
        ),
      ],
    );
    await expect(adminCreateMembershipPackagePurchase(opts)).rejects.toThrow(
      "needs reconciliation",
    );
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
    expect(
      (
        await getPool().query(
          "SELECT 1 FROM admin_membership_orders WHERE account_id=$1",
          [opts.user_account_id],
        )
      ).rows,
    ).toHaveLength(0);
    expect(
      (
        await getPool().query(
          "SELECT 1 FROM admin_membership_package_intents WHERE invoice_id=$1",
          [invoice],
        )
      ).rows,
    ).toHaveLength(1);
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
    installCardProcessor();

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
      hosted_invoice_url: expect.stringContaining("https://stripe.test/"),
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
      "The saved card purchase has not completed. If payment is required, complete the invoice and retry; do not submit a new purchase: https://stripe.test/action-required",
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
  });

  it("retains captured credit through failed fulfillment and retries without another charge", async () => {
    const opts = await cardOptions();
    const { payments } = installCardProcessor();
    const spy = jest
      .spyOn(
        require("@cocalc/server/membership/packages"),
        "setMembershipPackagePurchaseId",
      )
      .mockRejectedValueOnce(Error("fulfillment interrupted"));
    try {
      await expect(adminCreateMembershipPackagePurchase(opts)).rejects.toThrow(
        "fulfillment interrupted",
      );
    } finally {
      spy.mockRestore();
    }
    expect(await getBalance({ account_id: opts.user_account_id })).toBe(
      "25.0000000000",
    );
    expect(
      await getSpendableBalance({ account_id: opts.user_account_id }),
    ).toBe("0.0000000000");
    expect(
      (
        await getPool().query(
          "SELECT id FROM membership_packages WHERE owner_account_id=$1",
          [opts.user_account_id],
        )
      ).rows,
    ).toHaveLength(0);
    await expect(
      withFundingAccountTransaction(opts.user_account_id, (client) =>
        reserveAccountFundingBacking(client, {
          payer_account_id: opts.user_account_id,
          source_kind: "course-pool",
          source_id: uuid(),
          lane: "prepaid",
          authorized_usd: "1",
          capacity_usd: "25",
        }),
      ),
    ).rejects.toMatchObject({ code: "insufficient_funding" });
    const order = (
      await getPool().query(
        "SELECT * FROM admin_membership_orders WHERE account_id=$1",
        [opts.user_account_id],
      )
    ).rows[0];
    await getPool().query(
      "UPDATE admin_membership_orders SET dispatched_at=NOW()-INTERVAL '2 days' WHERE id=$1",
      [order.id],
    );
    const result = await adminCreateMembershipPackagePurchase(opts);
    expect(result.starts_at.toISOString()).toBe(order.quote.starts_at);
    expect(result.expires_at.toISOString()).toBe(order.quote.expires_at);
    expect(mockCreatePaymentIntent).toHaveBeenCalledTimes(1);
    expect(payments.size).toBe(1);
    expect(await getBalance({ account_id: opts.user_account_id })).toBe(
      "0.0000000000",
    );
    const receipts = (
      await getPool().query(
        "SELECT state FROM payment_fulfillments WHERE account_id=$1",
        [opts.user_account_id],
      )
    ).rows;
    expect(receipts).toEqual([{ state: "fulfilled" }]);
  });

  it.each(["price", "source", "product"])(
    "rejects changed %s while the original payment is unresolved",
    async (field) => {
      const opts = await cardOptions();
      mockCreatePaymentIntent.mockRejectedValueOnce(
        Error("lost invoice reply"),
      );
      await expect(adminCreateMembershipPackagePurchase(opts)).rejects.toThrow(
        "lost invoice reply",
      );
      const changed = {
        ...opts,
        ...(field === "price"
          ? { price: 26 }
          : field === "source"
            ? { source: "free" as const }
            : { product: { ...opts.product, seat_count: 1 } }),
      };
      await expect(
        adminCreateMembershipPackagePurchase(changed),
      ).rejects.toThrow("order terms changed");
      expect(mockCreatePaymentIntent).toHaveBeenCalledTimes(1);
    },
  );

  it("does not dispatch after an uncertain order outlives the provider retry window", async () => {
    const opts = await cardOptions();
    mockCreatePaymentIntent.mockRejectedValueOnce(Error("lost invoice reply"));
    await expect(adminCreateMembershipPackagePurchase(opts)).rejects.toThrow(
      "lost invoice reply",
    );
    await getPool().query(
      "UPDATE admin_membership_orders SET dispatched_at=NOW()-INTERVAL '2 days' WHERE account_id=$1",
      [opts.user_account_id],
    );
    await expect(adminCreateMembershipPackagePurchase(opts)).rejects.toThrow(
      "retry window expired",
    );
    expect(mockCreatePaymentIntent).toHaveBeenCalledTimes(1);
  });

  it("checks account authority and dates before card dispatch", async () => {
    const opts = await cardOptions();
    await getPool().query(
      "INSERT INTO account_funding_authorities (payer_account_id,epoch,home_bay_id,state) VALUES ($1,$2,$3,'frozen')",
      [opts.user_account_id, uuid(), process.env.COCALC_BAY_ID || "bay-0"],
    );
    await expect(adminCreateMembershipPackagePurchase(opts)).rejects.toThrow(
      "frozen",
    );
    const other = await cardOptions();
    await expect(
      adminCreateMembershipPackagePurchase({
        ...other,
        product: {
          ...other.product,
          starts_at: "2026-09-12",
          expires_at: "2026-09-11",
        },
      }),
    ).rejects.toThrow();
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
  });

  it("binds one account, amount and payment identity to an order", async () => {
    const opts = await cardOptions();
    mockCreatePaymentIntent.mockRejectedValueOnce(Error("lost invoice reply"));
    await expect(adminCreateMembershipPackagePurchase(opts)).rejects.toThrow(
      "lost invoice reply",
    );
    const order = (
      await getPool().query(
        "SELECT id FROM admin_membership_orders WHERE account_id=$1",
        [opts.user_account_id],
      )
    ).rows[0];
    const bind = {
      account_id: opts.user_account_id,
      order_id: order.id,
      payment_intent_id: `pi_${uuid()}`,
      stripe_invoice_id: `in_${uuid()}`,
      amount: 25,
    };
    await expect(
      bindAdminMembershipPayment({
        ...bind,
        account_id: opts.admin_account_id,
      }),
    ).rejects.toThrow("not found");
    await expect(
      bindAdminMembershipPayment({ ...bind, amount: 1 }),
    ).rejects.toThrow("does not match");
    await bindAdminMembershipPayment(bind);
    await bindAdminMembershipPayment(bind);
    await expect(
      bindAdminMembershipPayment({
        ...bind,
        payment_intent_id: `pi_${uuid()}`,
      }),
    ).rejects.toThrow("different payment");
    expect(mockCreatePaymentIntent).toHaveBeenCalledTimes(1);
  });

  it("does not charge again when an unfinished legacy custom payment is already credited", async () => {
    const opts = await cardOptions();
    await createCredit({
      account_id: opts.user_account_id,
      amount: 25,
      invoice_id: `pi_${uuid()}`,
      description: { purpose: "admin-membership-package-purchase" },
    });
    await expect(adminCreateMembershipPackagePurchase(opts)).rejects.toThrow(
      "earlier custom membership payment needs reconciliation",
    );
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
  });

  const concurrentTest =
    process.env.COCALC_TEST_USE_PGLITE === "1" ? it.skip : it;
  concurrentTest(
    "concurrent admin retries share one order, payment and package",
    async () => {
      const opts = await cardOptions();
      const { payments } = installCardProcessor();
      const results = await Promise.all([
        adminCreateMembershipPackagePurchase(opts),
        adminCreateMembershipPackagePurchase(opts),
      ]);
      expect(results[0].purchase_id).toBe(results[1].purchase_id);
      expect(results[0].package_id).toBe(results[1].package_id);
      expect(payments.size).toBe(1);
      expect(
        (
          await getPool().query(
            "SELECT id FROM admin_membership_orders WHERE account_id=$1",
            [opts.user_account_id],
          )
        ).rows,
      ).toHaveLength(1);
      expect(
        (
          await getPool().query(
            "SELECT id FROM account_admin_audit_log WHERE account_id=$1 AND action='membership-package-purchase'",
            [opts.user_account_id],
          )
        ).rows,
      ).toHaveLength(1);
      expect(await getBalance({ account_id: opts.user_account_id })).toBe(
        "0.0000000000",
      );
    },
  );
});
