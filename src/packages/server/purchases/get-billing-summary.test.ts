/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { after, before } from "@cocalc/server/test";
import { toDecimal } from "@cocalc/util/money";
import { uuid } from "@cocalc/util/misc";
import dayjs from "dayjs";
import createPurchase from "./create-purchase";
import getBillingSummary from "./get-billing-summary";
import { createTestAccount } from "./test-data";

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);
afterAll(after);

describe("billing summary", () => {
  it("returns an empty summary for an account without purchases", async () => {
    const summary = await getBillingSummary({ account_id: uuid() });
    expect(toDecimal(summary.balance).toNumber()).toBe(0);
    expect(toDecimal(summary.spend_30d).toNumber()).toBe(0);
    expect(toDecimal(summary.spend_365d).toNumber()).toBe(0);
    expect(summary.last_transaction_at).toBeNull();
  });

  it("uses live balance and finalized charges from the purchases ledger", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    const creditTime = dayjs().subtract(40, "days");
    const recentChargeTime = dayjs().subtract(20, "days");
    const olderChargeTime = dayjs().subtract(200, "days");

    await createPurchase({
      account_id,
      service: "credit",
      description: { type: "credit" },
      client: null,
      cost: -100,
      time: creditTime.toDate(),
    });
    await createPurchase({
      account_id,
      service: "student-pay",
      description: {} as any,
      client: null,
      cost: 20,
      time: recentChargeTime.toDate(),
    });
    await createPurchase({
      account_id,
      service: "student-pay",
      description: {} as any,
      client: null,
      cost: 30,
      time: olderChargeTime.toDate(),
    });

    const summary = await getBillingSummary({ account_id });
    expect(toDecimal(summary.balance).toNumber()).toBe(50);
    expect(toDecimal(summary.spend_30d).toNumber()).toBe(20);
    expect(toDecimal(summary.spend_365d).toNumber()).toBe(50);
    expect(summary.last_transaction_at).toBe(
      recentChargeTime.toDate().toISOString(),
    );
  });
});
