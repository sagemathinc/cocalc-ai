/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { before, after } from "@cocalc/server/test";
import {
  getAccountFundingBacking,
  reduceAccountFundingBacking,
  reserveAccountFundingBacking,
  withFundingAccountTransaction,
} from "./backing";

beforeAll(async () => await before({ noConat: true }), 60_000);
afterAll(after);

async function account(balance = "1000"): Promise<string> {
  const id = randomUUID();
  await getPool().query("INSERT INTO accounts (account_id) VALUES ($1)", [id]);
  await getPool().query(
    "INSERT INTO purchases (account_id, cost, service, time) VALUES ($1, -$2::numeric, 'credit', now())",
    [id, balance],
  );
  return id;
}

async function reserve(payer: string, source: string, amount: string) {
  return await withFundingAccountTransaction(payer, async (client) => {
    const balance = await getAccountFundingBacking(client, payer);
    return await reserveAccountFundingBacking(client, {
      payer_account_id: payer,
      source_kind: "course-pool",
      source_id: source,
      lane: "prepaid",
      authorized_usd: amount,
      capacity_usd: balance.ledger_balance_usd,
    });
  });
}

describe("payer-home funding backing", () => {
  // PGlite has one physical connection; exercise inter-transaction locks on PG.
  const postgresTest =
    process.env.COCALC_TEST_USE_PGLITE === "1" ? it.skip : it;
  postgresTest(
    "serializes simultaneous competing pools without double spending",
    async () => {
      const payer = await account();
      const attempts = await Promise.allSettled([
        reserve(payer, randomUUID(), "600"),
        reserve(payer, randomUUID(), "600"),
      ]);
      expect(attempts.filter((x) => x.status === "fulfilled")).toHaveLength(1);
      expect(attempts.filter((x) => x.status === "rejected")).toHaveLength(1);
      const balance = await withFundingAccountTransaction(payer, (client) =>
        getAccountFundingBacking(client, payer),
      );
      expect(balance).toEqual({
        ledger_balance_usd: "1000.0000000000",
        prepaid_held_usd: "600.0000000000",
        postpaid_committed_usd: "0.0000000000",
        spendable_prepaid_usd: "400.0000000000",
      });
    },
  );

  it("subtracts prior holds from later allocations", async () => {
    const payer = await account();
    await reserve(payer, randomUUID(), "600");
    await expect(reserve(payer, randomUUID(), "600")).rejects.toMatchObject({
      code: "insufficient_funding",
    });
  });

  it("deduplicates a source and refuses changed terms", async () => {
    const payer = await account();
    const source = randomUUID();
    const hold = await reserve(payer, source, "500");
    expect((await reserve(payer, source, "500.00")).id).toBe(hold.id);
    await expect(reserve(payer, source, "501")).rejects.toMatchObject({
      code: "funding_conflict",
    });
  });

  it("consumes backing and the ledger together without double-counting spend", async () => {
    const payer = await account();
    const hold = await reserve(payer, randomUUID(), "1000");
    await withFundingAccountTransaction(payer, async (client) => {
      await client.query(
        "INSERT INTO purchases (account_id, cost, service, time) VALUES ($1, 100, 'compute-vm', now())",
        [payer],
      );
      await reduceAccountFundingBacking(client, {
        payer_account_id: payer,
        hold_id: hold.id,
        amount_usd: "100",
      });
      const balance = await getAccountFundingBacking(client, payer);
      expect(balance.ledger_balance_usd).toBe("900.0000000000");
      expect(balance.prepaid_held_usd).toBe("900.0000000000");
      expect(balance.spendable_prepaid_usd).toBe("0.0000000000");
    });
  });

  it("rolls back a failed ledger/source update", async () => {
    const payer = await account();
    const hold = await reserve(payer, randomUUID(), "100");
    await expect(
      withFundingAccountTransaction(payer, async (client) => {
        await reduceAccountFundingBacking(client, {
          payer_account_id: payer,
          hold_id: hold.id,
          amount_usd: "100",
        });
        throw new Error("simulated settlement failure");
      }),
    ).rejects.toThrow("simulated");
    expect((await reserve(payer, hold.source_id, "100")).remaining_usd).toBe(
      "100.0000000000",
    );
  });

  it("does not resurrect an entirely consumed hold on replay", async () => {
    const payer = await account();
    const hold = await reserve(payer, randomUUID(), "100");
    await withFundingAccountTransaction(payer, async (client) => {
      await reduceAccountFundingBacking(client, {
        payer_account_id: payer,
        hold_id: hold.id,
        amount_usd: "100",
      });
    });
    expect((await reserve(payer, hold.source_id, "100")).remaining_usd).toBe(
      "0.0000000000",
    );
  });

  it("cannot reduce another payer's backing or over-release it", async () => {
    const payer = await account();
    const other = await account();
    const hold = await reserve(payer, randomUUID(), "100");
    await expect(
      withFundingAccountTransaction(other, (client) =>
        reduceAccountFundingBacking(client, {
          payer_account_id: other,
          hold_id: hold.id,
          amount_usd: "1",
        }),
      ),
    ).rejects.toMatchObject({ code: "funding_conflict" });
    await expect(
      withFundingAccountTransaction(payer, (client) =>
        reduceAccountFundingBacking(client, {
          payer_account_id: payer,
          hold_id: hold.id,
          amount_usd: "101",
        }),
      ),
    ).rejects.toMatchObject({ code: "funding_conflict" });
  });

  it("refuses writes on a nonauthoritative account bay", async () => {
    const payer = await account();
    await getPool().query(
      "UPDATE accounts SET home_bay_id=$2 WHERE account_id=$1",
      [payer, `other-${randomUUID()}`],
    );
    await expect(reserve(payer, randomUUID(), "1")).rejects.toThrow(/homed on/);
  });

  it("enforces monetary constraints in PostgreSQL, not only TypeScript", async () => {
    const payer = await account();
    const hold = await reserve(payer, randomUUID(), "100");
    for (const amount of ["-1", "101", "NaN"]) {
      await expect(
        getPool().query(
          "UPDATE account_funding_holds SET remaining_usd=$2 WHERE id=$1",
          [hold.id, amount],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("requires the active payer transaction, including for reads used in admission", async () => {
    const payer = await account();
    const other = await account();
    const client = await getPool().connect();
    try {
      await expect(
        getAccountFundingBacking(client, payer),
      ).rejects.toMatchObject({ code: "funding_conflict" });
    } finally {
      client.release();
    }
    await expect(
      withFundingAccountTransaction(payer, (locked) =>
        getAccountFundingBacking(locked, other),
      ),
    ).rejects.toMatchObject({ code: "funding_conflict" });
  });

  it("keeps postpaid commitments out of transferable prepaid credit", async () => {
    const payer = await account("0");
    await withFundingAccountTransaction(payer, async (client) => {
      await reserveAccountFundingBacking(client, {
        payer_account_id: payer,
        source_kind: "course-pool",
        source_id: randomUUID(),
        lane: "postpaid",
        authorized_usd: "500",
        capacity_usd: "1000",
      });
      const backing = await getAccountFundingBacking(client, payer);
      expect(backing.spendable_prepaid_usd).toBe("0.0000000000");
      expect(backing.postpaid_committed_usd).toBe("500.0000000000");
      await expect(
        reserveAccountFundingBacking(client, {
          payer_account_id: payer,
          source_kind: "transfer",
          source_id: randomUUID(),
          lane: "postpaid",
          authorized_usd: "1",
          capacity_usd: "1000",
        }),
      ).rejects.toMatchObject({ code: "invalid_funding_request" });
    });
  });
});
