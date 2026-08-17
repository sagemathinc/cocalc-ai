/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { db } from "@cocalc/database";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import { uuid } from "@cocalc/util/misc";

import { set_account_profile_image_if_not_set } from "./queries";
import type { PostgreSQL } from "../types";

describe("account query helpers", () => {
  const database: PostgreSQL = db();
  let pool: ReturnType<typeof getPool>;

  beforeAll(async () => {
    pool = getPool();
    await initEphemeralDatabase();
  });

  afterAll(async () => {
    await testCleanup(database);
  });

  async function createAccount(profile: Record<string, unknown> | null) {
    const accountId = uuid();
    await pool.query(
      `INSERT INTO accounts
         (account_id, email_address, display_name, profile, created)
       VALUES ($1, $2, 'Ada Lovelace', $3, NOW())`,
      [accountId, `${accountId}@example.com`, profile],
    );
    return accountId;
  }

  async function getProfile(accountId: string) {
    const { rows } = await pool.query(
      "SELECT profile FROM accounts WHERE account_id=$1",
      [accountId],
    );
    return rows[0]?.profile;
  }

  it("sets an SSO avatar without replacing profile data", async () => {
    const accountId = await createAccount({ color: "blue" });

    await set_account_profile_image_if_not_set({
      db: pool,
      account_id: accountId,
      image: "https://images.example.com/ada.jpg",
    });

    expect(await getProfile(accountId)).toEqual({
      color: "blue",
      image: "https://images.example.com/ada.jpg",
    });
  });

  it("preserves an existing or explicitly cleared avatar", async () => {
    const existingAccountId = await createAccount({
      image: "https://images.example.com/custom.jpg",
    });
    const clearedAccountId = await createAccount({ image: "" });

    for (const accountId of [existingAccountId, clearedAccountId]) {
      await set_account_profile_image_if_not_set({
        db: pool,
        account_id: accountId,
        image: "https://images.example.com/sso.jpg",
      });
    }

    expect(await getProfile(existingAccountId)).toEqual({
      image: "https://images.example.com/custom.jpg",
    });
    expect(await getProfile(clearedAccountId)).toEqual({ image: "" });
  });
});
