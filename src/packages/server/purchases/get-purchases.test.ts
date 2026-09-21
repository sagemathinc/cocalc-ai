/*
 *  This file is part of CoCalc: Copyright © 2022 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import createAccount from "@cocalc/server/accounts/create-account";
import createPurchase from "./create-purchase";
import getPurchases from "./get-purchases";
import { toDecimal } from "@cocalc/util/money";
import { uuid } from "@cocalc/util/misc";
import dayjs from "dayjs";
import { before, after, getPool } from "@cocalc/server/test";
import { createTestAccount } from "./test-data";

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);
afterAll(after);

describe("creates and get purchases using various options", () => {
  const account_id = uuid();

  it("gets purchases for an account that doesn't exist yet (fine, there aren't any)", async () => {
    const { purchases } = await getPurchases({ account_id });
    expect(purchases).toEqual([]);
  });

  it("creates account and a purchase and gets it", async () => {
    await createAccount({
      email: `${account_id}@example.com`,
      password: "xyz",
      firstName: "Test",
      lastName: "User",
      account_id,
    });
    await createPurchase({
      account_id,
      service: "credit",
      description: {} as any,
      client: null,
      cost: -100,
    });
    const { purchases: p } = await getPurchases({ account_id });
    expect(p.length).toBe(1);
    expect(toDecimal(p[0].cost!).toNumber()).toBe(-100);
  });

  it("gets purchase along with email address", async () => {
    const email_address = `${account_id}@cocalc.ai`;
    const pool = getPool();
    await pool.query(
      "UPDATE accounts SET email_address=$1 WHERE account_id=$2",
      [email_address, account_id],
    );
    const { purchases: p } = await getPurchases({
      account_id,
      includeName: true,
    });
    expect(p.length).toBe(1);
    expect(p[0].email_address).toBe(email_address);
    expect(p[0].display_name).toBe("Test User");
    expect(p[0].first_name).toBeNull();
    expect(p[0].last_name).toBeNull();
  });

  it("tests cutoff param by creating another older purchase then gets it and also filters it using cutoff", async () => {
    const purchase_id = await createPurchase({
      account_id,
      service: "student-pay",
      description: {} as any,
      client: null,
      cost: 5,
    });
    const pool = getPool();
    const month_ago = dayjs().subtract(1, "month").toDate();
    await pool.query("UPDATE purchases SET time=$1 WHERE id=$2", [
      month_ago,
      purchase_id,
    ]);

    const { purchases: p } = await getPurchases({ account_id });
    expect(p.length).toBe(2); // also counts above purchase
    const { purchases: p_cutoff } = await getPurchases({
      account_id,
      cutoff: dayjs().subtract(2, "month").toDate(),
    });
    expect(p_cutoff.length).toBe(2);

    const { purchases: p_cutoff2 } = await getPurchases({
      account_id,
      cutoff: dayjs().subtract(1, "week").toDate(),
    });
    expect(p_cutoff2.length).toBe(1);

    const { purchases: p_cutoff_end } = await getPurchases({
      account_id,
      cutoff_end: dayjs().subtract(1, "week").toDate(),
    });
    expect(p_cutoff_end.length).toBe(1);

    const { purchases: p_range } = await getPurchases({
      account_id,
      cutoff: dayjs().subtract(2, "month").toDate(),
      cutoff_end: dayjs().subtract(1, "week").toDate(),
    });
    expect(p_range.length).toBe(1);
  });

  it("groups purchases by service without splitting by project", async () => {
    const pool = getPool();
    const firstPurchaseId = await createPurchase({
      account_id,
      service: "student-pay",
      description: {} as any,
      client: null,
      cost: 7,
    });
    const secondPurchaseId = await createPurchase({
      account_id,
      service: "student-pay",
      description: {} as any,
      client: null,
      cost: 11,
    });
    await pool.query("UPDATE purchases SET project_id=$1 WHERE id=$2", [
      uuid(),
      firstPurchaseId,
    ]);
    await pool.query("UPDATE purchases SET project_id=$1 WHERE id=$2", [
      uuid(),
      secondPurchaseId,
    ]);

    const { purchases } = await getPurchases({ account_id, group: true });
    const rows = purchases.filter(({ service }) => service === "student-pay");

    expect(rows).toHaveLength(1);
    expect(rows[0].project_id).toBeUndefined();
    expect((rows[0] as any).count).toBe(3);
  });

  it("groups precise active estimates as whole-cent ledger amounts", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    await createPurchase({
      account_id,
      service: "dedicated-host",
      description: {} as any,
      client: null,
      cost_so_far: "0.006",
      period_start: new Date(),
    });

    const { balance, purchases } = await getPurchases({
      account_id,
      group: true,
    });

    expect(balance).toBe("-0.0100000000");
    expect(purchases).toMatchObject([
      { service: "dedicated-host", cost: "0.01", count: 1 },
    ]);
  });
});

describe("purchase history balances", () => {
  it("uses the selected end date for ranged balances", async () => {
    const account_id = uuid();
    await createAccount({
      email: `${account_id}@example.com`,
      password: "xyz",
      firstName: "Balance",
      lastName: "Range",
      account_id,
    });
    const base = dayjs("2026-06-01T12:00:00Z");
    await createPurchase({
      account_id,
      service: "credit",
      description: {} as any,
      client: null,
      cost: -100,
      time: base.toDate(),
    });
    await createPurchase({
      account_id,
      service: "membership",
      description: {} as any,
      client: null,
      cost: 20,
      time: base.add(1, "day").toDate(),
    });
    await createPurchase({
      account_id,
      service: "credit",
      description: {} as any,
      client: null,
      cost: -50,
      time: base.add(3, "day").toDate(),
    });

    const { balance, purchases } = await getPurchases({
      account_id,
      cutoff_end: base.add(2, "day").toDate(),
    });

    expect(purchases).toHaveLength(2);
    expect(toDecimal(balance).toNumber()).toBe(80);
  });

  it("approximates active metered purchases at the selected end date", async () => {
    const account_id = uuid();
    await createAccount({
      email: `${account_id}@example.com`,
      password: "xyz",
      firstName: "Balance",
      lastName: "Active",
      account_id,
    });
    const base = dayjs("2026-06-01T12:00:00Z");
    await createPurchase({
      account_id,
      service: "credit",
      description: {} as any,
      client: null,
      cost: -100,
      time: base.toDate(),
    });
    await createPurchase({
      account_id,
      service: "dedicated-host",
      description: {} as any,
      client: null,
      cost_per_hour: 2,
      period_start: base.add(1, "hour").toDate(),
      time: base.add(1, "hour").toDate(),
    });

    const { balance } = await getPurchases({
      account_id,
      cutoff_end: base.add(4, "hours").toDate(),
    });

    expect(toDecimal(balance).toNumber()).toBe(94);
  });
});
