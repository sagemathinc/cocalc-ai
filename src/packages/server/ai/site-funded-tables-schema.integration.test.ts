/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The site-funded AI tables moved from runtime CREATE TABLE code into
util/db-schema (site-ai-funding.ts). Existing databases have the tables that
code made, so the schema must describe them exactly: a fresh database built
from the schema matches the old DDL, and startup sync on the old tables
changes nothing structural (only index marker comments).
*/

import getPool from "@cocalc/database/pool";
import { schemaNeedsSync, syncSchema } from "@cocalc/database/postgres/schema";
import { SCHEMA } from "@cocalc/util/schema";
import { after, before } from "@cocalc/server/test";

const TABLES = [
  "site_ai_admission_attempts",
  "site_ai_provider_keys",
  "site_ai_turn_reservations",
  "site_ai_speech_reservations",
  "site_ai_account_holds",
  "site_ai_funding_periods",
];

// Verbatim from the server code that created these tables before
// (site-funded-codex-reservations.ts, -provider-keys.ts, -admissions.ts).
const LEGACY_DDL = [
  `CREATE TABLE IF NOT EXISTS site_ai_funding_periods (
      pool_id TEXT NOT NULL,
      period_start TIMESTAMPTZ NOT NULL,
      period_end TIMESTAMPTZ NOT NULL,
      limit_microusd BIGINT NOT NULL CHECK (limit_microusd >= 0),
      reserved_microusd BIGINT NOT NULL DEFAULT 0 CHECK (reserved_microusd >= 0),
      committed_microusd BIGINT NOT NULL DEFAULT 0 CHECK (committed_microusd >= 0),
      policy_version INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (pool_id, period_start)
    )`,
  `CREATE TABLE IF NOT EXISTS site_ai_turn_reservations (
      reservation_id UUID PRIMARY KEY,
      funded_turn_id UUID NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL UNIQUE,
      pool_id TEXT NOT NULL,
      period_start TIMESTAMPTZ NOT NULL,
      account_id UUID NOT NULL,
      project_id UUID NOT NULL,
      host_id UUID NOT NULL,
      home_bay_id TEXT,
      owning_bay_id TEXT,
      membership_tier TEXT NOT NULL,
      policy_version INTEGER NOT NULL,
      model TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      service_tier TEXT NOT NULL,
      policy JSONB NOT NULL,
      surface TEXT,
      reserved_microusd BIGINT NOT NULL CHECK (reserved_microusd >= 0),
      pool_reserved_microusd BIGINT NOT NULL CHECK (pool_reserved_microusd >= 0),
      committed_microusd BIGINT NOT NULL DEFAULT 0 CHECK (committed_microusd >= 0),
      last_request_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_request_sequence >= 0),
      last_event_id UUID,
      last_event_cost_microusd BIGINT NOT NULL DEFAULT 0 CHECK (last_event_cost_microusd >= 0),
      last_event_price_version TEXT,
      last_event_long_context BOOLEAN,
      status TEXT NOT NULL CHECK (status IN ('active','committed','released','expired','interrupted','failed')),
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ,
      outcome TEXT,
      FOREIGN KEY (pool_id, period_start)
        REFERENCES site_ai_funding_periods(pool_id, period_start)
    )`,
  `CREATE INDEX IF NOT EXISTS site_ai_turn_reservations_account_started_idx
      ON site_ai_turn_reservations(account_id, started_at DESC)`,
  `ALTER TABLE site_ai_turn_reservations
      ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'openai'`,
  `ALTER TABLE site_ai_turn_reservations
      ADD COLUMN IF NOT EXISTS provider_key_id UUID`,
  `CREATE INDEX IF NOT EXISTS site_ai_turn_reservations_provider_key_idx
      ON site_ai_turn_reservations(provider_key_id, started_at)
      WHERE provider_key_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS site_ai_turn_reservations_active_idx
      ON site_ai_turn_reservations(status, expires_at)
      WHERE status = 'active'`,
  `CREATE TABLE IF NOT EXISTS site_ai_speech_reservations (
      request_id UUID PRIMARY KEY,
      account_id UUID NOT NULL,
      period_start TIMESTAMPTZ NOT NULL,
      reserved_microusd BIGINT NOT NULL CHECK (reserved_microusd > 0),
      committed_microusd BIGINT NOT NULL DEFAULT 0
        CHECK (committed_microusd >= 0),
      status TEXT NOT NULL
        CHECK (status IN ('active', 'committed', 'released', 'expired')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ
    )`,
  `CREATE INDEX IF NOT EXISTS site_ai_speech_reservations_active_idx
      ON site_ai_speech_reservations(status, expires_at)
      WHERE status = 'active'`,
  `CREATE TABLE IF NOT EXISTS site_ai_account_holds (
      account_id UUID PRIMARY KEY,
      reason TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by UUID,
      expires_at TIMESTAMPTZ
    )`,
  `CREATE TABLE IF NOT EXISTS site_ai_provider_keys (
      key_id UUID PRIMARY KEY,
      provider TEXT NOT NULL,
      label TEXT NOT NULL,
      encrypted_key TEXT NOT NULL,
      key_last4 TEXT NOT NULL,
      monthly_limit_microusd BIGINT NOT NULL
        CHECK (monthly_limit_microusd >= 0),
      reset_day INTEGER NOT NULL CHECK (reset_day BETWEEN 1 AND 28),
      reset_hour INTEGER NOT NULL CHECK (reset_hour BETWEEN 0 AND 23),
      position INTEGER NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  `CREATE TABLE IF NOT EXISTS site_ai_admission_attempts (
      funded_turn_id UUID PRIMARY KEY,
      account_id UUID NOT NULL,
      provider TEXT NOT NULL,
      outcome TEXT NOT NULL,
      membership_tier TEXT,
      surface TEXT,
      attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  `CREATE INDEX IF NOT EXISTS site_ai_admission_attempts_attempted_idx
      ON site_ai_admission_attempts(attempted_at)`,
];

const siteAiSchema = Object.fromEntries(
  TABLES.map((table) => [table, SCHEMA[table]]),
);

// Everything structural about the tables: columns (type, nullability,
// default), constraints (name, kind, definition) and indexes (name,
// definition). Not comments, which sync uses to mark the indexes it manages.
async function structure() {
  const pool = getPool();
  const result: Record<string, unknown> = {};
  for (const table of [...TABLES].sort()) {
    const columns = (
      await pool.query(
        `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns WHERE table_name=$1
          ORDER BY column_name`,
        [table],
      )
    ).rows;
    const constraints = (
      await pool.query(
        `SELECT conname, contype, pg_get_constraintdef(oid) AS def
           FROM pg_constraint WHERE conrelid=to_regclass($1)
          ORDER BY conname`,
        [table],
      )
    ).rows;
    const indexes = (
      await pool.query(
        `SELECT indexname, indexdef FROM pg_indexes WHERE tablename=$1
          ORDER BY indexname`,
        [table],
      )
    ).rows;
    result[table] = { columns, constraints, indexes };
  }
  return result;
}

async function dropTables() {
  for (const table of TABLES) {
    await getPool().query(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }
}

beforeAll(async () => await before({ noConat: true }), 60_000);
afterAll(after);

describe("site-funded AI tables in db-schema", () => {
  let legacy: Record<string, unknown>;

  it("the old runtime DDL builds the reference structure", async () => {
    await dropTables();
    for (const statement of LEGACY_DDL) await getPool().query(statement);
    legacy = await structure();
    expect(Object.keys(legacy)).toHaveLength(TABLES.length);
  });

  it("startup sync on the old tables changes nothing structural", async () => {
    await syncSchema(siteAiSchema);
    expect(await structure()).toEqual(legacy);
    expect(await schemaNeedsSync(siteAiSchema)).toBe(false);
  });

  it("sync leaves the schema's composite primary key order alone", () => {
    // It used to sort the schema's own (cached) array in place, so a table
    // created later in the process got its key columns in another order.
    expect(SCHEMA["site_ai_funding_periods"].primary_key).toEqual([
      "pool_id",
      "period_start",
    ]);
  });

  it("an older database gets only the checks its added columns lacked", async () => {
    // Databases made before pool_reserved_microusd, last_request_sequence
    // and last_event_cost_microusd existed got them from ALTER TABLE ...
    // ADD COLUMN, without their CHECK constraints.
    await dropTables();
    for (const statement of LEGACY_DDL) await getPool().query(statement);
    for (const check of [
      "pool_reserved_microusd_check",
      "last_request_sequence_check",
      "last_event_cost_microusd_check",
    ]) {
      await getPool().query(
        `ALTER TABLE site_ai_turn_reservations DROP CONSTRAINT site_ai_turn_reservations_${check}`,
      );
    }
    expect(await schemaNeedsSync(siteAiSchema)).toBe(true);
    await syncSchema(siteAiSchema);
    expect(await structure()).toEqual(legacy);
  });

  it("a table from before the later columns gets them, filled in as before", async () => {
    // The first version had none of the columns later added by ALTER TABLE.
    // The old code added them with defaults and gave running turns their
    // whole reservation as pool_reserved_microusd.
    await dropTables();
    const original = LEGACY_DDL.slice(0, 2).map((ddl) =>
      ddl
        .split("\n")
        .filter(
          (line) =>
            !/^\s*(pool_reserved_microusd|last_request_sequence|last_event_id|last_event_cost_microusd|last_event_price_version|last_event_long_context) /.test(
              line,
            ),
        )
        .join("\n"),
    );
    for (const statement of original) await getPool().query(statement);
    const pool = getPool();
    await pool.query(
      `INSERT INTO site_ai_funding_periods
         (pool_id, period_start, period_end, limit_microusd, policy_version)
       VALUES ('p', '2026-10-01', '2026-11-01', 1000000, 1)`,
    );
    const row = (id: string, status: string) =>
      pool.query(
        `INSERT INTO site_ai_turn_reservations
           (reservation_id, funded_turn_id, idempotency_key, pool_id,
            period_start, account_id, project_id, host_id, membership_tier,
            policy_version, model, reasoning, service_tier, policy,
            reserved_microusd, status, expires_at)
         VALUES ($1::uuid, gen_random_uuid(), $1::text, 'p', '2026-10-01',
           gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'free',
           1, 'm', 'r', 's', '{}', 500, $2::text, now())`,
        [id, status],
      );
    await row("00000000-0000-4000-8000-000000000001", "active");
    await row("00000000-0000-4000-8000-000000000002", "committed");
    await syncSchema(siteAiSchema);
    const { rows } = await pool.query(
      `SELECT status, pool_reserved_microusd, last_request_sequence,
              last_event_cost_microusd, provider
         FROM site_ai_turn_reservations ORDER BY reservation_id`,
    );
    expect(rows).toEqual([
      {
        status: "active",
        pool_reserved_microusd: "500",
        last_request_sequence: 0,
        last_event_cost_microusd: "0",
        provider: "openai",
      },
      {
        status: "committed",
        pool_reserved_microusd: "0",
        last_request_sequence: 0,
        last_event_cost_microusd: "0",
        provider: "openai",
      },
    ]);
    expect(await schemaNeedsSync(siteAiSchema)).toBe(false);
  });

  it("a fresh database built from the schema is the same", async () => {
    await dropTables();
    await syncSchema(siteAiSchema);
    expect(await structure()).toEqual(legacy);
    expect(await schemaNeedsSync(siteAiSchema)).toBe(false);
  });
});
