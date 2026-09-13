import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { before, after } from "@cocalc/server/test";
import { withFundingAccountTransaction } from "@cocalc/server/compute/funding/backing";
import {
  applyMonthlyCollection,
  readMonthlyCollection,
} from "./monthly-collection";
import {
  claimMonthlyCollection,
  maintainMonthlyCollections,
} from "./monthly-collection-worker";
import { hasUsageSubscription } from "./stripe-usage-based-subscription";
import createPaymentIntent from "./stripe/create-payment-intent";
import { getServerSettings } from "@cocalc/database/settings";
import { freezeAccountFinancialState } from "@cocalc/server/accounts/financial-rehome";

jest.mock("./stripe/create-payment-intent", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("@cocalc/server/messages/send", () => ({
  __esModule: true,
  default: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@cocalc/database/settings", () => ({
  getServerSettings: jest.fn(),
}));
beforeAll(async () => await before({ noConat: true }), 60000);
afterAll(after);
beforeEach(() => {
  (getServerSettings as jest.Mock).mockResolvedValue({
    stripe_secret_key: "test-only",
    stripe_publishable_key: "test-only",
    pay_as_you_go_min_payment: 5,
  });
  (createPaymentIntent as jest.Mock).mockReset().mockResolvedValue({
    payment_intent: "pi_test",
    hosted_invoice_url: "https://example.test/invoice",
  });
});
async function fixture(enabled = true) {
  const account_id = randomUUID();
  await getPool().query(
    "INSERT INTO accounts(account_id,monthly_collection) VALUES($1,$2::jsonb)",
    [account_id, JSON.stringify({ enabled, version: 1, terms_version: 1 })],
  );
  await getPool().query(
    "INSERT INTO purchases(account_id,cost,service,time) VALUES($1,10,'compute-vm',now())",
    [account_id],
  );
  const {
    rows: [s],
  } = await getPool().query(
    "INSERT INTO statements(account_id,interval,time,balance) VALUES($1,'month',now(),-10) RETURNING id",
    [account_id],
  );
  return { account_id, statement_id: s.id };
}
const postgresTest = process.env.COCALC_TEST_USE_PGLITE === "1" ? it.skip : it;
postgresTest(
  "concurrent workers claim exactly once and retain the consent version",
  async () => {
    const f = await fixture();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => claimMonthlyCollection(f.account_id, 5)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.find(Boolean)).toMatchObject({
      ...f,
      consent_version: 1,
      amount_usd: "10.0000000000",
      state: "claimed",
    });
  },
);
it("opt-out overrides legacy eligibility and an old enable review cannot reactivate it", async () => {
  const f = await fixture();
  await getPool().query(
    "UPDATE accounts SET stripe_usage_subscription='legacy' WHERE account_id=$1",
    [f.account_id],
  );
  expect(await hasUsageSubscription(f.account_id)).toBe(true);
  await withFundingAccountTransaction(f.account_id, (db) =>
    applyMonthlyCollection(
      db,
      f.account_id,
      {
        kind: "monthlyCollection",
        enabled: false,
        expected_version: 1,
        terms_version: 1,
      },
      randomUUID(),
    ),
  );
  expect(await hasUsageSubscription(f.account_id)).toBe(false);
  expect(await claimMonthlyCollection(f.account_id, 5)).toBeUndefined();
  await expect(
    withFundingAccountTransaction(f.account_id, (db) =>
      applyMonthlyCollection(
        db,
        f.account_id,
        {
          kind: "monthlyCollection",
          enabled: true,
          expected_version: 1,
          terms_version: 1,
        },
        randomUUID(),
      ),
    ),
  ).rejects.toThrow("changed");
  expect((await readMonthlyCollection(f.account_id)).consent).toMatchObject({
    enabled: false,
    version: 2,
  });
});
it("does not claim while disabled, below minimum, paid, or covered by a deposit", async () => {
  const off = await fixture(false);
  expect(await claimMonthlyCollection(off.account_id, 5)).toBeUndefined();
  const small = await fixture();
  expect(await claimMonthlyCollection(small.account_id, 15)).toBeUndefined();
  const paid = await fixture();
  await getPool().query(
    "UPDATE statements SET paid_purchase_id=1 WHERE id=$1",
    [paid.statement_id],
  );
  expect(await claimMonthlyCollection(paid.account_id, 5)).toBeUndefined();
  const deposited = await fixture();
  await getPool().query(
    "INSERT INTO purchases(account_id,cost,service,time) VALUES($1,-5,'credit',now())",
    [deposited.account_id],
  );
  expect(await claimMonthlyCollection(deposited.account_id, 5)).toBeUndefined();
});
it("does not let a newer statement bypass an uncertain previous attempt", async () => {
  const f = await fixture();
  await claimMonthlyCollection(f.account_id, 5);
  await getPool().query(
    "INSERT INTO statements(account_id,interval,time,balance) VALUES($1,'month',now(),-10)",
    [f.account_id],
  );
  expect(await claimMonthlyCollection(f.account_id, 5)).toBeUndefined();
});
it("refuses a retired or remote financial authority", async () => {
  const f = await fixture();
  await getPool().query(
    "UPDATE accounts SET home_bay_id='other-bay' WHERE account_id=$1",
    [f.account_id],
  );
  await expect(claimMonthlyCollection(f.account_id, 5)).rejects.toThrow();
});
it("uses stable provider idempotency and never resubmits a failed attempt", async () => {
  // Keep this maintenance pass restricted to its fixture; other fixtures have
  // independently tested claims or intentionally collectible statements.
  await getPool().query(
    "UPDATE accounts SET monthly_collection=jsonb_set(monthly_collection,'{enabled}','false') WHERE monthly_collection IS NOT NULL",
  );
  const f = await fixture();
  (createPaymentIntent as jest.Mock).mockRejectedValueOnce(
    Error("response lost"),
  );
  await maintainMonthlyCollections();
  await maintainMonthlyCollections();
  expect(createPaymentIntent).toHaveBeenCalledTimes(1);
  expect(createPaymentIntent).toHaveBeenCalledWith(
    expect.objectContaining({
      account_id: f.account_id,
      purpose: `statement-${f.statement_id}`,
      requireAddress: true,
      idempotencyKeyPrefix: expect.stringMatching(/^monthly-collection:/),
    }),
  );
  const {
    rows: [s],
  } = await getPool().query(
    "SELECT monthly_collection FROM statements WHERE id=$1",
    [f.statement_id],
  );
  expect(s.monthly_collection.state).toBe("requires_review");
  expect(await hasUsageSubscription(f.account_id)).toBe(false);
  await getPool().query(
    "UPDATE statements SET paid_purchase_id=1 WHERE id=$1",
    [f.statement_id],
  );
  expect(await hasUsageSubscription(f.account_id)).toBe(true);
});
it("suspends postpaid eligibility for a stalled claimed or unpaid issued invoice", async () => {
  const f = await fixture();
  await claimMonthlyCollection(f.account_id, 5);
  expect(await hasUsageSubscription(f.account_id)).toBe(true);
  await getPool().query(
    "UPDATE statements SET automatic_payment=now()-interval '11 minutes' WHERE id=$1",
    [f.statement_id],
  );
  expect(await hasUsageSubscription(f.account_id)).toBe(false);
  await getPool().query(
    "UPDATE statements SET monthly_collection=jsonb_set(monthly_collection,'{state}','\"issued\"') WHERE id=$1",
    [f.statement_id],
  );
  expect(await hasUsageSubscription(f.account_id)).toBe(false);
});
postgresTest(
  "prevents account rehome while a provider attempt has no reconciled identity",
  async () => {
    const f = await fixture();
    await claimMonthlyCollection(f.account_id, 5);
    const client = await getPool().connect();
    const op = {
      op_id: randomUUID(),
      account_id: f.account_id,
      source_bay_id: "source",
      dest_bay_id: "destination",
    };
    try {
      for (const state of ["claimed", "requires_review"]) {
        await getPool().query(
          "UPDATE statements SET monthly_collection=jsonb_set(monthly_collection,'{state}',$2::jsonb) WHERE id=$1",
          [f.statement_id, JSON.stringify(state)],
        );
        await client.query("BEGIN");
        await expect(freezeAccountFinancialState(client, op)).rejects.toThrow(
          "reconcile the payment",
        );
        await client.query("ROLLBACK");
      }
      await getPool().query(
        "UPDATE statements SET automatic_payment_intent_id='pi_reconciled' WHERE id=$1",
        [f.statement_id],
      );
      await client.query("BEGIN");
      // The normal source-authority check is reached only after the unresolved
      // payment guard permits the move. Full moves are covered separately.
      await expect(freezeAccountFinancialState(client, op)).rejects.toThrow(
        "source home bay",
      );
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  },
);
