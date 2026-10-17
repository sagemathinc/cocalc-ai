/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Adding a pool reads the license owner and creates a package owned by it;
// transferring ownership moves the license and its pools. Both serialize on
// the license row, so a pool can never be created for a previous owner. This
// needs concurrent transactions, hence a real PostgreSQL (PGlite has a single
// connection); it skips itself when the server binaries are not installed.

import {
  postgresBinDir,
  startRealPostgres,
  waitForLockWaiters,
  type RealPostgres,
} from "@cocalc/server/test/real-postgres";
import { uuid } from "@cocalc/util/misc";

const describeRealPostgres = postgresBinDir() ? describe : describe.skip;

describeRealPostgres("site-license ownership transfer concurrency", () => {
  let pg: RealPostgres;
  let getPool: any;
  let siteLicenses: typeof import("./site-licenses");
  let packages: typeof import("./packages");
  let testData: typeof import("@cocalc/server/purchases/test-data");

  beforeAll(async () => {
    // A dedicated database keeps the normal connection pool (the ephemeral
    // test database is capped at two connections, too few for this test).
    pg = startRealPostgres("site_license_owner_transfer_test");
    getPool = (await import("@cocalc/database/pool")).default;
    const { SCHEMA } = await import("@cocalc/util/db-schema");
    const { syncSchema } =
      await import("@cocalc/database/postgres/schema/sync");
    await syncSchema(SCHEMA);
    siteLicenses = await import("./site-licenses");
    packages = await import("./packages");
    testData = await import("@cocalc/server/purchases/test-data");
  }, 120_000);

  afterAll(async () => {
    try {
      await getPool?.().end();
    } finally {
      pg?.stop();
    }
  });

  it("a pool added during an ownership transfer belongs to the new owner", async () => {
    const admin = uuid();
    const owner = uuid();
    const nextOwner = uuid();
    for (const id of [admin, owner, nextOwner]) {
      await testData.createTestAccount(id);
    }
    await getPool().query(
      "UPDATE accounts SET groups=ARRAY['admin']::text[] WHERE account_id=$1",
      [admin],
    );
    const studentTier = `student-tier-${uuid()}`;
    await testData.createTestMembershipTier({
      id: studentTier,
      priority: 10,
      price_yearly: 100,
    });
    const overview = await siteLicenses.adminProvisionSiteLicense({
      actor_account_id: admin,
      owner_account_id: owner,
      name: "Concurrent Transfer Campus",
      organization_name: "Example University",
      allowed_domains: [`transfer-race-${uuid().slice(0, 8)}.edu`],
      pools: [
        {
          pool_name: "Students",
          membership_class: studentTier,
          seat_count: 10,
          requires_approval: false,
          verification_policy: "email-domain",
          exclusive_group: "teaching",
        },
      ],
    });
    const site_license_id = overview.site_license.id;

    // Pause the pool creation after it has read the owner, just before it
    // inserts the package.
    let notifyPaused!: () => void;
    let release!: () => void;
    const paused = new Promise<void>((resolve) => (notifyPaused = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = packages.createMembershipPackage;
    const spy = jest
      .spyOn(packages, "createMembershipPackage")
      .mockImplementation(async (opts: any, client?: any) => {
        if (opts?.metadata?.provisioned_via === "site-license-pool-add") {
          notifyPaused();
          await gate;
        }
        return await original(opts, client);
      });
    const timeout = setTimeout(() => release(), 10_000);
    const pending: Promise<unknown>[] = [];
    try {
      const adding = siteLicenses.addSiteLicensePool({
        actor_account_id: admin,
        site_license_id,
        pool: {
          pool_name: "Late Students",
          membership_class: studentTier,
          seat_count: 5,
          requires_approval: false,
          verification_policy: "email-domain",
          exclusive_group: "teaching",
        },
      });
      pending.push(adding);
      await paused;
      const transferring = siteLicenses.updateSiteLicense({
        actor_account_id: admin,
        site_license_id,
        owner_account_id: nextOwner,
      });
      pending.push(transferring);
      // The transfer must wait for the license row held by the pool creation.
      await waitForLockWaiters((sql) => getPool().query(sql), 1);
      release();
      await Promise.all([adding, transferring]);
    } finally {
      // Even when an assertion above fails, let both transactions finish so
      // no connection or PostgreSQL child is left behind.
      release();
      await Promise.allSettled(pending);
      clearTimeout(timeout);
      spy.mockRestore();
    }

    const { rows } = await getPool().query(
      `SELECT 'license' AS kind, owner_account_id::text AS owner
         FROM site_licenses WHERE id=$1::uuid
       UNION ALL
       SELECT metadata->>'pool_name', owner_account_id::text
         FROM membership_packages
        WHERE kind='site' AND metadata->>'site_license_id'=$1::text`,
      [site_license_id],
    );
    expect(rows).toHaveLength(3);
    expect(rows.map(({ owner }) => owner)).toEqual([
      nextOwner,
      nextOwner,
      nextOwner,
    ]);
  }, 60_000);
});
