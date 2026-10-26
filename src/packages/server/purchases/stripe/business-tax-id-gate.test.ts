/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { before, after, getPool } from "@cocalc/server/test";
import { uuid } from "@cocalc/util/misc";
import { createTestAccount } from "../test-data";
import { SUBSCRIPTION_RENEWAL } from "@cocalc/util/db-schema/purchases";
import {
  assertBusinessTaxIdForPurchase,
  recordBusinessTaxIdRefusal,
  sendOffSessionRefusalNotice,
} from "./business-tax-id-gate";

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);

afterAll(after);

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await getPool().query(sql, params);
  return rows[0].n;
}

describe("business tax ID gate bookkeeping", () => {
  it("counts a refusal once per account, path and day, even when concurrent", async () => {
    const account_id = uuid();
    const refuse = () =>
      recordBusinessTaxIdRefusal({
        account_id,
        country: "DE",
        path: "auto-credit",
        reason: "missing",
        amount: 72,
      });
    await refuse();
    await refuse();
    await Promise.all([refuse(), refuse(), refuse()]);
    await recordBusinessTaxIdRefusal({
      account_id,
      country: "DE",
      path: "subscription-renewal",
      reason: "missing",
    });
    expect(
      await count(
        "SELECT count(*)::int AS n FROM business_tax_id_refusals WHERE account_id=$1",
        [account_id],
      ),
    ).toBe(2);
    expect(
      await count(
        "SELECT count(*)::int AS n FROM business_tax_id_refusals WHERE account_id=$1 AND path='auto-credit' AND amount=72",
        [account_id],
      ),
    ).toBe(1);
  });

  it("sends the off-session notice once a week, exactly once under concurrency", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    const notices = () =>
      count(
        `SELECT count(*)::int AS n FROM notification_targets
          WHERE target_account_id=$1 AND dedupe_key=$2`,
        [account_id, `business-tax-id-required:${account_id}`],
      );

    const concurrent = await Promise.all([
      sendOffSessionRefusalNotice(account_id),
      sendOffSessionRefusalNotice(account_id),
      sendOffSessionRefusalNotice(account_id),
    ]);
    expect(concurrent.filter(Boolean)).toHaveLength(1);
    expect(await notices()).toBe(1);

    expect(await sendOffSessionRefusalNotice(account_id)).toBe(false);
    expect(await notices()).toBe(1);

    // A week later the customer is told again.
    await getPool().query(
      "UPDATE business_tax_id_notices SET notified_at = NOW() - interval '8 days' WHERE account_id=$1",
      [account_id],
    );
    expect(await sendOffSessionRefusalNotice(account_id)).toBe(true);
    expect(await notices()).toBe(2);
  });

  it("is not suppressed by earlier interactive refusals", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    await recordBusinessTaxIdRefusal({
      account_id,
      country: "FR",
      path: "checkout:membership-change",
      reason: "missing",
    });
    expect(await sendOffSessionRefusalNotice(account_id)).toBe(true);
  });

  it("notifies the customer when it refuses an automatic subscription renewal", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    const stripe = {
      customers: {
        retrieve: async () => ({
          address: { country: "DE" },
          tax_ids: { data: [] },
        }),
      },
    };
    await expect(
      assertBusinessTaxIdForPurchase({
        stripe,
        customer: "cus_test",
        account_id,
        path: SUBSCRIPTION_RENEWAL,
        amount: 10,
      }),
    ).rejects.toMatchObject({ code: "business_tax_id_required" });
    expect(
      await count(
        `SELECT count(*)::int AS n FROM notification_targets
          WHERE target_account_id=$1 AND dedupe_key=$2`,
        [account_id, `business-tax-id-required:${account_id}`],
      ),
    ).toBe(1);
    expect(
      await count(
        `SELECT count(*)::int AS n FROM business_tax_id_notices
          WHERE account_id=$1 AND notified_at > NOW() - interval '1 minute'`,
        [account_id],
      ),
    ).toBe(1);
  });
});
