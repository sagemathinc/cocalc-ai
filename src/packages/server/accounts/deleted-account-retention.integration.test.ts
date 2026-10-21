/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

const describePglite =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

const RECENT = "11111111-1111-4111-8111-111111111111";
const OLD = "22222222-2222-4222-8222-222222222222";
const NO_REVOCATION = "33333333-3333-4333-8333-333333333333";
const ACTIVE = "44444444-4444-4444-8444-444444444444";
// deleted 5 days ago through a path that records deleted_at but no revocation
const RECENT_NO_REVOCATION = "55555555-5555-4555-8555-555555555555";

describePglite("deleted account retention", () => {
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
        deleted BOOLEAN,
        deleted_at TIMESTAMP,
        email_address VARCHAR(254),
        email_address_before_delete VARCHAR(254),
        display_name VARCHAR(254),
        first_name VARCHAR(254),
        last_name VARCHAR(254),
        password_hash VARCHAR(173),
        profile JSONB,
        ssh_keys JSONB,
        lti_id TEXT[],
        lti_data JSONB,
        created_by VARCHAR(254),
        sign_up_usage_intent TEXT,
        email_address_verified JSONB,
        email_address_challenge JSONB,
        email_address_problem JSONB
      )
    `);
    const deleted = [RECENT, OLD, NO_REVOCATION, RECENT_NO_REVOCATION];
    for (const account_id of deleted) {
      await getPool().query(
        `INSERT INTO accounts (account_id, deleted, email_address_before_delete,
           display_name, first_name, last_name, password_hash, profile, ssh_keys,
           lti_id, created_by, email_address_verified)
         VALUES ($1, TRUE, $2, 'Ada L', 'Ada', 'Lovelace', 'hash',
           '{"color":"red"}', '{"fp":{"value":"ssh-ed25519 AAAA ada@example.com"}}',
           ARRAY['iss','sub'], '203.0.113.7', $3::JSONB)`,
        [
          account_id,
          `${account_id}@example.com`,
          JSON.stringify({ [`${account_id}@example.com`]: "2026-01-01" }),
        ],
      );
    }
    await getPool().query(
      `UPDATE accounts SET deleted_at = NOW() - interval '5 days'
        WHERE account_id = $1`,
      [RECENT_NO_REVOCATION],
    );
    await getPool().query(
      `INSERT INTO accounts (account_id, deleted, email_address, first_name)
       VALUES ($1, FALSE, 'active@example.com', 'Active')`,
      [ACTIVE],
    );
    const { ensureAccountRevocationsTable } = await import("./revocation");
    await ensureAccountRevocationsTable();
    await getPool().query(
      `INSERT INTO account_revocations (account_id, revoked_before)
       VALUES ($1, NOW() - interval '10 days'), ($2, NOW() - interval '120 days')`,
      [RECENT, OLD],
    );
  });

  afterAll(async () => {
    const { closePglite } = await import("@cocalc/database/pglite");
    await closePglite();
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("clears personal data of deleted accounts and purges old former emails", async () => {
    const getPool = (await import("@cocalc/database/pool")).default;
    const { purgeDeletedAccountPersonalData } =
      await import("./deleted-account-retention");

    expect(await purgeDeletedAccountPersonalData()).toEqual({
      cleared: 4,
      emailsPurged: 2,
    });

    const { rows } = await getPool().query(
      `SELECT * FROM accounts ORDER BY account_id`,
    );
    const byId = Object.fromEntries(rows.map((row) => [row.account_id, row]));
    for (const account_id of [
      RECENT,
      OLD,
      NO_REVOCATION,
      RECENT_NO_REVOCATION,
    ]) {
      const row = byId[account_id];
      for (const field of [
        "display_name",
        "first_name",
        "last_name",
        "password_hash",
        "profile",
        "ssh_keys",
        "lti_id",
        "created_by",
        "email_address_verified",
      ]) {
        expect(row[field]).toBeNull();
      }
    }
    // deleted 10 days ago: the former email is kept until the retention ends
    expect(byId[RECENT].email_address_before_delete).toBe(
      `${RECENT}@example.com`,
    );
    expect(byId[OLD].email_address_before_delete).toBeNull();
    // deleted before deletions recorded a deletion or revocation time
    expect(byId[NO_REVOCATION].email_address_before_delete).toBeNull();
    // deleted_at is the deletion time when there is no revocation
    expect(byId[RECENT_NO_REVOCATION].email_address_before_delete).toBe(
      `${RECENT_NO_REVOCATION}@example.com`,
    );
    // accounts that are not deleted are untouched
    expect(byId[ACTIVE].email_address).toBe("active@example.com");
    expect(byId[ACTIVE].first_name).toBe("Active");

    // a second pass has nothing left to do
    expect(await purgeDeletedAccountPersonalData()).toEqual({
      cleared: 0,
      emailsPurged: 0,
    });
  });
});
