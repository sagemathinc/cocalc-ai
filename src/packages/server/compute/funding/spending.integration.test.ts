/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { before, after } from "@cocalc/server/test";
import {
  createTestMembershipTier,
  createTestMembershipSubscription,
} from "@cocalc/server/purchases/test-data";
import { getMembershipTierMap } from "@cocalc/server/membership/tiers";
import { applyMembershipChange } from "@cocalc/server/purchases/membership-change";
import renewSubscription from "@cocalc/server/purchases/renew-subscription";
import resumeSubscription from "@cocalc/server/purchases/resume-subscription";
import getBalance from "@cocalc/server/purchases/get-balance";
import adminPurchase from "@cocalc/server/purchases/admin-purchase";
import adminCreateMembershipPackagePurchase from "@cocalc/server/purchases/admin-membership-package";
import * as adminAudit from "@cocalc/server/accounts/admin-audit";
import { recordCapturedPayment } from "@cocalc/server/purchases/captured-payment";
import getSpendableBalance, {
  getAccountFundingHolds,
} from "@cocalc/server/purchases/get-spendable-balance";
import { isPurchaseAllowed } from "@cocalc/server/purchases/is-purchase-allowed";
import purchaseMembershipPackage, {
  purchaseMembershipPackages,
} from "@cocalc/server/purchases/membership-package";
import {
  withFundingAccountTransaction,
  reserveAccountFundingBacking,
} from "./backing";
import { createCourseFundingPoolInTransaction } from "./pools";
import type { CourseFundingDraft } from "@cocalc/util/compute-funding";
import type { MembershipPackageProduct } from "@cocalc/util/membership-package-product";

jest.mock("@cocalc/server/project-host/admission", () =>
  require("./__tests__/policy-source").mockPolicySource(),
);
jest.mock("@cocalc/server/messages/send", () => ({
  __esModule: true,
  default: jest.fn().mockResolvedValue(undefined),
  name: jest.fn().mockResolvedValue("Test payer"),
  support: jest.fn().mockResolvedValue("Support"),
  url: jest.fn(async (path) => path),
}));
jest.mock("@cocalc/server/messages/admin-alert", () => ({
  __esModule: true,
  default: jest.fn().mockResolvedValue(undefined),
}));
beforeAll(async () => {
  await before({ noConat: true });
  await createTestMembershipTier({
    id: tier,
    team_visible: true,
    price_monthly: 20,
    price_yearly: 200,
  });
  await getPool().query(
    "INSERT INTO accounts (account_id, groups) VALUES ($1, ARRAY['admin'])",
    [admin],
  );
}, 60_000);
afterAll(after);
const admin = randomUUID();
const tier = `funding-purchase-${randomUUID()}`;
const product: MembershipPackageProduct = {
  type: "membership-package",
  kind: "team",
  membership_class: tier,
  seat_count: 1,
  interval: "month",
};

async function fixture() {
  const payer = randomUUID();
  await getPool().query("INSERT INTO accounts (account_id) VALUES ($1)", [
    payer,
  ]);
  await getPool().query(
    "INSERT INTO purchases (account_id,cost,service,time) VALUES ($1,-100,'credit',clock_timestamp())",
    [payer],
  );
  const terms: CourseFundingDraft = {
    course_project_id: randomUUID(),
    course_instance_id: randomUUID(),
    currency: "USD",
    lane: "prepaid",
    amount_usd: "100",
    allow_overcommit: false,
    starts_at: new Date(Date.now() - 1000).toISOString(),
    ends_at: new Date(Date.now() + 86400000).toISOString(),
    recipients: [],
  };
  return { payer, terms };
}
function allocate(f: Awaited<ReturnType<typeof fixture>>, amount = "100") {
  return withFundingAccountTransaction(f.payer, (client) =>
    createCourseFundingPoolInTransaction(client, {
      payer_account_id: f.payer,
      operation_id: randomUUID(),
      terms: { ...f.terms, amount_usd: amount },
    }),
  );
}

function adminOperation(
  payer: string,
  kind: "adjustment" | "membership" | "package",
  source: "free" | "credit" = "credit",
) {
  if (kind === "package") {
    const idempotency_key = randomUUID();
    return () =>
      adminCreateMembershipPackagePurchase({
        admin_account_id: admin,
        user_account_id: payer,
        product,
        price: 20,
        source,
        reason: "Funding integration test",
        idempotency_key,
      });
  }
  return () =>
    adminPurchase({
      admin_account_id: admin,
      user_account_id: payer,
      price: kind === "adjustment" ? -20 : 20,
      product: kind === "adjustment" ? "balance" : "membership",
      membership_class: tier,
      interval: "month",
      source,
    });
}

async function subscriptionOperation(
  payer: string,
  kind: "change" | "renew" | "resume",
) {
  if (kind === "change") {
    const tierMap = await getMembershipTierMap({ includeDisabled: true });
    return () =>
      applyMembershipChange({
        account_id: payer,
        targetClass: tier,
        interval: "month",
        requireNoPayment: true,
        tierMap,
      });
  }
  const { subscription_id } = await createTestMembershipSubscription(payer, {
    class: tier,
    cost: 20,
    status: kind === "renew" ? "unpaid" : "canceled",
    start: new Date(Date.now() - 60 * 86400000),
    end: new Date(Date.now() - 86400000),
  });
  return () =>
    (kind === "renew" ? renewSubscription : resumeSubscription)({
      account_id: payer,
      subscription_id,
    });
}

describe("sponsored backing versus ordinary purchases", () => {
  it("keeps ledger balance unchanged and excludes held money from ordinary purchase checks", async () => {
    const f = await fixture();
    await allocate(f);
    expect(await getBalance({ account_id: f.payer })).toBe("100.0000000000");
    expect(await getSpendableBalance({ account_id: f.payer })).toBe(
      "0.0000000000",
    );
    const { getDedicatedHostPolicySnapshotLocal } = jest.requireActual(
      "@cocalc/server/project-host/admission",
    );
    expect(
      await withFundingAccountTransaction(f.payer, (client) =>
        getDedicatedHostPolicySnapshotLocal(f.payer, {
          funding_mode_override: "account-prepaid",
          client,
        }),
      ),
    ).toMatchObject({
      balance: "100.0000000000",
      prepaid_spendable_balance: "0.0000000000",
    });
    for (const service of ["membership", "dedicated-host"] as const) {
      expect(
        (await isPurchaseAllowed({ account_id: f.payer, service, cost: 20 }))
          .allowed,
      ).toBe(false);
    }
    const {
      rows: [row],
    } = await getPool().query(
      "SELECT balance FROM accounts WHERE account_id=$1",
      [f.payer],
    );
    expect(Number(row.balance)).toBe(100);
    await expect(
      purchaseMembershipPackage({ account_id: f.payer, product }),
    ).rejects.toThrow(/pay/i);
    const { rows } = await getPool().query(
      "SELECT id FROM membership_packages WHERE owner_account_id=$1",
      [f.payer],
    );
    expect(rows).toHaveLength(0);
  });

  it("does not confuse postpaid commitments with prepaid money", async () => {
    const f = await fixture();
    f.terms.lane = "postpaid";
    await allocate(f);
    expect(await getAccountFundingHolds({ account_id: f.payer })).toEqual({
      prepaid_held_usd: "0.0000000000",
      postpaid_committed_usd: "100.0000000000",
    });
    expect(await getSpendableBalance({ account_id: f.payer })).toBe(
      "100.0000000000",
    );
  });

  it("does not allocate credit already committed to a pending subscription renewal", async () => {
    const f = await fixture();
    const { subscription_id } = await createTestMembershipSubscription(
      f.payer,
      { cost: 100 },
    );
    await withFundingAccountTransaction(f.payer, (client) =>
      client.query(
        "UPDATE subscription_renewal_attempts SET balance_applied=70, state='processing' WHERE account_id=$1 AND subscription_id=$2",
        [f.payer, subscription_id],
      ),
    );
    await expect(allocate(f, "31")).rejects.toMatchObject({
      code: "insufficient_funding",
    });
    await allocate(f, "30");
    expect(Number(await getSpendableBalance({ account_id: f.payer }))).toBe(0);
    await expect(
      withFundingAccountTransaction(f.payer, (client) =>
        reserveAccountFundingBacking(client, {
          payer_account_id: f.payer,
          source_kind: "transfer",
          source_id: randomUUID(),
          lane: "prepaid",
          authorized_usd: "1",
          capacity_usd: "100",
        }),
      ),
    ).rejects.toMatchObject({ code: "insufficient_funding" });
  });

  it("reads uncommitted backing and purchases using the caller's transaction", async () => {
    const f = await fixture();
    await expect(
      withFundingAccountTransaction(f.payer, async (client) => {
        await reserveAccountFundingBacking(client, {
          payer_account_id: f.payer,
          source_kind: "course-pool",
          source_id: randomUUID(),
          lane: "prepaid",
          authorized_usd: "70",
          capacity_usd: "100",
        });
        await client.query(
          "INSERT INTO purchases (account_id,cost,service,time) VALUES ($1,5,'membership',clock_timestamp())",
          [f.payer],
        );
        expect(
          await getSpendableBalance({
            account_id: f.payer,
            client,
            noSave: true,
          }),
        ).toBe("25.0000000000");
        throw new Error("rollback spending fixture");
      }),
    ).rejects.toThrow("rollback spending fixture");
    expect(await getSpendableBalance({ account_id: f.payer })).toBe(
      "100.0000000000",
    );
  });

  it("preserves negative spendable balances rather than inventing spare funds", async () => {
    const f = await fixture();
    await allocate(f);
    await getPool().query(
      "INSERT INTO purchases (account_id,cost,service,time) VALUES ($1,5,'membership',clock_timestamp())",
      [f.payer],
    );
    expect(await getSpendableBalance({ account_id: f.payer })).toBe(
      "-5.0000000000",
    );
  });

  it("uses only unheld balance for package bundles and preserves replay after subsequent allocation", async () => {
    const f = await fixture();
    await allocate(f, "70");
    const fulfillment = randomUUID();
    const opts = {
      account_id: f.payer,
      fulfillment_id: fulfillment,
      products: [product, product],
    };
    await expect(purchaseMembershipPackages(opts)).rejects.toThrow(/pay/i);
    await getPool().query(
      "INSERT INTO purchases (account_id,cost,service,time) VALUES ($1,-10,'credit',clock_timestamp())",
      [f.payer],
    );
    const result = await purchaseMembershipPackages(opts);
    expect(result).toHaveLength(2);
    expect(await getSpendableBalance({ account_id: f.payer })).toBe(
      "0.0000000000",
    );
    expect(await purchaseMembershipPackages(opts)).toEqual(result);
    expect(await getBalance({ account_id: f.payer })).toBe("70.0000000000");
  });

  const concurrentTest =
    process.env.COCALC_TEST_USE_PGLITE === "1" ? it.skip : it;
  describe.each(["adjustment", "membership", "package"] as const)(
    "admin-assisted %s",
    (kind) => {
      it("cannot consume reserved credit but can debit the exact unheld remainder", async () => {
        const f = await fixture();
        const purchase = adminOperation(f.payer, kind);
        await allocate(f, "80.01");
        await expect(purchase()).rejects.toThrow(/reserved credit|pay/i);
        expect(await getBalance({ account_id: f.payer })).toBe(
          "100.0000000000",
        );
        await getPool().query(
          "INSERT INTO purchases (account_id,cost,service,time) VALUES ($1,-0.01,'credit',clock_timestamp())",
          [f.payer],
        );
        await purchase();
        expect(await getBalance({ account_id: f.payer })).toBe("80.0100000000");
        expect(await getSpendableBalance({ account_id: f.payer })).toBe(
          "0.0000000000",
        );
      });

      it.each(["frozen", "retired"])(
        "rejects %s payer authority before changing finances",
        async (state) => {
          const f = await fixture();
          await allocate(f, "1");
          await getPool().query(
            "UPDATE account_funding_authorities SET state=$2 WHERE payer_account_id=$1",
            [f.payer, state],
          );
          await expect(adminOperation(f.payer, kind)()).rejects.toMatchObject({
            code: "funding_unavailable",
          });
          expect(await getBalance({ account_id: f.payer })).toBe(
            "100.0000000000",
          );
        },
      );

      concurrentTest(
        "waits for the allocator before checking available credit",
        async () => {
          const f = await fixture();
          const purchase = adminOperation(f.payer, kind);
          let outcome: Promise<PromiseSettledResult<unknown>> | undefined;
          let finished = false;
          try {
            await withFundingAccountTransaction(f.payer, async (client) => {
              outcome = purchase()
                .then(
                  (value) => ({ status: "fulfilled" as const, value }),
                  (reason) => ({ status: "rejected" as const, reason }),
                )
                .finally(() => {
                  finished = true;
                });
              let waiting = false;
              const deadline = Date.now() + 5000;
              while (!finished && Date.now() < deadline) {
                const { rows } = await client.query(
                  `SELECT 1 FROM pg_locks
                  WHERE locktype='advisory' AND NOT granted
                    AND pg_backend_pid()=ANY(pg_blocking_pids(pid))`,
                );
                if (rows.length) {
                  waiting = true;
                  break;
                }
                await new Promise((resolve) => setTimeout(resolve, 20));
              }
              expect(waiting).toBe(true);
              await createCourseFundingPoolInTransaction(client, {
                payer_account_id: f.payer,
                operation_id: randomUUID(),
                terms: f.terms,
              });
            });
            expect(await outcome).toMatchObject({ status: "rejected" });
            expect(await getBalance({ account_id: f.payer })).toBe(
              "100.0000000000",
            );
            expect(await getSpendableBalance({ account_id: f.payer })).toBe(
              "0.0000000000",
            );
          } finally {
            await outcome;
          }
        },
        15_000,
      );
    },
  );

  it.each(["membership", "package"] as const)(
    "can grant a free admin %s without consuming course backing",
    async (kind) => {
      const f = await fixture();
      await allocate(f);
      await adminOperation(f.payer, kind, "free")();
      expect(await getBalance({ account_id: f.payer })).toBe("100.0000000000");
      expect(await getSpendableBalance({ account_id: f.payer })).toBe(
        "0.0000000000",
      );
    },
  );

  it("admin adjustments preserve the combined course, renewal and captured-payment holds", async () => {
    const f = await fixture();
    const { subscription_id } = await createTestMembershipSubscription(
      f.payer,
      { cost: 100 },
    );
    await withFundingAccountTransaction(f.payer, (client) =>
      client.query(
        "UPDATE subscription_renewal_attempts SET balance_applied=40, state='processing' WHERE account_id=$1 AND subscription_id=$2",
        [f.payer, subscription_id],
      ),
    );
    await allocate(f, "50");
    const payment = await recordCapturedPayment({
      account_id: f.payer,
      payment_id: `pi_${randomUUID()}`,
      purpose: "membership-package",
      amount: "30",
      request: { product },
    });
    expect(
      (await getAccountFundingHolds({ account_id: f.payer })).prepaid_held_usd,
    ).toBe("120.0000000000");
    await expect(adminOperation(f.payer, "adjustment")()).rejects.toMatchObject(
      { code: "insufficient_funding" },
    );
    expect(await getBalance({ account_id: f.payer })).toBe("130.0000000000");
    const {
      rows: [receipt],
    } = await getPool().query(
      "SELECT state FROM payment_fulfillments WHERE payment_id=$1",
      [payment.payment_id],
    );
    expect(receipt.state).toBe("pending");
  });

  it("preserves no-hold admin debt adjustments and does not subtract postpaid commitments from cash", async () => {
    const f = await fixture();
    f.terms.lane = "postpaid";
    await allocate(f);
    await adminPurchase({
      admin_account_id: admin,
      user_account_id: f.payer,
      product: "balance",
      source: "credit",
      price: -120,
    });
    expect(await getBalance({ account_id: f.payer })).toBe("-20.0000000000");
    expect(
      (await getAccountFundingHolds({ account_id: f.payer }))
        .postpaid_committed_usd,
    ).toBe("100.0000000000");
  });

  it("can add credit while backed, but not after the payer has frozen", async () => {
    const f = await fixture();
    await allocate(f);
    const opts = {
      admin_account_id: admin,
      user_account_id: f.payer,
      product: "balance" as const,
      source: "free" as const,
      price: 20,
    };
    await adminPurchase(opts);
    expect(await getSpendableBalance({ account_id: f.payer })).toBe(
      "20.0000000000",
    );
    await getPool().query(
      "UPDATE account_funding_authorities SET state='frozen' WHERE payer_account_id=$1",
      [f.payer],
    );
    await expect(adminPurchase(opts)).rejects.toMatchObject({
      code: "funding_unavailable",
    });
    expect(await getBalance({ account_id: f.payer })).toBe("120.0000000000");
  });

  it("rolls back both the debit and its audit row if the audit writer fails", async () => {
    const f = await fixture();
    await allocate(f, "80");
    const insert = adminAudit.recordAccountAdminAuditEventInTransaction;
    const spy = jest
      .spyOn(adminAudit, "recordAccountAdminAuditEventInTransaction")
      .mockImplementationOnce(async (opts) => {
        await insert(opts);
        throw new Error("injected audit failure");
      });
    try {
      await expect(adminOperation(f.payer, "adjustment")()).rejects.toThrow(
        "injected audit failure",
      );
    } finally {
      spy.mockRestore();
    }
    expect(await getBalance({ account_id: f.payer })).toBe("100.0000000000");
    const { rows } = await getPool().query(
      "SELECT id FROM account_admin_audit_log WHERE account_id=$1",
      [f.payer],
    );
    expect(rows).toHaveLength(0);
  });

  describe.each(["change", "renew", "resume"] as const)(
    "personal subscription %s",
    (kind) => {
      it("cannot debit course backing but can spend the unheld remainder", async () => {
        const f = await fixture();
        const purchase = await subscriptionOperation(f.payer, kind);
        await allocate(f, "90");
        await expect(purchase()).rejects.toThrow(/pay/i);
        expect(await getBalance({ account_id: f.payer })).toBe(
          "100.0000000000",
        );
        await getPool().query(
          "INSERT INTO purchases (account_id,cost,service,time) VALUES ($1,-10,'credit',clock_timestamp())",
          [f.payer],
        );
        await purchase();
        expect(await getBalance({ account_id: f.payer })).toBe("90.0000000000");
        expect(await getSpendableBalance({ account_id: f.payer })).toBe(
          "0.0000000000",
        );
      });

      concurrentTest(
        "waits for an in-flight allocation before admitting its debit",
        async () => {
          const f = await fixture();
          const purchase = await subscriptionOperation(f.payer, kind);
          let outcome: Promise<PromiseSettledResult<unknown>> | undefined;
          let finished = false;
          try {
            await withFundingAccountTransaction(f.payer, async (client) => {
              outcome = purchase()
                .then(
                  (value) => ({ status: "fulfilled" as const, value }),
                  (reason) => ({ status: "rejected" as const, reason }),
                )
                .finally(() => {
                  finished = true;
                });
              // Observe a real blocked advisory lock, not a timing assumption.
              let waiting = false;
              const deadline = Date.now() + 5000;
              while (!finished && Date.now() < deadline) {
                const { rows } = await client.query(
                  `SELECT 1 FROM pg_locks
                  WHERE locktype='advisory' AND NOT granted
                    AND pg_backend_pid()=ANY(pg_blocking_pids(pid))`,
                );
                if (rows.length) {
                  waiting = true;
                  break;
                }
                await new Promise((resolve) => setTimeout(resolve, 20));
              }
              expect(waiting).toBe(true);
              await createCourseFundingPoolInTransaction(client, {
                payer_account_id: f.payer,
                operation_id: randomUUID(),
                terms: f.terms,
              });
            });
            expect(await outcome).toMatchObject({ status: "rejected" });
            expect(await getSpendableBalance({ account_id: f.payer })).toBe(
              "0.0000000000",
            );
            expect(await getBalance({ account_id: f.payer })).toBe(
              "100.0000000000",
            );
          } finally {
            // The payer transaction has released its locks, including on failure.
            await outcome;
          }
        },
        15_000,
      );
    },
  );
  concurrentTest(
    "serializes a real membership-package purchase against a competing course allocation",
    async () => {
      const f = await fixture();
      const results = await Promise.allSettled([
        allocate(f),
        purchaseMembershipPackage({ account_id: f.payer, product }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      const balance = Number(await getBalance({ account_id: f.payer }));
      const held = Number(
        (await getAccountFundingHolds({ account_id: f.payer }))
          .prepaid_held_usd,
      );
      expect(balance).toBeGreaterThanOrEqual(held);
      expect([balance, held]).toEqual(
        results[0].status === "fulfilled" ? [100, 100] : [80, 0],
      );
    },
  );
});
