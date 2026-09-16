/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

const describePglite =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

const BANNED = "11111111-1111-4111-8111-111111111111";
const ACTIVE = "22222222-2222-4222-8222-222222222222";
const EVENT = "33333333-3333-4333-8333-333333333333";

describePglite("account ban timestamps", () => {
  const originalEnv = {
    COCALC_DB: process.env.COCALC_DB,
    COCALC_PGLITE_DATA_DIR: process.env.COCALC_PGLITE_DATA_DIR,
  };

  beforeAll(async () => {
    process.env.COCALC_DB = "pglite";
    process.env.COCALC_PGLITE_DATA_DIR = "memory://";
    const getPool = (await import("@cocalc/database/pool")).default;
    await getPool().query(`
      CREATE TABLE accounts (
        account_id UUID PRIMARY KEY,
        banned BOOLEAN
      )
    `);
    await getPool().query(
      `INSERT INTO accounts (account_id, banned)
       VALUES ($1, TRUE), ($2, FALSE)`,
      [BANNED, ACTIVE],
    );
    await getPool().query(`
      CREATE TABLE account_ban_audit_log (
        id UUID PRIMARY KEY,
        account_id UUID NOT NULL,
        action VARCHAR(16) NOT NULL,
        actor_account_id UUID,
        reason TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created TIMESTAMPTZ
      )
    `);
  });

  afterAll(async () => {
    const { closePglite } = await import("@cocalc/database/pglite");
    await closePglite();
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("backfills current bans and maintains transition timestamps", async () => {
    const getPool = (await import("@cocalc/database/pool")).default;
    const { syncAccountBanTimestampSchema } =
      await import("@cocalc/database/postgres/schema/account-ban-timestamp");
    const { ensureAccountBanTimestampSchema } = await import("./ban-timestamp");
    await expect(ensureAccountBanTimestampSchema()).rejects.toThrow(
      "account ban timestamp schema is not installed",
    );
    const before = await getPool().query(
      `SELECT COUNT(*)::INT AS count
         FROM information_schema.columns
        WHERE table_name='accounts'
          AND column_name='banned_at'`,
    );
    expect(before.rows).toEqual([{ count: 0 }]);

    await getPool().query(
      "ALTER TABLE accounts ADD COLUMN banned_at TIMESTAMPTZ",
    );
    await syncAccountBanTimestampSchema(getPool());
    await ensureAccountBanTimestampSchema();

    const initial = await getPool().query(
      `SELECT account_id, banned_at IS NOT NULL AS has_banned_at
         FROM accounts
        ORDER BY account_id`,
    );
    expect(initial.rows).toEqual([
      { account_id: BANNED, has_banned_at: true },
      { account_id: ACTIVE, has_banned_at: false },
    ]);

    await getPool().query(
      "UPDATE accounts SET banned=FALSE WHERE account_id=$1",
      [BANNED],
    );
    await getPool().query(
      "UPDATE accounts SET banned=TRUE WHERE account_id=$1",
      [ACTIVE],
    );
    const transitioned = await getPool().query(
      `SELECT account_id, banned, banned_at IS NOT NULL AS has_banned_at
         FROM accounts
        ORDER BY account_id`,
    );
    expect(transitioned.rows).toEqual([
      { account_id: BANNED, banned: false, has_banned_at: false },
      { account_id: ACTIVE, banned: true, has_banned_at: true },
    ]);
  });

  it("repairs the ban audit created default", async () => {
    const getPool = (await import("@cocalc/database/pool")).default;
    const { ensureAccountBanAuditLogSchema } = await import("./ban-audit");
    await ensureAccountBanAuditLogSchema();
    await getPool().query(
      `INSERT INTO account_ban_audit_log (id, account_id, action)
       VALUES ($1, $2, 'ban')`,
      [EVENT, ACTIVE],
    );
    const inserted = await getPool().query(
      `SELECT created IS NOT NULL AS defaulted
         FROM account_ban_audit_log
        WHERE id=$1`,
      [EVENT],
    );
    expect(inserted.rows).toEqual([{ defaulted: true }]);
  });
});
