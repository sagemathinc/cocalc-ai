/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { db } from "@cocalc/database";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import { callback_opts } from "@cocalc/util/async-utils";
import { uuid } from "@cocalc/util/misc";

import passwordHash from "@cocalc/backend/auth/password-hash";
import type { PostgreSQL } from "../types";

describe("password methods", () => {
  const database: PostgreSQL = db();

  const changePassword = callback_opts(
    database.change_password.bind(database),
  ) as (opts: {
    account_id: string;
    password_hash: string;
    invalidate_remember_me?: boolean;
  }) => Promise<void>;
  const resetPassword = callback_opts(
    database.reset_password.bind(database),
  ) as (opts: {
    email_address?: string;
    account_id?: string;
    password?: string;
    random?: boolean;
  }) => Promise<void>;
  const setPasswordReset = callback_opts(
    database.set_password_reset.bind(database),
  ) as (opts: { email_address: string; ttl: number }) => Promise<string>;
  const getPasswordReset = callback_opts(
    database.get_password_reset.bind(database),
  ) as (opts: { id: string }) => Promise<string | undefined>;
  const deletePasswordReset = callback_opts(
    database.delete_password_reset.bind(database),
  ) as (opts: { id: string }) => Promise<void>;
  const recordPasswordResetAttempt = callback_opts(
    database.record_password_reset_attempt.bind(database),
  ) as (opts: {
    email_address: string;
    ip_address: string;
    ttl: number;
  }) => Promise<void>;
  const countPasswordResetAttempts = callback_opts(
    database.count_password_reset_attempts.bind(database),
  ) as (opts: {
    email_address?: string;
    ip_address?: string;
    age_s: number;
  }) => Promise<number>;

  async function insertAccount(opts: {
    account_id: string;
    email_address: string;
    password_hash?: string;
  }): Promise<void> {
    const pool = getPool();
    await pool.query(
      "INSERT INTO accounts (account_id, created, email_address, password_hash) VALUES ($1, $2, $3, $4)",
      [
        opts.account_id,
        new Date(),
        opts.email_address,
        opts.password_hash ?? null,
      ],
    );
  }

  async function insertRememberMe(opts: {
    account_id: string;
    hash: string;
  }): Promise<void> {
    const pool = getPool();
    await pool.query(
      "INSERT INTO remember_me (hash, account_id, value, expire) VALUES ($1, $2, $3, $4)",
      [
        opts.hash,
        opts.account_id,
        JSON.stringify({}),
        new Date(Date.now() + 10000),
      ],
    );
  }

  beforeAll(async () => {
    await initEphemeralDatabase({});
  }, 15000);

  afterEach(async () => {
    const pool = getPool();
    await pool.query("DELETE FROM password_reset_attempts");
    await pool.query("DELETE FROM password_reset");
    await pool.query("DELETE FROM remember_me");
    await pool.query("DELETE FROM accounts");
  });

  afterAll(async () => {
    await testCleanup();
  });

  it("change_password updates password and invalidates remember_me by default", async () => {
    const account_id = uuid();
    await insertAccount({
      account_id,
      email_address: "user@example.com",
      password_hash: "old",
    });
    await insertRememberMe({
      account_id,
      hash: "hash-1",
    });

    await changePassword({
      account_id,
      password_hash: "new-hash",
    });

    const pool = getPool();
    const { rows } = await pool.query(
      "SELECT password_hash FROM accounts WHERE account_id = $1",
      [account_id],
    );
    expect(rows[0]?.password_hash).toBe("new-hash");

    const { rows: rememberRows } = await pool.query(
      "SELECT hash FROM remember_me WHERE account_id = $1",
      [account_id],
    );
    expect(rememberRows.length).toBe(0);
  });

  it("change_password preserves remember_me when invalidate_remember_me is false", async () => {
    const account_id = uuid();
    await insertAccount({
      account_id,
      email_address: "user@example.com",
      password_hash: "old",
    });
    await insertRememberMe({
      account_id,
      hash: "hash-2",
    });

    await changePassword({
      account_id,
      password_hash: "new-hash",
      invalidate_remember_me: false,
    });

    const pool = getPool();
    const { rows } = await pool.query(
      "SELECT hash FROM remember_me WHERE account_id = $1",
      [account_id],
    );
    expect(rows.length).toBe(1);
  });

  it("change_password rejects oversized hashes", async () => {
    const account_id = uuid();
    await insertAccount({
      account_id,
      email_address: "user@example.com",
    });

    await expect(
      changePassword({
        account_id,
        password_hash: "a".repeat(174),
      }),
    ).rejects.toBe("password_hash must be at most 173 characters");
  });

  describe("while the account is being rehomed", () => {
    // A rehome copies the account row and its sessions to the new bay: a
    // password or session change landing after the copy read them would be
    // lost there, or would bring a signed-out session back.
    async function ensureRehomeTable() {
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
    }

    async function signedIn(hash: string): Promise<string> {
      const account_id = uuid();
      await insertAccount({
        account_id,
        email_address: `${account_id}@example.com`,
        password_hash: "old",
      });
      await insertRememberMe({ account_id, hash });
      await getPool().query(
        `INSERT INTO account_auth_sessions
           (session_hash, account_id, created, updated, authenticated_at, expire)
         VALUES ($1, $2, NOW(), NOW(), NOW(), NOW() + INTERVAL '1 hour')`,
        [hash, account_id],
      );
      return account_id;
    }

    async function unchanged(account_id: string, hash: string) {
      const pool = getPool();
      const { rows } = await pool.query(
        "SELECT password_hash FROM accounts WHERE account_id = $1",
        [account_id],
      );
      expect(rows[0]?.password_hash).toBe("old");
      const cookie = await pool.query(
        "SELECT 1 FROM remember_me WHERE hash = $1",
        [hash],
      );
      expect(cookie.rows.length).toBe(1);
      const auth = await pool.query(
        "SELECT revoked_at FROM account_auth_sessions WHERE session_hash = $1",
        [hash],
      );
      expect(auth.rows[0]?.revoked_at).toBeNull();
    }

    // The callback API reports the error as a message string.
    const outcome = (p: Promise<void>) =>
      p.then(
        () => "changed",
        (err) => `${err}`,
      );

    afterEach(async () => {
      await getPool().query("DELETE FROM account_rehome_operations");
      await getPool().query("DELETE FROM account_auth_sessions");
    });

    it("changes neither the password nor any session", async () => {
      await ensureRehomeTable();
      const account_id = await signedIn("hash-rehome");
      await getPool().query(
        `INSERT INTO account_rehome_operations (account_id, source_bay_id, dest_bay_id)
         VALUES ($1, 'bay-0', 'bay-1')`,
        [account_id],
      );
      for (const invalidate_remember_me of [true, false]) {
        expect(
          await outcome(
            changePassword({
              account_id,
              password_hash: "new-hash",
              invalidate_remember_me,
            }),
          ),
        ).toMatch(/rehome/);
        await unchanged(account_id, "hash-rehome");
      }
    });

    it("a password change racing a rehome start waits for it, then changes nothing", async () => {
      await ensureRehomeTable();
      const account_id = await signedIn("hash-race");
      // A rehome starts by taking the account fence and recording the running
      // rehome in one transaction.
      const rehome = await getPool().connect();
      try {
        await rehome.query("BEGIN");
        await rehome.query(
          "SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))",
          ["account-rehome", account_id],
        );
        const changing = outcome(
          changePassword({ account_id, password_hash: "new-hash" }),
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        await rehome.query(
          `INSERT INTO account_rehome_operations (account_id, source_bay_id, dest_bay_id)
           VALUES ($1, 'bay-0', 'bay-1')`,
          [account_id],
        );
        await rehome.query("COMMIT");
        expect(await changing).toMatch(/rehome/);
      } finally {
        rehome.release();
      }
      await unchanged(account_id, "hash-race");
    });
  });

  it("set/get/delete password reset works and respects expiration", async () => {
    const resetId = await setPasswordReset({
      email_address: "user@example.com",
      ttl: 60,
    });

    const email = await getPasswordReset({ id: resetId });
    expect(email).toBe("user@example.com");

    await deletePasswordReset({ id: resetId });
    const deleted = await getPasswordReset({ id: resetId });
    expect(deleted).toBeUndefined();

    const expiredId = await setPasswordReset({
      email_address: "expired@example.com",
      ttl: -1,
    });
    const expired = await getPasswordReset({ id: expiredId });
    expect(expired).toBeUndefined();
  });

  it("record_password_reset_attempt and count_password_reset_attempts respect filters", async () => {
    await recordPasswordResetAttempt({
      email_address: "user@example.com",
      ip_address: "127.0.0.1",
      ttl: 60,
    });
    await recordPasswordResetAttempt({
      email_address: "user@example.com",
      ip_address: "127.0.0.2",
      ttl: 60,
    });

    const pool = getPool();
    const { rows: attemptRows } = await pool.query(
      "SELECT time FROM password_reset_attempts ORDER BY time",
    );
    expect(attemptRows.length).toBe(2);
    expect(attemptRows.every((row) => row.time != null)).toBe(true);

    const threshold = new Date(Date.now() - 60 * 1000);
    const { rows: rawEmailCountRows } = await pool.query(
      "SELECT COUNT(*)::INT AS count FROM password_reset_attempts WHERE time >= $1 AND email_address = $2",
      [threshold, "user@example.com"],
    );
    const expectedEmailCount = rawEmailCountRows[0]?.count ?? 0;

    const countByEmail = await countPasswordResetAttempts({
      email_address: "user@example.com",
      age_s: 60,
    });
    expect(countByEmail).toBe(expectedEmailCount);

    const { rows: rawIpCountRows } = await pool.query(
      "SELECT COUNT(*)::INT AS count FROM password_reset_attempts WHERE time >= $1 AND ip_address = $2",
      [threshold, "127.0.0.1"],
    );
    const expectedIpCount = rawIpCountRows[0]?.count ?? 0;

    const countByIp = await countPasswordResetAttempts({
      ip_address: "127.0.0.1",
      age_s: 60,
    });
    expect(countByIp).toBe(expectedIpCount);
  });

  it("reset_password updates password hash", async () => {
    const account_id = uuid();
    const email_address = "reset@example.com";
    await insertAccount({
      account_id,
      email_address,
      password_hash: "old-hash",
    });
    await insertRememberMe({
      account_id,
      hash: "hash-3",
    });

    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await resetPassword({
        email_address,
        password: "new-password",
        random: false,
      });
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }

    const pool = getPool();
    const { rows } = await pool.query(
      "SELECT password_hash FROM accounts WHERE account_id = $1",
      [account_id],
    );
    expect(rows[0]?.password_hash).toBe(passwordHash("new-password"));
  });
});
