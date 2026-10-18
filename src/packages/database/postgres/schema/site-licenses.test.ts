/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import { uuid } from "@cocalc/util/misc";
import {
  ensureSiteLicenseSchemaData,
  siteLicenseSchemaDataNeedsSync,
} from "./site-licenses";
import { schemaNeedsSync } from "./sync";
import { SCHEMA } from "@cocalc/util/schema";

beforeAll(async () => {
  await initEphemeralDatabase({});
}, 15_000);

afterAll(async () => {
  await testCleanup();
});

describe("site-license schema data fixes at startup", () => {
  it("creates the tables and the domain lock row through schema sync", async () => {
    const pool = getPool();
    const { rows } = await pool.query(
      "SELECT to_regclass('public.site_license_domains') IS NOT NULL AS domains, to_regclass('public.site_license_domain_locks') IS NOT NULL AS locks",
    );
    expect(rows[0]).toEqual({ domains: true, locks: true });
    expect(
      (
        await pool.query(
          "SELECT is_nullable FROM information_schema.columns WHERE table_name='site_licenses' AND column_name='bay_id'",
        )
      ).rows,
    ).toEqual([{ is_nullable: "NO" }]);
    expect(
      (
        await pool.query(
          "SELECT name FROM site_license_domain_locks WHERE id=1",
        )
      ).rows,
    ).toEqual([{ name: "site-license-domain-write-lock" }]);
    expect(await siteLicenseSchemaDataNeedsSync(pool)).toBe(false);
  });

  it("leaves nothing for the next startup sync to change", async () => {
    // e.g., a declared default that PostgreSQL deparses differently would
    // make every startup see a dirty schema.
    const siteLicenseTables = Object.fromEntries(
      Object.entries(SCHEMA).filter(([name]) =>
        name.startsWith("site_license"),
      ),
    );
    expect(Object.keys(siteLicenseTables)).toHaveLength(9);
    expect(await schemaNeedsSync(siteLicenseTables)).toBe(false);
  });

  it("moves legacy owner manager rows to owner_account_id, idempotently", async () => {
    const pool = getPool();
    const license = uuid();
    const owner = uuid();
    await pool.query(
      `INSERT INTO site_licenses (id,name,organization_name,bay_id,created,updated)
       VALUES ($1,'Legacy Campus','Legacy University','bay-0',NOW(),NOW())`,
      [license],
    );
    await pool.query(
      `INSERT INTO site_license_managers (id,site_license_id,account_id,role,created,updated)
       VALUES ($1,$2,$3,'owner',NOW(),NOW())`,
      [uuid(), license, owner],
    );
    await pool.query("DELETE FROM site_license_domain_locks WHERE id=1");
    expect(await siteLicenseSchemaDataNeedsSync(pool)).toBe(true);

    await ensureSiteLicenseSchemaData(pool);
    await ensureSiteLicenseSchemaData(pool);

    expect(await siteLicenseSchemaDataNeedsSync(pool)).toBe(false);
    expect(
      (
        await pool.query(
          "SELECT owner_account_id FROM site_licenses WHERE id=$1",
          [license],
        )
      ).rows[0].owner_account_id,
    ).toBe(owner);
    expect(
      (
        await pool.query(
          "SELECT role FROM site_license_managers WHERE site_license_id=$1",
          [license],
        )
      ).rows,
    ).toEqual([{ role: "viewer" }]);
    expect(
      (await pool.query("SELECT id FROM site_license_domain_locks")).rows,
    ).toEqual([{ id: 1 }]);
  });
});
