/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { before, after, getPool } from "@cocalc/server/test";
import { uuid } from "@cocalc/util/misc";
import { createTestAccount } from "./test-data";
import adminPurchase from "./admin-purchase";

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);

afterAll(after);

async function createAdminAccount(account_id: string) {
  await createTestAccount(account_id);
  await getPool().query(
    "UPDATE accounts SET groups=$2::TEXT[] WHERE account_id=$1",
    [account_id, ["admin"]],
  );
}

describe("admin balance adjustments", () => {
  it("does not allow a non-admin to change another account's balance", async () => {
    const admin_account_id = uuid();
    const user_account_id = uuid();
    await createTestAccount(admin_account_id);
    await createTestAccount(user_account_id);
    await expect(
      adminPurchase({
        admin_account_id,
        user_account_id,
        price: 25,
        product: "balance",
        source: "free",
      }),
    ).rejects.toThrow("must be an admin");
    const { rows } = await getPool().query(
      "SELECT id FROM purchases WHERE account_id=$1",
      [user_account_id],
    );
    expect(rows).toHaveLength(0);
  });

  it("does not adjust a non-local account's ledger", async () => {
    const admin_account_id = uuid();
    const user_account_id = uuid();
    await createAdminAccount(admin_account_id);
    await createTestAccount(user_account_id);
    await getPool().query(
      "UPDATE accounts SET home_bay_id=$2 WHERE account_id=$1",
      [user_account_id, `other-${uuid()}`],
    );
    await expect(
      adminPurchase({
        admin_account_id,
        user_account_id,
        price: 25,
        product: "balance",
        source: "free",
      }),
    ).rejects.toThrow(/homed on/);
    const { rows } = await getPool().query(
      "SELECT id FROM purchases WHERE account_id=$1",
      [user_account_id],
    );
    expect(rows).toHaveLength(0);
  });

  it("keeps internal notes out of user-visible purchase notes", async () => {
    const admin_account_id = uuid();
    const user_account_id = uuid();
    await createAdminAccount(admin_account_id);
    await createTestAccount(user_account_id);

    const result = await adminPurchase({
      admin_account_id,
      balance_admin_note: "support ticket 123",
      balance_user_note: "Goodwill credit",
      price: 25,
      product: "balance",
      source: "free",
      user_account_id,
    });

    const purchases = await getPool().query(
      "SELECT cost, description, notes FROM purchases WHERE id=$1",
      [result.purchase_id],
    );
    expect(purchases.rows).toHaveLength(1);
    expect(Number(purchases.rows[0].cost)).toBe(-25);
    expect(purchases.rows[0].description).toEqual({
      type: "credit",
      description: "Goodwill credit",
      purpose: "admin-balance-adjustment",
    });
    expect(purchases.rows[0].notes).toBeNull();

    const audit = await getPool().query(
      `SELECT account_id, actor_account_id, action, reason, metadata
         FROM account_admin_audit_log
        WHERE account_id=$1 AND action='balance-adjustment'`,
      [user_account_id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].account_id).toBe(user_account_id);
    expect(audit.rows[0].actor_account_id).toBe(admin_account_id);
    expect(audit.rows[0].reason).toBe("support ticket 123");
    expect(audit.rows[0].metadata).toEqual({
      adjustment_amount: 25,
      direction: "credit",
      purchase_id: result.purchase_id,
      user_visible_description: "Goodwill credit",
    });
  });
});
