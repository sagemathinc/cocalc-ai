/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { before, after, getPool } from "@cocalc/server/test";
import { uuid } from "@cocalc/util/misc";
import { createTestAccount } from "./test-data";
import adminPurchase from "./admin-purchase";
import createCredit from "./create-credit";
import {
  attachAdminCreditAttribution,
  getAdminCreditAttribution,
  listAdminCreditAttribution,
} from "./admin-credit-attribution";

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

// A balance adjustment as written before July 27, 2026, or with no record of
// its creator at all.
async function legacyCredit(account_id: string, notes?: string) {
  return await createCredit({
    account_id,
    amount: 24,
    notes,
    tag: "admin-purchase",
    description: {
      description: "Admin balance adjustment",
      purpose: "admin-balance-adjustment",
    },
  });
}

describe("admin credit attribution", () => {
  const admin = uuid();
  const otherAdmin = uuid();
  const user = uuid();

  beforeAll(async () => {
    await createAdminAccount(admin);
    await createAdminAccount(otherAdmin);
    await createTestAccount(user);
  });

  it("reports the creator and reason from the audit log, from old notes, or as missing", async () => {
    const audited = await adminPurchase({
      admin_account_id: admin,
      balance_admin_note: "support ticket 123",
      balance_user_note: "Goodwill credit",
      price: 25,
      product: "balance",
      source: "free",
      user_account_id: user,
    });
    const noted = await legacyCredit(
      user,
      `Admin-assisted purchase created by account \`${otherAdmin}\`.\n\nPricing note: Balance adjustment: $24`,
    );
    const missing = await legacyCredit(user);

    const rows = await listAdminCreditAttribution({ admin_account_id: admin });
    const byId = new Map(rows.map((row) => [row.purchase_id, row]));
    expect(byId.get(audited.purchase_id)).toMatchObject({
      account_id: user,
      amount: 25,
      description: "Goodwill credit",
      created_by: admin,
      reason: "support ticket 123",
      source: "audit-log",
    });
    expect(byId.get(noted)).toMatchObject({
      created_by: otherAdmin,
      reason: "Pricing note: Balance adjustment: $24",
      source: "notes",
    });
    expect(byId.get(missing)).toMatchObject({
      created_by: null,
      source: "missing",
    });

    const onlyMissing = await listAdminCreditAttribution({
      admin_account_id: admin,
      missing_only: true,
    });
    expect(onlyMissing.map((row) => row.purchase_id)).toEqual([missing]);
  });

  it("is admin only", async () => {
    await expect(
      listAdminCreditAttribution({ admin_account_id: user }),
    ).rejects.toThrow("must be an admin");
    await expect(
      attachAdminCreditAttribution({
        admin_account_id: user,
        purchase_id: 1,
        attributed_admin_account_id: admin,
        reason: "x",
        commit: true,
      }),
    ).rejects.toThrow("must be an admin");
  });

  it("previews, then records an attribution as an audit entry without touching the purchase", async () => {
    const purchase_id = await legacyCredit(user);
    const preview = await attachAdminCreditAttribution({
      admin_account_id: admin,
      purchase_id,
      attributed_admin_account_id: otherAdmin,
      reason: "Blaec confirmed in Slack",
    });
    expect(preview.committed).toBe(false);
    expect((await getAdminCreditAttribution(purchase_id))?.source).toBe(
      "missing",
    );

    const result = await attachAdminCreditAttribution({
      admin_account_id: admin,
      purchase_id,
      attributed_admin_account_id: otherAdmin,
      reason: "Blaec confirmed in Slack",
      commit: true,
    });
    expect(result.committed).toBe(true);
    expect(result.after).toMatchObject({
      created_by: otherAdmin,
      reason: "Blaec confirmed in Slack",
      source: "attached",
      attached_by: admin,
    });
    const { rows } = await getPool().query(
      "SELECT notes, cost FROM purchases WHERE id=$1",
      [purchase_id],
    );
    expect(rows[0].notes).toBeNull();
    expect(Number(rows[0].cost)).toBe(-24);
  });

  it("refuses to attribute a credit that already has a creator, or that is not an admin adjustment", async () => {
    const audited = await adminPurchase({
      admin_account_id: admin,
      balance_admin_note: "ticket 456",
      price: 5,
      product: "balance",
      source: "free",
      user_account_id: user,
    });
    await expect(
      attachAdminCreditAttribution({
        admin_account_id: admin,
        purchase_id: audited.purchase_id,
        attributed_admin_account_id: otherAdmin,
        reason: "wrong",
        commit: true,
      }),
    ).rejects.toThrow("already attributed");

    const ordinary = await createCredit({ account_id: user, amount: 3 });
    await expect(
      attachAdminCreditAttribution({
        admin_account_id: admin,
        purchase_id: ordinary,
        attributed_admin_account_id: otherAdmin,
        reason: "x",
        commit: true,
      }),
    ).rejects.toThrow("is not an admin balance adjustment");
  });

  it("records exactly one of two concurrent attributions of the same credit", async () => {
    const purchase_id = await legacyCredit(user);
    const results = await Promise.allSettled([
      attachAdminCreditAttribution({
        admin_account_id: admin,
        purchase_id,
        attributed_admin_account_id: otherAdmin,
        reason: "first",
        commit: true,
      }),
      attachAdminCreditAttribution({
        admin_account_id: otherAdmin,
        purchase_id,
        attributed_admin_account_id: admin,
        reason: "second",
        commit: true,
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as
      | PromiseRejectedResult
      | undefined;
    expect(`${rejected?.reason}`).toContain("already attributed");
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM account_admin_audit_log
        WHERE action='balance-adjustment-attribution'
          AND metadata->>'purchase_id' = $1`,
      [`${purchase_id}`],
    );
    expect(rows[0].n).toBe(1);
  });

  it("finds a missing attribution below newer attributed credits, within the limit", async () => {
    const missing = await legacyCredit(user);
    for (let i = 0; i < 3; i++) {
      await adminPurchase({
        admin_account_id: admin,
        balance_admin_note: `newer ${i}`,
        price: 1,
        product: "balance",
        source: "free",
        user_account_id: user,
      });
    }
    const rows = await listAdminCreditAttribution({
      admin_account_id: admin,
      missing_only: true,
      limit: 1,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ purchase_id: missing, source: "missing" });
  });

  it("requires a reason and an existing account", async () => {
    const purchase_id = await legacyCredit(user);
    await expect(
      attachAdminCreditAttribution({
        admin_account_id: admin,
        purchase_id,
        attributed_admin_account_id: otherAdmin,
        reason: "  ",
      }),
    ).rejects.toThrow("a reason is required");
    await expect(
      attachAdminCreditAttribution({
        admin_account_id: admin,
        purchase_id,
        attributed_admin_account_id: uuid(),
        reason: "x",
      }),
    ).rejects.toThrow("does not exist");
  });
});
