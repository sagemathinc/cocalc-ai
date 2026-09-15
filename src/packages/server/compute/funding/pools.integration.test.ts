/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { before, after } from "@cocalc/server/test";
import type { CourseFundingDraft } from "@cocalc/util/compute-funding";
import {
  getAccountFundingBacking,
  withFundingAccountTransaction,
} from "./backing";
import { createCourseFundingPoolInTransaction } from "./pools";
import { setPolicy, setPolicyFailure } from "./__tests__/policy-source";

jest.mock("@cocalc/server/project-host/admission", () =>
  require("./__tests__/policy-source").mockPolicySource(),
);

beforeAll(async () => await before({ noConat: true }), 60_000);
afterAll(after);

async function fixture(studentCount = 20) {
  const payer = randomUUID();
  await getPool().query("INSERT INTO accounts (account_id) VALUES ($1)", [
    payer,
  ]);
  await getPool().query(
    "INSERT INTO purchases (account_id, cost, service, time) VALUES ($1,-1000,'credit',now())",
    [payer],
  );
  const terms: CourseFundingDraft = {
    course_project_id: randomUUID(),
    course_instance_id: randomUUID(),
    currency: "USD",
    lane: "prepaid",
    amount_usd: "1000",
    allow_overcommit: false,
    starts_at: new Date(Date.now() - 1000).toISOString(),
    ends_at: new Date(Date.now() + 7 * 86400000).toISOString(),
    recipients: Array.from({ length: studentCount }, () => ({
      beneficiary_account_id: randomUUID(),
      amount_usd: String(1000 / studentCount),
    })),
  };
  return { payer, terms, operation: randomUUID() };
}

async function create(f: Awaited<ReturnType<typeof fixture>>) {
  return await withFundingAccountTransaction(f.payer, async (client) => {
    return await createCourseFundingPoolInTransaction(client, {
      payer_account_id: f.payer,
      operation_id: f.operation,
      terms: f.terms,
    });
  });
}

describe("course funding pool allocation storage", () => {
  it("fails closed on policy preflight loss without blocking an existing receipt or settlement", async () => {
    const f = await fixture();
    const first = await create(f);
    setPolicyFailure(f.payer, new Error("policy provider unavailable"));
    try {
      expect((await create(f)).pool.id).toBe(first.pool.id);
      await expect(create({ ...f, operation: randomUUID() })).rejects.toThrow(
        "policy provider unavailable",
      );
      await expect(
        withFundingAccountTransaction(f.payer, (client) =>
          getAccountFundingBacking(client, f.payer),
        ),
      ).resolves.toMatchObject({ prepaid_held_usd: "1000.0000000000" });
    } finally {
      setPolicyFailure(f.payer);
    }
  });
  it("rejects ineligible payers without placing a hold", async () => {
    const f = await fixture();
    setPolicy(f.payer, { has_active_second_factor: false });
    await expect(create(f)).rejects.toMatchObject({
      code: "funding_unavailable",
    });
    const { rows } = await getPool().query(
      "SELECT id FROM account_funding_holds WHERE payer_account_id=$1",
      [f.payer],
    );
    expect(rows).toHaveLength(0);
  });

  it("replays an allocation after policy loss without creating more backing", async () => {
    const f = await fixture();
    const first = await create(f);
    setPolicy(f.payer, { can_create_hosts: false });
    expect((await create(f)).pool.id).toBe(first.pool.id);
    await expect(
      create({ ...f, operation: randomUUID() }),
    ).rejects.toMatchObject({
      code: "funding_unavailable",
    });
  });

  it("requires postpaid billing readiness and derives capacity from the credit line", async () => {
    const f = await fixture();
    f.terms.lane = "postpaid";
    setPolicy(f.payer, { has_payment_method: false });
    await expect(create(f)).rejects.toThrow(/automatic billing/);
    setPolicy(f.payer, {
      effective_limits: {
        credit_spend_limit_5h_usd: 50,
        credit_spend_limit_7d_usd: 100,
      },
    });
    await expect(create(f)).rejects.toMatchObject({
      code: "insufficient_funding",
    });
  });

  it.each([20, 50])(
    "creates one backed %i-student pool under simultaneous retries",
    async (studentCount) => {
      const f = await fixture(studentCount);
      const results = await Promise.all([create(f), create(f), create(f)]);
      expect(results.filter((result) => result.created)).toHaveLength(1);
      const allocation = results[0];
      expect(new Set(results.map((result) => result.pool.id)).size).toBe(1);
      expect(allocation.grants).toHaveLength(studentCount);
      for (const result of results) {
        expect(result.grants.map((grant) => grant.id)).toEqual(
          allocation.grants.map((grant) => grant.id),
        );
      }
      expect(allocation.pool.authorized_usd).toBe("1000.0000000000");
      expect(allocation.pool.state).toBe("active");
      const { rows: windows } = await getPool().query(
        "SELECT id FROM account_usage_windows WHERE account_id=$1",
        [f.payer],
      );
      expect(windows).toHaveLength(0);
      const balance = await withFundingAccountTransaction(f.payer, (client) =>
        getAccountFundingBacking(client, f.payer),
      );
      expect(balance.ledger_balance_usd).toBe("1000.0000000000");
      expect(balance.spendable_prepaid_usd).toBe("0.0000000000");
    },
  );

  it("deduplicates an allocation independent of recipient order", async () => {
    const f = await fixture();
    const first = await create(f);
    const again = await create({
      ...f,
      terms: { ...f.terms, recipients: [...f.terms.recipients].reverse() },
    });
    expect(again.created).toBe(false);
    expect(again.pool.id).toBe(first.pool.id);
    expect(again.grants.map((grant) => grant.id)).toEqual(
      first.grants.map((grant) => grant.id),
    );
    await expect(
      create({ ...f, terms: { ...f.terms, allow_overcommit: true } }),
    ).rejects.toMatchObject({ code: "funding_conflict" });
  });

  it("never spends more backing merely because overcommit is allowed", async () => {
    const f = await fixture();
    f.terms.allow_overcommit = true;
    f.terms.recipients[0].amount_usd = "1000";
    await create(f);
    await expect(
      create({ ...f, operation: randomUUID() }),
    ).rejects.toMatchObject({ code: "insufficient_funding" });
  });

  it("rolls back backing and all grants when the surrounding operation fails", async () => {
    const f = await fixture();
    await expect(
      withFundingAccountTransaction(f.payer, async (client) => {
        await createCourseFundingPoolInTransaction(client, {
          payer_account_id: f.payer,
          operation_id: f.operation,
          terms: f.terms,
        });
        throw new Error("approval consumption failed");
      }),
    ).rejects.toThrow("approval consumption failed");
    const { rows } = await getPool().query(
      "SELECT id FROM account_funding_holds WHERE payer_account_id=$1",
      [f.payer],
    );
    expect(rows).toHaveLength(0);
    expect((await create(f)).created).toBe(true);
  });

  it("schedules future allocations and rejects already expired ones", async () => {
    const f = await fixture();
    f.terms.starts_at = new Date(Date.now() + 86400000).toISOString();
    expect((await create(f)).pool.state).toBe("scheduled");
    const expired = await fixture();
    expired.terms.starts_at = "2020-01-01T00:00:00Z";
    expired.terms.ends_at = "2020-01-02T00:00:00Z";
    await expect(create(expired)).rejects.toThrow(/expired/);
  });

  it("enforces pool conservation even for direct database writes", async () => {
    const f = await fixture();
    const { pool } = await create(f);
    await expect(
      getPool().query(
        "UPDATE compute_funding_pools SET spent_usd=600,reserved_usd=401 WHERE id=$1",
        [pool.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      getPool().query(
        "UPDATE compute_funding_pools SET state='closed' WHERE id=$1",
        [pool.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      getPool().query(
        "UPDATE compute_funding_pools SET lane='postpaid' WHERE id=$1",
        [pool.id],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
});
