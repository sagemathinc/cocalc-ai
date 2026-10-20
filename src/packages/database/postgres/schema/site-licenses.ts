/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Data fixes for the site-license tables declared in
// @cocalc/util/db-schema/site-licenses. They used to run inside every
// site-license request transaction (with DDL that took an ACCESS EXCLUSIVE
// lock on site_licenses until commit). They now run once, at startup schema
// sync, under its advisory lock. Each step is idempotent.

import type { Client } from "@cocalc/database/pool";

type DatabaseClient = Pick<Client, "query">;

const LEGACY_EXTERNAL_CLAIM_KEY_CHECKS = [
  "site_license_external_claim_keys_check",
  "site_license_external_claim_keys_check1",
  "site_license_external_claim_keys_check2",
  "site_license_external_claim_keys_one_public_key",
];

// True when ensureSiteLicenseSchemaData still has something to do.
export async function siteLicenseSchemaDataNeedsSync(
  db: DatabaseClient,
): Promise<boolean> {
  const { rows } = await db.query<{ needs: boolean }>(
    `SELECT
       NOT EXISTS (SELECT 1 FROM site_license_domain_locks WHERE id=1)
       OR EXISTS (
         SELECT 1 FROM site_license_managers
          WHERE role='owner' AND revoked_at IS NULL)
       OR EXISTS (
         SELECT 1 FROM pg_constraint
          WHERE conrelid=to_regclass('public.site_license_external_claim_keys')
            AND conname = ANY($1::text[])) AS needs`,
    [LEGACY_EXTERNAL_CLAIM_KEY_CHECKS],
  );
  return rows[0]?.needs === true;
}

export async function ensureSiteLicenseSchemaData(
  db: DatabaseClient,
): Promise<void> {
  // Domain-index writes serialize by locking this row FOR UPDATE.
  await db.query(
    "INSERT INTO site_license_domain_locks (id, name) VALUES (1, 'site-license-domain-write-lock') ON CONFLICT (id) DO NOTHING",
  );
  // Ownership used to be an 'owner' manager row; it is now
  // site_licenses.owner_account_id, and remaining owner rows become viewers.
  await db.query(`
    UPDATE site_licenses s
       SET owner_account_id = owner_rows.account_id,
           updated = NOW()
      FROM (
        SELECT DISTINCT ON (site_license_id) site_license_id, account_id
          FROM site_license_managers
         WHERE role = 'owner'
           AND revoked_at IS NULL
         ORDER BY site_license_id, created ASC
      ) owner_rows
     WHERE s.id = owner_rows.site_license_id
       AND s.owner_account_id IS NULL
  `);
  await db.query(`
    UPDATE site_license_managers
       SET role = 'viewer',
           updated = NOW()
     WHERE role = 'owner'
       AND revoked_at IS NULL
  `);
  // Earlier versions required exactly one public key form.
  for (const constraint of LEGACY_EXTERNAL_CLAIM_KEY_CHECKS) {
    await db.query(
      `ALTER TABLE site_license_external_claim_keys DROP CONSTRAINT IF EXISTS ${constraint}`,
    );
  }
}
