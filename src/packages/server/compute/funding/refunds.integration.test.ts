/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { before, after } from "@cocalc/server/test";
import createCredit from "@cocalc/server/purchases/create-credit";
import createPurchase from "@cocalc/server/purchases/create-purchase";
import createRefund from "@cocalc/server/purchases/create-refund";
import getBalance from "@cocalc/server/purchases/get-balance";
import { getAccountFundingHolds } from "@cocalc/server/purchases/get-spendable-balance";
import {
  createTestMembershipPackage,
  createTestMembershipSubscription,
} from "@cocalc/server/purchases/test-data";
import type { CourseFundingDraft } from "@cocalc/util/compute-funding";
import { withFundingAccountTransaction } from "./backing";
import { createCourseFundingPoolInTransaction } from "./pools";

jest.mock("@cocalc/server/project-host/admission", () =>
  require("./__tests__/policy-source").mockPolicySource(),
);
jest.mock("@cocalc/server/messages/send", () => ({
  __esModule: true,
  default: jest.fn().mockResolvedValue(undefined),
  name: jest.fn().mockResolvedValue("Refund payer"),
  support: jest.fn().mockResolvedValue("Support"),
  url: jest.fn(async (path) => path),
}));
jest.mock("@cocalc/server/stripe/connection", () => ({
  __esModule: true,
  default: jest.fn(() => {
    throw Error("Local refunds must not contact Stripe");
  }),
}));

const admin = randomUUID();
const concurrentTest =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? it.skip : it;
type Kind = "credit" | "service" | "membership" | "package";

beforeAll(async () => {
  await before({ noConat: true });
  await getPool().query(
    "INSERT INTO accounts (account_id,groups) VALUES ($1,ARRAY['admin'])",
    [admin],
  );
}, 60_000);
afterAll(after);

async function fixture(kind: Kind) {
  const payer = randomUUID();
  await getPool().query("INSERT INTO accounts (account_id) VALUES ($1)", [
    payer,
  ]);
  let purchase_id = await createCredit({ account_id: payer, amount: "100" });
  let subscription_id: number | undefined;
  if (kind === "membership") {
    ({ subscription_id } = await createTestMembershipSubscription(payer, {
      cost: 20,
    }));
    purchase_id = await createPurchase({
      account_id: payer,
      service: "membership",
      cost: "20",
      client: null,
      description: {
        type: "membership",
        subscription_id,
        class: "member",
        interval: "month",
      },
    });
  } else if (kind === "package") {
    const package_id = await createTestMembershipPackage({
      owner_account_id: payer,
      kind: "team",
      membership_class: "member",
      seat_count: 1,
    });
    purchase_id = await createPurchase({
      account_id: payer,
      service: "membership",
      cost: "20",
      client: null,
      description: {
        type: "membership-package",
        package_id,
        kind: "team",
        membership_class: "member",
        seat_count: 1,
        seat_price: 20,
        total_price: 20,
      },
    });
    await getPool().query(
      "UPDATE membership_packages SET purchase_id=$2 WHERE id=$1",
      [package_id, purchase_id],
    );
  } else if (kind === "service") {
    purchase_id = await createPurchase({
      account_id: payer,
      service: "dedicated-host",
      cost: "20",
      client: null,
      description: {
        type: "dedicated-host",
        host_id: randomUUID(),
        provider: "test",
        funding_lane: "prepaid",
        hourly_cost_usd: 1,
      },
    });
  }
  const terms: CourseFundingDraft = {
    course_project_id: randomUUID(),
    course_instance_id: randomUUID(),
    currency: "USD",
    lane: "prepaid",
    amount_usd: "50",
    allow_overcommit: false,
    starts_at: new Date(Date.now() - 1000).toISOString(),
    ends_at: new Date(Date.now() + 86400000).toISOString(),
    recipients: [],
  };
  const refund = () =>
    createRefund({ account_id: admin, purchase_id, reason: "duplicate" });
  const allocate = () =>
    withFundingAccountTransaction(payer, (client) =>
      createCourseFundingPoolInTransaction(client, {
        payer_account_id: payer,
        operation_id: randomUUID(),
        terms,
      }),
    );
  return {
    payer,
    purchase_id,
    subscription_id,
    terms,
    refund,
    allocate,
    balance: kind === "credit" ? "100.0000000000" : "80.0000000000",
  };
}

describe.each(["credit", "service", "membership", "package"] as const)(
  "local %s reversal",
  (kind) => {
    concurrentTest(
      "two concurrent retries post only one reversal",
      async () => {
        const f = await fixture(kind);
        await f.allocate();
        if (kind === "credit")
          await createCredit({ account_id: f.payer, amount: "50" });
        const [first, second] = await Promise.all([f.refund(), f.refund()]);
        expect(second).toBe(first);
        expect(await getBalance({ account_id: f.payer })).toBe(
          kind === "credit" ? "50.0000000000" : "100.0000000000",
        );
        const { rows } = await getPool().query(
          "SELECT id FROM purchases WHERE account_id=$1 AND service='refund'",
          [f.payer],
        );
        expect(rows).toEqual([{ id: first }]);
      },
    );

    it.each(["frozen", "retired"])(
      "does not change a %s payer ledger",
      async (state) => {
        const f = await fixture(kind);
        await f.allocate();
        await getPool().query(
          "UPDATE account_funding_authorities SET state=$2 WHERE payer_account_id=$1",
          [f.payer, state],
        );
        await expect(f.refund()).rejects.toMatchObject({
          code: "funding_unavailable",
        });
        expect(await getBalance({ account_id: f.payer })).toBe(f.balance);
        const { rows } = await getPool().query(
          "SELECT id FROM purchases WHERE account_id=$1 AND service='refund'",
          [f.payer],
        );
        expect(rows).toHaveLength(0);
      },
    );

    it("does not write a non-local payer's ledger", async () => {
      const f = await fixture(kind);
      await getPool().query(
        "UPDATE accounts SET home_bay_id=$2 WHERE account_id=$1",
        [f.payer, `other-${randomUUID()}`],
      );
      await expect(f.refund()).rejects.toThrow(/homed on/);
      expect(await getBalance({ account_id: f.payer })).toBe(f.balance);
    });

    concurrentTest(
      "waits for the spending fence without first locking purchase or subscription rows",
      async () => {
        const f = await fixture(kind);
        let outcome: Promise<PromiseSettledResult<number>> | undefined;
        let finished = false;
        try {
          await withFundingAccountTransaction(f.payer, async (client) => {
            outcome = f
              .refund()
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
                `SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND pg_backend_pid()=ANY(pg_blocking_pids(pid))`,
              );
              if (rows.length) {
                waiting = true;
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            expect(waiting).toBe(true);
            await client.query(
              "SELECT id FROM purchases WHERE id=$1 FOR UPDATE NOWAIT",
              [f.purchase_id],
            );
            if (f.subscription_id != null)
              await client.query(
                "SELECT id FROM subscriptions WHERE id=$1 FOR UPDATE NOWAIT",
                [f.subscription_id],
              );
            await createCourseFundingPoolInTransaction(client, {
              payer_account_id: f.payer,
              operation_id: randomUUID(),
              terms: f.terms,
            });
          });
          expect(await outcome).toMatchObject({
            status: kind === "credit" ? "rejected" : "fulfilled",
          });
          expect(await getBalance({ account_id: f.payer })).toBe(
            "100.0000000000",
          );
          expect(
            (await getAccountFundingHolds({ account_id: f.payer }))
              .prepaid_held_usd,
          ).toBe("50.0000000000");
        } finally {
          await outcome;
        }
      },
      15_000,
    );
  },
);

it("requires released backing before reversing an internal credit, and replays after authority freezes", async () => {
  const f = await fixture("credit");
  await f.allocate();
  await expect(f.refund()).rejects.toMatchObject({
    code: "insufficient_funding",
  });
  // New unrelated credit can cover the reversal without touching existing holds.
  await createCredit({ account_id: f.payer, amount: "50" });
  const id = await f.refund();
  expect(await getBalance({ account_id: f.payer })).toBe("50.0000000000");
  await getPool().query(
    "UPDATE account_funding_authorities SET state='frozen' WHERE payer_account_id=$1",
    [f.payer],
  );
  expect(await f.refund()).toBe(id);
  expect(await getBalance({ account_id: f.payer })).toBe("50.0000000000");
});

it("checks the posted cents when reversing a legacy sub-cent credit", async () => {
  const f = await fixture("credit");
  await getPool().query("UPDATE purchases SET cost=-100.004 WHERE id=$1", [
    f.purchase_id,
  ]);
  await f.allocate();
  await createCredit({ account_id: f.payer, amount: "50" });
  const id = await f.refund();
  const {
    rows: [refund],
  } = await getPool().query("SELECT cost FROM purchases WHERE id=$1", [id]);
  expect(Number(refund.cost)).toBe(100);
  expect(await getBalance({ account_id: f.payer })).toBe("50.0000000000");
});

it("also protects backing when a negative service entry would reverse into a debit", async () => {
  const f = await fixture("service");
  await getPool().query("UPDATE purchases SET cost=-20 WHERE id=$1", [
    f.purchase_id,
  ]);
  f.terms.amount_usd = "110";
  await f.allocate();
  await expect(f.refund()).rejects.toMatchObject({
    code: "insufficient_funding",
  });
  expect(await getBalance({ account_id: f.payer })).toBe("120.0000000000");
});

it.each(["service", "membership", "package"] as const)(
  "restoring a %s charge leaves backing intact and records one refund",
  async (kind) => {
    const f = await fixture(kind);
    await f.allocate();
    const id = await f.refund();
    expect(await f.refund()).toBe(id);
    expect(await getBalance({ account_id: f.payer })).toBe("100.0000000000");
    expect(
      (await getAccountFundingHolds({ account_id: f.payer })).prepaid_held_usd,
    ).toBe("50.0000000000");
  },
);

it("rolls back the reversal and original receipt when membership cancellation is refused", async () => {
  const f = await fixture("membership");
  await f.allocate();
  const update = await getPool().query(
    "UPDATE subscription_renewal_attempts SET state='processing', not_before=NOW()-INTERVAL '1 minute', balance_applied=10 WHERE account_id=$1 AND subscription_id=$2",
    [f.payer, f.subscription_id],
  );
  expect(update.rowCount).toBe(1);
  await expect(f.refund()).rejects.toThrow(/renewing/);
  expect(await getBalance({ account_id: f.payer })).toBe("80.0000000000");
  expect(
    (await getAccountFundingHolds({ account_id: f.payer })).prepaid_held_usd,
  ).toBe("60.0000000000");
  const {
    rows: [purchase],
  } = await getPool().query("SELECT description FROM purchases WHERE id=$1", [
    f.purchase_id,
  ]);
  expect(purchase.description.refund_purchase_id).toBeUndefined();
  const {
    rows: [subscription],
  } = await getPool().query(
    "SELECT status, current_period_end FROM subscriptions WHERE id=$1",
    [f.subscription_id],
  );
  expect(subscription.status).toBe("active");
  expect(new Date(subscription.current_period_end).getTime()).toBeGreaterThan(
    Date.now(),
  );
  const { rows } = await getPool().query(
    "SELECT id FROM purchases WHERE account_id=$1 AND service='refund'",
    [f.payer],
  );
  expect(rows).toHaveLength(0);
});
