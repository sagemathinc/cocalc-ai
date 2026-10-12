/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Retiring the computers public-share trigger touches exactly the objects
// an earlier development build installed in schema "public", and nothing
// that merely has the same name elsewhere (e.g. in the "$user" schema, which
// comes first in the default search_path). Real PostgreSQL; skipped without
// server binaries.

import {
  postgresBinDir,
  startRealPostgres,
  type RealPostgres,
} from "@cocalc/server/test/real-postgres";

jest.setTimeout(60_000);

const describeReal = postgresBinDir() != null ? describe : describe.skip;

const FN = "public_project_paths_bump_computers_privacy";
const TRIGGER = `${FN}_trigger`;

describeReal("retiring the computers public-share trigger", () => {
  let pg: RealPostgres;
  let pool: any;

  beforeAll(async () => {
    pg = startRealPostgres();
    pool = (await import("@cocalc/database/pool")).default();
  });

  afterAll(async () => {
    await pool?.end?.().catch(() => {});
    pg?.stop();
  });

  beforeEach(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS cocalc CASCADE`);
    await pool.query(
      `DROP TABLE IF EXISTS public.public_project_paths CASCADE`,
    );
    await pool.query(`DROP TABLE IF EXISTS public.computers_local_bay`);
    await pool.query(`DROP FUNCTION IF EXISTS public.${FN}()`);
    await pool.query(
      `CREATE TABLE public.public_project_paths (id UUID PRIMARY KEY, project_id UUID)`,
    );
  });

  const lib = () =>
    import("@cocalc/database/postgres/schema/project-computers-privacy");

  /** The objects, in a schema ("public" or the shadow "cocalc"). */
  async function install(
    schema: string,
    what: { fn?: boolean; trigger?: boolean; table?: boolean },
  ) {
    if (schema !== "public") {
      await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      await pool.query(
        `CREATE TABLE IF NOT EXISTS ${schema}.public_project_paths (id UUID PRIMARY KEY, project_id UUID)`,
      );
    }
    if (what.fn || what.trigger) {
      await pool.query(`CREATE OR REPLACE FUNCTION ${schema}.${FN}()
        RETURNS TRIGGER AS $$ BEGIN RETURN NULL; END; $$ LANGUAGE plpgsql`);
    }
    if (what.trigger) {
      await pool.query(`CREATE TRIGGER ${TRIGGER}
        AFTER INSERT ON ${schema}.public_project_paths
        FOR EACH ROW EXECUTE FUNCTION ${schema}.${FN}()`);
    }
    if (what.table) {
      await pool.query(
        `CREATE TABLE ${schema}.computers_local_bay (singleton BOOLEAN PRIMARY KEY, bay_id TEXT)`,
      );
    }
  }

  async function present(schema: string) {
    const { rows } = await pool.query(
      `SELECT
         EXISTS (SELECT 1 FROM pg_trigger WHERE tgname=$1
                   AND tgrelid = to_regclass($2)) AS trigger,
         to_regprocedure($3) IS NOT NULL AS fn,
         to_regclass($4) IS NOT NULL AS "table"`,
      [
        TRIGGER,
        `${schema}.public_project_paths`,
        `${schema}.${FN}()`,
        `${schema}.computers_local_bay`,
      ],
    );
    return rows[0];
  }

  it("the $user schema really shadows public here (so the test means something)", async () => {
    const { rows } = await pool.query("SELECT current_user AS u");
    expect(rows[0].u).toBe("cocalc");
    await install("cocalc", { table: true });
    await install("public", { table: true });
    // An unqualified name resolves to the shadow, not to public's table.
    const r = await pool.query(
      `SELECT n.nspname AS schema FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.oid = to_regclass('computers_local_bay')`,
    );
    expect(r.rows[0].schema).toBe("cocalc");
  });

  it("drops exactly the public objects and leaves same-named shadows alone", async () => {
    const {
      retireProjectComputersPrivacySchema,
      projectComputersPrivacySchemaNeedsSync,
    } = await lib();
    await install("public", { fn: true, trigger: true, table: true });
    await install("cocalc", { fn: true, trigger: true, table: true });
    const client = await pool.connect();
    try {
      expect(await projectComputersPrivacySchemaNeedsSync(client)).toBe(true);
      await retireProjectComputersPrivacySchema(client);
      expect(await projectComputersPrivacySchemaNeedsSync(client)).toBe(false);
    } finally {
      client.release();
    }
    expect(await present("public")).toEqual({
      trigger: false,
      fn: false,
      table: false,
    });
    expect(await present("cocalc")).toEqual({
      trigger: true,
      fn: true,
      table: true,
    });
  });

  it.each([
    ["the function only", { fn: true }],
    ["the table only", { table: true }],
    ["the trigger and its function", { fn: true, trigger: true }],
  ])("retires a partial remnant: %s", async (_label, what) => {
    const {
      retireProjectComputersPrivacySchema,
      projectComputersPrivacySchemaNeedsSync,
    } = await lib();
    await install("public", what);
    const client = await pool.connect();
    try {
      expect(await projectComputersPrivacySchemaNeedsSync(client)).toBe(true);
      await retireProjectComputersPrivacySchema(client);
      expect(await projectComputersPrivacySchemaNeedsSync(client)).toBe(false);
    } finally {
      client.release();
    }
    expect(await present("public")).toEqual({
      trigger: false,
      fn: false,
      table: false,
    });
  });

  it("same-named objects only outside public: nothing to do, nothing touched", async () => {
    const {
      retireProjectComputersPrivacySchema,
      projectComputersPrivacySchemaNeedsSync,
    } = await lib();
    await install("cocalc", { fn: true, trigger: true, table: true });
    const client = await pool.connect();
    try {
      expect(await projectComputersPrivacySchemaNeedsSync(client)).toBe(false);
      await retireProjectComputersPrivacySchema(client);
    } finally {
      client.release();
    }
    expect(await present("cocalc")).toEqual({
      trigger: true,
      fn: true,
      table: true,
    });
  });
});
