/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import { after, before, getPool } from "@cocalc/server/test";
import { FUNDING_ACCOUNT_WRITER_PROTOCOL_VERSION } from "@cocalc/server/purchases/lock-account-spending";
import {
  FUNDING_ACCOUNT_WRITER_ROLES,
  type FundingRolloutBay,
  type FundingRolloutManifest,
} from "./production-rollout-contract";
import {
  listFundingAuthorityWriterRoles,
  verifyFundingAccountWriters,
} from "./account-writer-rollout";

const postgresDescribe = process.env.COCALC_TEST_USE_PGLITE
  ? describe.skip
  : describe;

postgresDescribe("funding account writer PostgreSQL census", () => {
  const original = { ...process.env };

  beforeAll(async () => await before({ noConat: true }), 15_000);
  afterAll(async () => {
    for (const key of Object.keys(process.env)) {
      if (!(key in original)) delete process.env[key];
    }
    Object.assign(process.env, original);
    await after();
  });

  it("rejects a login that can mutate financial or admission authority", async () => {
    const pool = getPool();
    const suffix = randomUUID().replaceAll("-", "");
    const staleRole = `funding_stale_${suffix}`;
    const {
      rows: [identity],
    } = await pool.query<{
      database: string;
      role: string;
      system_identifier: string;
    }>(
      "SELECT current_database() AS database,current_user AS role,system_identifier::text FROM pg_control_system()",
    );
    process.env.COCALC_FUNDING_WRITER_ID = "test-writer";
    process.env.COCALC_FUNDING_WRITER_BUILD_ID = "test-build";
    const bay: FundingRolloutBay = {
      bay_id: "test",
      namespace: "test",
      database: {
        name: identity.database,
        system_identifier: identity.system_identifier,
        trust_model: "co-resident-operator-writer",
        writer_roles: [identity.role],
        operator_roles: [],
        retired_roles: [],
      },
      writers: [
        {
          id: "test-writer",
          build_id: "test-build",
          protocol_version: FUNDING_ACCOUNT_WRITER_PROTOCOL_VERSION,
          database_role: identity.role,
          roles: [...FUNDING_ACCOUNT_WRITER_ROLES],
        },
      ],
      resource_credentials: [],
      retired_resource_credentials: [],
      credential_rollout: {
        epoch: "test",
        mode: "bootstrap",
        completed_at: new Date().toISOString(),
        evidence_id: "test",
      },
    };
    const manifest = {} as FundingRolloutManifest;
    try {
      await pool.query(`CREATE ROLE "${staleRole}" LOGIN`);
      await pool.query(
        `GRANT CONNECT ON DATABASE "${identity.database}" TO "${staleRole}"`,
      );
      for (const table of [
        "billing_accounts",
        "account_entitlement_overrides",
        "account_second_factors",
        "admin_assigned_memberships",
        "membership_grants",
        "membership_package_assignments",
        "membership_packages",
        "membership_tiers",
        "server_settings",
      ]) {
        await pool.query(`GRANT UPDATE ON TABLE ${table} TO "${staleRole}"`);
        await expect(listFundingAuthorityWriterRoles(pool)).resolves.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ role: staleRole }),
          ]),
        );
        await expect(
          verifyFundingAccountWriters(manifest, bay),
        ).rejects.toThrow("writer coverage");
        await pool.query(`REVOKE UPDATE ON TABLE ${table} FROM "${staleRole}"`);
        await expect(
          listFundingAuthorityWriterRoles(pool),
        ).resolves.not.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ role: staleRole }),
          ]),
        );
      }
    } finally {
      await pool.query(`DROP OWNED BY "${staleRole}"`);
      await pool.query(`DROP ROLE IF EXISTS "${staleRole}"`);
    }
  });
});
