/*
 *  This file is part of CoCalc: Copyright © 2022 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getBalance from "./get-balance";
import createPurchase from "./create-purchase";
import { uuid } from "@cocalc/util/misc";
import dayjs from "dayjs";
import { before, after, getPool } from "@cocalc/server/test";
import { toDecimal } from "@cocalc/util/money";
import { createTestAccount } from "./test-data";
import {
  ensurePurchaseCostCentsSchema,
  PURCHASE_COST_CENTS_TRIGGER,
} from "@cocalc/database/postgres/schema/purchase-cost-cents";

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);
afterAll(after);

describe("test computing balance under various conditions", () => {
  const account_id = uuid();
  beforeAll(async () => createTestAccount(account_id));

  it("get the balance for a new user with no purchases", async () => {
    expect(toDecimal(await getBalance({ account_id })).toNumber()).toBe(0);
  });

  it("with one purchase", async () => {
    await createPurchase({
      account_id,
      service: "student-pay",
      description: {} as any,
      client: null,
      cost: 3.89,
    });
    expect(toDecimal(await getBalance({ account_id })).toNumber()).toBeCloseTo(
      -3.89,
      2,
    );
  });

  it("posts finalized costs in whole cents", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    const purchase_id = await createPurchase({
      account_id,
      service: "student-pay",
      description: {} as any,
      client: null,
      cost: "1.005",
    });
    const { rows } = await getPool().query(
      "SELECT cost FROM purchases WHERE id=$1",
      [purchase_id],
    );

    expect(rows[0].cost).toBe("1.0100000000");
    expect(await getBalance({ account_id })).toBe("-1.0100000000");
  });

  it("normalizes direct fractional finalized ledger writes", async () => {
    const purchaseAccount = uuid();
    await createTestAccount(purchaseAccount);
    const inserted = await getPool().query(
      `INSERT INTO purchases
         (time, account_id, cost, service, description)
       VALUES (NOW(), $1, $2, 'student-pay', '{}'::jsonb)
       RETURNING cost`,
      [uuid(), "1.006"],
    );
    expect(inserted.rows[0].cost).toBe("1.0100000000");

    const purchase_id = await createPurchase({
      account_id: purchaseAccount,
      service: "dedicated-host",
      description: {} as any,
      client: null,
      cost_per_hour: "0.02",
      period_start: new Date(),
    });
    const updated = await getPool().query(
      "UPDATE purchases SET cost=$2 WHERE id=$1 RETURNING cost",
      [purchase_id, "0.006"],
    );
    expect(updated.rows[0].cost).toBe("0.0100000000");
  });

  it("preserves a zero aggregate balance for legacy fractional rows", async () => {
    const account_id = uuid();
    const pool = getPool();
    await pool.query(
      `DROP TRIGGER IF EXISTS ${PURCHASE_COST_CENTS_TRIGGER} ON purchases`,
    );
    try {
      await pool.query(
        `INSERT INTO purchases
           (time, account_id, cost, service, description)
         VALUES
           (NOW(), $1, 0.005, 'dedicated-host', '{}'),
           (NOW(), $1, 0.005, 'dedicated-host', '{}'),
           (NOW(), $1, -0.01, 'refund', '{}')`,
        [account_id],
      );
    } finally {
      const client = await pool.connect();
      try {
        await ensurePurchaseCostCentsSchema(client);
      } finally {
        client.release();
      }
    }
    try {
      expect(await getBalance({ account_id })).toBe("0.0000000000");
    } finally {
      await pool.query("DELETE FROM purchases WHERE account_id=$1", [
        account_id,
      ]);
    }
  });

  it("with an additional credit", async () => {
    await createPurchase({
      account_id,
      service: "credit",
      description: {} as any,
      client: null,
      cost: -5,
    });
    expect(toDecimal(await getBalance({ account_id })).toNumber()).toBeCloseTo(
      -3.89 + 5,
      2,
    );
  });

  it("force saves the cached account row even inside the update throttle", async () => {
    const account_id = uuid();
    await getPool().query(
      "INSERT INTO accounts (account_id, email_address, balance) VALUES ($1, $2, $3)",
      [account_id, `${account_id}@example.com`, 999],
    );
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      await createPurchase({
        account_id,
        service: "student-pay",
        description: {} as any,
        client: null,
        cost: 1.25,
      });
      await getBalance({ account_id });

      await createPurchase({
        account_id,
        service: "student-pay",
        description: {} as any,
        client: null,
        cost: 2,
      });
      nowSpy.mockReturnValue(1_000_500);
      expect(
        toDecimal(await getBalance({ account_id })).toNumber(),
      ).toBeCloseTo(-3.25, 2);
      let { rows } = await getPool().query(
        "SELECT balance FROM accounts WHERE account_id=$1",
        [account_id],
      );
      expect(toDecimal(rows[0].balance).toNumber()).toBeCloseTo(-1.25, 2);

      await getBalance({ account_id, forceSave: true });
      rows = (
        await getPool().query(
          "SELECT balance FROM accounts WHERE account_id=$1",
          [account_id],
        )
      ).rows;
      expect(toDecimal(rows[0].balance).toNumber()).toBeCloseTo(-3.25, 2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("with a different account that has a purchase, which shouldn't impact anything", async () => {
    const account_id2 = uuid();
    await createTestAccount(account_id2);
    await createPurchase({
      account_id: account_id2,
      service: "student-pay",
      description: {} as any,
      client: null,
      cost: 1.23,
    });
    expect(toDecimal(await getBalance({ account_id })).toNumber()).toBeCloseTo(
      -3.89 + 5,
      2,
    );
    expect(
      toDecimal(await getBalance({ account_id: account_id2 })).toNumber(),
    ).toBeCloseTo(-1.23, 2);
  });

  it("with a purchase that has an open range and a cost_per_hour", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    const hours = 2;
    const period_start = dayjs().subtract(hours, "hour").toDate();
    await createPurchase({
      account_id,
      service: "membership",
      description: {
        type: "membership",
        subscription_id: 1,
        class: "member",
        interval: "month",
      } as any,
      client: null,
      cost_per_hour: 1.25,
      period_start,
    });
    expect(toDecimal(await getBalance({ account_id })).toNumber()).toBeCloseTo(
      -1.25 * hours,
      2,
    );
  });

  it("with a purchase that has an open range and a cost_so_far", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    const hours = 999; // doesn't matter
    const period_start = dayjs().subtract(hours, "hour").toDate();
    await createPurchase({
      account_id,
      service: "membership",
      description: {
        type: "membership",
        subscription_id: 2,
        class: "member",
        interval: "year",
      } as any,
      client: null,
      cost_so_far: 1.25,
      period_start,
    });
    expect(toDecimal(await getBalance({ account_id })).toNumber()).toBeCloseTo(
      -1.25,
      2,
    );
  });

  it("rounds a precise active usage estimate in the account balance", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    const purchase_id = await createPurchase({
      account_id,
      service: "dedicated-host",
      description: {} as any,
      client: null,
      cost_so_far: "0.006",
      period_start: new Date(),
    });
    const { rows } = await getPool().query(
      "SELECT cost_so_far FROM purchases WHERE id=$1",
      [purchase_id],
    );

    expect(rows[0].cost_so_far).toBe("0.0060000000");
    expect(await getBalance({ account_id })).toBe("-0.0100000000");
  });

  it("with a purchase that has a closed range and a cost_per_hour", async () => {
    const period_start = dayjs().subtract(4, "hour").toDate();
    const period_end = dayjs().subtract(1, "hour").toDate();
    const account_id = uuid();
    await createTestAccount(account_id);
    await createPurchase({
      account_id,
      service: "membership",
      description: {
        type: "membership",
        subscription_id: 3,
        class: "member",
        interval: "month",
      } as any,
      client: null,
      cost_per_hour: 1.25,
      period_start,
      period_end,
    });
    expect(toDecimal(await getBalance({ account_id })).toNumber()).toBeCloseTo(
      -1.25 * 3,
      2,
    );
  });
});
