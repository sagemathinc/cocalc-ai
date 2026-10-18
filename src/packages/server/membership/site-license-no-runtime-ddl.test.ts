/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Site-license requests used to run schema DDL (ALTER TABLE site_licenses ...)
// inside every transaction, which waits for an ACCESS EXCLUSIVE lock: any
// open transaction that had merely read site_licenses blocked every
// site-license write, and the write then blocked all readers. Startup schema
// sync owns the schema now. This needs concurrent transactions, hence a real
// PostgreSQL; it skips itself when the server binaries are not installed.

import {
  postgresBinDir,
  startRealPostgres,
  waitForLockWaiters,
  type RealPostgres,
} from "@cocalc/server/test/real-postgres";
import { uuid } from "@cocalc/util/misc";

const describeRealPostgres = postgresBinDir() ? describe : describe.skip;

describeRealPostgres("site-license requests take no schema locks", () => {
  let pg: RealPostgres;
  let getPool: any;
  let siteLicenses: typeof import("./site-licenses");
  let packages: typeof import("./packages");
  let testData: typeof import("@cocalc/server/purchases/test-data");

  beforeAll(async () => {
    pg = startRealPostgres("site_license_no_runtime_ddl_test");
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

  it("updates a license while another transaction has read site_licenses", async () => {
    const admin = uuid();
    const owner = uuid();
    for (const id of [admin, owner]) await testData.createTestAccount(id);
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
      name: "No DDL Campus",
      organization_name: "Example University",
      allowed_domains: [`no-ddl-${uuid().slice(0, 8)}.edu`],
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

    // A reader holds ACCESS SHARE on site_licenses until it commits.
    const reader = await getPool().connect();
    try {
      await reader.query("BEGIN");
      await reader.query("SELECT count(*) FROM site_licenses");
      const updated = await Promise.race([
        siteLicenses.updateSiteLicense({
          actor_account_id: admin,
          site_license_id: overview.site_license.id,
          name: "Renamed Campus",
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  "updateSiteLicense waited for a table lock held by a reader",
                ),
              ),
            5_000,
          ),
        ),
      ]);
      expect(updated.site_license.name).toBe("Renamed Campus");
    } finally {
      await reader.query("COMMIT");
      reader.release();
    }
  }, 60_000);

  // The schema lock used to serialize this too: archiving checks the pool has
  // no active seats, so a seat must not be assigned between that check and
  // the archive.
  it("never archives a pool while a seat is being assigned", async () => {
    const admin = uuid();
    const owner = uuid();
    const recipient = uuid();
    for (const id of [admin, owner, recipient]) {
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
      name: "Archive Race Campus",
      organization_name: "Example University",
      allowed_domains: [`archive-race-${uuid().slice(0, 8)}.edu`],
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
    const package_id = overview.pools[0].id;

    // Pause the archive right after it has checked for active seats.
    let notifyPaused!: () => void;
    let release!: () => void;
    const paused = new Promise<void>((resolve) => (notifyPaused = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    let archiving = false;
    const original = packages.listMembershipPackageAssignments;
    const spy = jest
      .spyOn(packages, "listMembershipPackageAssignments")
      .mockImplementation(async (opts: any) => {
        const result = await original(opts);
        if (archiving && opts?.package_id === package_id) {
          archiving = false;
          notifyPaused();
          await gate;
        }
        return result;
      });
    const pending: Promise<unknown>[] = [];
    try {
      archiving = true;
      const archive = siteLicenses.archiveSiteLicensePool({
        actor_account_id: admin,
        package_id,
      });
      pending.push(archive);
      await paused;
      const assign = packages.assignMembershipPackageSeat({
        package_id,
        account_id: recipient,
        assigned_by_account_id: admin,
        trusted_admin: true,
      });
      pending.push(assign);
      // The assignment must wait for the package row held by the archive.
      await waitForLockWaiters((sql) => getPool().query(sql), 1);
      release();
      await archive;
      await expect(assign).rejects.toThrow();
    } finally {
      release();
      await Promise.allSettled(pending);
      spy.mockRestore();
    }
    const { rows } = await getPool().query(
      "SELECT count(*)::int AS n FROM membership_package_assignments WHERE package_id=$1 AND revoked_at IS NULL",
      [package_id],
    );
    expect(rows[0].n).toBe(0);
  }, 60_000);
});
