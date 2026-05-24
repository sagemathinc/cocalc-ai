/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { uuid } from "@cocalc/util/misc";
import { before, after } from "@cocalc/server/test";
import { createTestAccount } from "@cocalc/server/purchases/test-data";
import { getTransactionClient } from "@cocalc/database/pool";
import createVouchers from "./create-vouchers";

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);
afterAll(after);

describe("voucher payment enforcement", () => {
  const account_id = uuid();

  it("rejects Stripe-backed voucher creation when the payment is too small", async () => {
    await createTestAccount(account_id);
    const client = await getTransactionClient();
    try {
      await expect(
        createVouchers({
          account_id,
          active: new Date(),
          amount: 100,
          cancelBy: null,
          client,
          expire: null,
          numVouchers: 2,
          paymentAmount: 1,
          title: "underpaid vouchers",
          whenPay: "now",
        }),
      ).rejects.toThrow(/Please pay|minimum payment/);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
