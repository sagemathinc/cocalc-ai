/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { db } from "@cocalc/database";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import { callback_opts } from "@cocalc/util/async-utils";
import { uuid } from "@cocalc/util/misc";
import type { PostgreSQL } from "../types";

function makeHash(length: number): string {
  const base = uuid().replace(/-/g, "");
  return (base + "x".repeat(length)).slice(0, length);
}

describe("remember me methods", () => {
  const database: PostgreSQL = db();

  async function get_remember_me_wrapper(opts: {
    hash: string;
    cache?: boolean;
  }): Promise<{ event: "signed_in"; account_id: string } | undefined> {
    return callback_opts(database.get_remember_me.bind(database))(opts);
  }

  async function invalidate_all_remember_me_wrapper(opts: {
    account_id?: string;
    email_address?: string;
  }): Promise<void> {
    await callback_opts(database.invalidate_all_remember_me.bind(database))(
      opts,
    );
  }

  beforeAll(async () => {
    await initEphemeralDatabase({});
  }, 15000);

  afterAll(async () => {
    await testCleanup();
  });

  describe("get_remember_me", () => {
    it("returns signed_in message for a valid hash", async () => {
      const pool = getPool();
      const accountId = uuid();
      const hash = makeHash(64);
      const expire = new Date(Date.now() + 60 * 1000);

      await pool.query(
        "INSERT INTO remember_me (hash, value, account_id, expire) VALUES ($1, $2, $3, $4)",
        [hash, { test: true }, accountId, expire],
      );

      const result = await get_remember_me_wrapper({
        hash,
        cache: false,
      });

      expect(result).toEqual({ event: "signed_in", account_id: accountId });
    });

    it("returns undefined for an expired hash", async () => {
      const pool = getPool();
      const accountId = uuid();
      const hash = makeHash(64);
      const expire = new Date(Date.now() - 60 * 1000);

      await pool.query(
        "INSERT INTO remember_me (hash, value, account_id, expire) VALUES ($1, $2, $3, $4)",
        [hash, { test: "expired" }, accountId, expire],
      );

      const result = await get_remember_me_wrapper({ hash });
      expect(result).toBeUndefined();
    });
  });

  describe("invalidate_all_remember_me", () => {
    async function account(): Promise<string> {
      const account_id = uuid();
      await getPool().query(
        "INSERT INTO accounts (account_id, email_address) VALUES ($1, $2)",
        [account_id, `${account_id}@example.test`],
      );
      return account_id;
    }

    async function signIn(account_id: string): Promise<string> {
      const hash = makeHash(127);
      const expire = new Date(Date.now() + 60 * 1000);
      await getPool().query(
        "INSERT INTO remember_me (hash, value, account_id, expire) VALUES ($1, $2, $3, $4)",
        [hash, { test: 1 }, account_id, expire],
      );
      await getPool().query(
        `INSERT INTO account_auth_sessions
           (session_hash, account_id, created, updated, authenticated_at, expire)
         VALUES ($1, $2, NOW(), NOW(), NOW(), $3)`,
        [hash, account_id, expire],
      );
      return hash;
    }

    async function state(hash: string) {
      const cookie = await getPool().query(
        "SELECT 1 FROM remember_me WHERE hash = $1",
        [hash],
      );
      const auth = await getPool().query(
        "SELECT revoked_at FROM account_auth_sessions WHERE session_hash = $1",
        [hash],
      );
      return {
        cookie: cookie.rows.length > 0,
        revoked: auth.rows[0]?.revoked_at != null,
      };
    }

    it("signs the account out everywhere: deletes its cookies and revokes its auth sessions", async () => {
      const accountId = await account();
      const otherAccountId = await account();
      const a = await signIn(accountId);
      const b = await signIn(accountId);
      const other = await signIn(otherAccountId);

      await invalidate_all_remember_me_wrapper({ account_id: accountId });

      expect(await state(a)).toEqual({ cookie: false, revoked: true });
      expect(await state(b)).toEqual({ cookie: false, revoked: true });
      expect(await state(other)).toEqual({ cookie: true, revoked: false });
    });

    it("changes nothing while the account is being rehomed", async () => {
      // The rehome copies both rows to the new bay: a cookie deleted here
      // after the copy read it would work again there.
      const accountId = await account();
      const hash = await signIn(accountId);
      await getPool().query(`
        CREATE TABLE IF NOT EXISTS account_rehome_operations (
          op_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          account_id UUID NOT NULL,
          source_bay_id TEXT NOT NULL,
          dest_bay_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'running',
          stage TEXT NOT NULL DEFAULT 'requested',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      await getPool().query(
        `INSERT INTO account_rehome_operations (account_id, source_bay_id, dest_bay_id)
         VALUES ($1, 'bay-0', 'bay-1')`,
        [accountId],
      );
      // The callback API reports the error as a message string.
      const refused = await invalidate_all_remember_me_wrapper({
        account_id: accountId,
      }).then(
        () => "signed out",
        (err) => `${err}`,
      );
      expect(refused).toMatch(/rehome/);
      expect(await state(hash)).toEqual({ cookie: true, revoked: false });

      await getPool().query(
        "UPDATE account_rehome_operations SET status = 'succeeded' WHERE account_id = $1",
        [accountId],
      );
      await invalidate_all_remember_me_wrapper({ account_id: accountId });
      expect(await state(hash)).toEqual({ cookie: false, revoked: true });
    });
  });
});
