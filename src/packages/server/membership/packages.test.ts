/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

let createInterBayAccountLocalClientMock: jest.Mock;
let getInterBayFabricClientMock: jest.Mock;

jest.mock("@cocalc/conat/inter-bay/api", () => {
  const actual = jest.requireActual("@cocalc/conat/inter-bay/api");
  return {
    __esModule: true,
    ...actual,
    createInterBayAccountLocalClient: (...args: any[]) =>
      createInterBayAccountLocalClientMock(...args),
  };
});

jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  __esModule: true,
  getInterBayFabricClient: (...args: any[]) =>
    getInterBayFabricClientMock(...args),
}));

import getPool from "@cocalc/database/pool";
import { after, before } from "@cocalc/server/test";
import {
  createTestAccount,
  createTestMembershipPackage,
  createTestMembershipTier,
} from "@cocalc/server/purchases/test-data";
import purchaseMembershipPackage from "@cocalc/server/purchases/membership-package";
import { uuid } from "@cocalc/util/misc";
import { resolveMembershipForAccount } from "./resolve";
import {
  assignMembershipPackageSeat,
  claimMembershipPackageSeat,
  listClaimableMembershipPackagesForAccount,
  listMembershipPackageDetailsForOwner,
  resolveMembershipPackageQuote,
  revokeMembershipPackageSeat,
} from "./packages";

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);

afterAll(after);

describe("membership packages", () => {
  const teamTier = `team-tier-${uuid()}`;
  let remoteGrantUpserts: Array<{ dest_bay: string; grant: any }>;
  let remoteGrantRevocations: Array<{ dest_bay: string; opts: any }>;

  async function markVerifiedEmail(account_id: string, email_address: string) {
    await getPool().query(
      `UPDATE accounts
       SET email_address=$2,
           email_address_verified=$3::jsonb
       WHERE account_id=$1`,
      [
        account_id,
        email_address,
        { [email_address]: new Date().toISOString() },
      ],
    );
  }

  async function setAccountHomeBay(account_id: string, home_bay_id: string) {
    const pool = getPool("medium");
    await pool.query("UPDATE accounts SET home_bay_id=$2 WHERE account_id=$1", [
      account_id,
      home_bay_id,
    ]);
    const table = await pool.query<{ table_name: string | null }>(
      "SELECT to_regclass($1) AS table_name",
      ["public.cluster_account_directory"],
    );
    if (table.rows[0]?.table_name) {
      await pool.query(
        "UPDATE cluster_account_directory SET home_bay_id=$2 WHERE account_id=$1",
        [account_id, home_bay_id],
      );
    }
  }

  beforeAll(async () => {
    await createTestMembershipTier({
      id: teamTier,
      priority: 25,
      price_monthly: 20,
      price_yearly: 200,
    });
  });

  beforeEach(() => {
    remoteGrantUpserts = [];
    remoteGrantRevocations = [];
    getInterBayFabricClientMock = jest.fn(() => ({ id: "fabric-client" }));
    createInterBayAccountLocalClientMock = jest.fn(
      ({ dest_bay }: { dest_bay: string }) => ({
        upsertMembershipGrant: jest.fn(async (grant) => {
          remoteGrantUpserts.push({ dest_bay, grant });
          return { grant_id: grant.id };
        }),
        revokeMembershipGrant: jest.fn(async (opts) => {
          remoteGrantRevocations.push({ dest_bay, opts });
        }),
      }),
    );
  });

  it("assigns seats, resolves grant-backed membership, and revokes assignments", async () => {
    const owner_account_id = uuid();
    const first_account_id = uuid();
    const second_account_id = uuid();
    const third_account_id = uuid();
    await createTestAccount(owner_account_id);
    await createTestAccount(first_account_id);
    await createTestAccount(second_account_id);
    await createTestAccount(third_account_id);

    const package_id = await createTestMembershipPackage({
      owner_account_id,
      kind: "team",
      membership_class: teamTier,
      seat_count: 2,
      metadata: {
        interval: "month",
        seat_price: 20,
      },
    });

    const firstAssignment = await assignMembershipPackageSeat({
      package_id,
      account_id: first_account_id,
      assigned_by_account_id: owner_account_id,
    });
    expect(firstAssignment.account_id).toBe(first_account_id);
    expect(firstAssignment.grant_source).toBe("team-seat");

    await assignMembershipPackageSeat({
      package_id,
      account_id: second_account_id,
      assigned_by_account_id: owner_account_id,
    });

    const assignmentCount = await getPool("medium").query(
      `SELECT COUNT(*)::int AS count
       FROM membership_package_assignments
       WHERE package_id=$1
         AND revoked_at IS NULL`,
      [package_id],
    );
    expect(assignmentCount.rows[0]?.count).toBe(2);

    const membership = await resolveMembershipForAccount(first_account_id);
    expect(membership.class).toBe(teamTier);
    expect(membership.source).toBe("grant");
    expect(membership.grant_package_id).toBe(package_id);
    expect(membership.grant_source).toBe("team-seat");

    await expect(
      assignMembershipPackageSeat({
        package_id,
        account_id: third_account_id,
        assigned_by_account_id: owner_account_id,
      }),
    ).rejects.toThrow("no seats available");

    const details = await listMembershipPackageDetailsForOwner({
      owner_account_id,
    });
    expect(details).toHaveLength(1);
    expect(details[0].active_assignment_count).toBe(2);
    expect(details[0].available_seat_count).toBe(0);

    await expect(
      revokeMembershipPackageSeat({
        package_id,
        account_id: first_account_id,
      }),
    ).resolves.toBe(true);

    const revokedMembership =
      await resolveMembershipForAccount(first_account_id);
    expect(revokedMembership.class).toBe("free");
    expect(revokedMembership.source).toBe("free");
  });

  it("reuses the package's stored seat price when expanding seats later", async () => {
    const owner_account_id = uuid();
    await createTestAccount(owner_account_id);

    const package_id = await createTestMembershipPackage({
      owner_account_id,
      kind: "team",
      membership_class: teamTier,
      seat_count: 10,
      metadata: {
        interval: "month",
        seat_price: 17.5,
      },
    });

    const pool = getPool("medium");
    await pool.query(
      "UPDATE membership_tiers SET price_monthly=$2, updated=NOW() WHERE id=$1",
      [teamTier, 99],
    );

    const quote = await resolveMembershipPackageQuote({
      type: "membership-package",
      kind: "team",
      membership_class: teamTier,
      seat_count: 5,
      package_id,
      interval: "month",
    });

    expect(quote.package_id).toBe(package_id);
    expect(quote.seat_price).toBe(17.5);
    expect(quote.total_price).toBe(87.5);
  });

  it("updates project usage attribution when assigning and revoking a course seat", async () => {
    const owner_account_id = uuid();
    const student_account_id = uuid();
    const project_id = uuid();
    await createTestAccount(owner_account_id);
    await createTestAccount(student_account_id);

    await getPool("medium").query(
      `INSERT INTO projects (project_id, title, users, last_edited, usage_account_id)
       VALUES ($1, $2, $3::jsonb, NOW(), NULL)`,
      [
        project_id,
        "Student Project",
        JSON.stringify({
          [owner_account_id]: { group: "owner" },
        }),
      ],
    );

    const package_id = await createTestMembershipPackage({
      owner_account_id,
      kind: "course",
      membership_class: "student",
      seat_count: 1,
      metadata: {
        course_project_id: uuid(),
        interval: "month",
        seat_price: 25,
      },
    });

    await assignMembershipPackageSeat({
      package_id,
      account_id: student_account_id,
      assigned_by_account_id: owner_account_id,
      metadata: {
        project_id,
      },
    });

    const assignedUsage = await getPool().query(
      "SELECT usage_account_id::text AS usage_account_id FROM projects WHERE project_id=$1",
      [project_id],
    );
    expect(assignedUsage.rows[0]?.usage_account_id).toBe(student_account_id);

    await revokeMembershipPackageSeat({
      package_id,
      account_id: student_account_id,
    });

    const revokedUsage = await getPool().query(
      "SELECT usage_account_id::text AS usage_account_id FROM projects WHERE project_id=$1",
      [project_id],
    );
    expect(revokedUsage.rows[0]?.usage_account_id).toBeNull();
  });

  it("updates project usage attribution when a reserved course seat is claimed", async () => {
    const owner_account_id = uuid();
    const student_account_id = uuid();
    const project_id = uuid();
    await createTestAccount(owner_account_id);
    await createTestAccount(student_account_id);
    await markVerifiedEmail(student_account_id, "reserved-student@example.com");

    await getPool("medium").query(
      `INSERT INTO projects (project_id, title, users, last_edited, usage_account_id)
       VALUES ($1, $2, $3::jsonb, NOW(), NULL)`,
      [
        project_id,
        "Reserved Student Project",
        JSON.stringify({
          [owner_account_id]: { group: "owner" },
        }),
      ],
    );

    const package_id = await createTestMembershipPackage({
      owner_account_id,
      kind: "course",
      membership_class: "student",
      seat_count: 1,
      metadata: {
        course_project_id: uuid(),
        interval: "month",
        seat_price: 25,
      },
    });

    await assignMembershipPackageSeat({
      package_id,
      email_address: "reserved-student@example.com",
      assigned_by_account_id: owner_account_id,
      metadata: {
        project_id,
      },
    });

    await claimMembershipPackageSeat({
      package_id,
      account_id: student_account_id,
    });

    const claimedUsage = await getPool().query(
      "SELECT usage_account_id::text AS usage_account_id FROM projects WHERE project_id=$1",
      [project_id],
    );
    expect(claimedUsage.rows[0]?.usage_account_id).toBe(student_account_id);
  });

  it("reserves a seat by email and lets the verified account claim it later", async () => {
    const owner_account_id = uuid();
    const invited_account_id = uuid();
    await createTestAccount(owner_account_id);
    await createTestAccount(invited_account_id);
    await markVerifiedEmail(invited_account_id, "student@example.com");

    const package_id = await createTestMembershipPackage({
      owner_account_id,
      kind: "team",
      membership_class: teamTier,
      seat_count: 1,
      metadata: {
        interval: "month",
        seat_price: 20,
      },
    });

    const reserved = await assignMembershipPackageSeat({
      package_id,
      email_address: "student@example.com",
      assigned_by_account_id: owner_account_id,
    });
    expect(reserved.email_address).toBe("student@example.com");
    expect(reserved.account_id).toBeUndefined();
    expect(reserved.grant_id).toBeUndefined();

    const claimables = await listClaimableMembershipPackagesForAccount({
      account_id: invited_account_id,
    });
    expect(claimables).toHaveLength(1);
    expect(claimables[0].reason).toBe("email-assignment");
    expect(claimables[0].matched_email_address).toBe("student@example.com");

    const claimed = await claimMembershipPackageSeat({
      package_id,
      account_id: invited_account_id,
    });
    expect(claimed.account_id).toBe(invited_account_id);
    expect(claimed.email_address).toBe("student@example.com");
    expect(claimed.grant_source).toBe("team-seat");

    const membership = await resolveMembershipForAccount(invited_account_id);
    expect(membership.class).toBe(teamTier);
    expect(membership.source).toBe("grant");
  });

  it("routes site claims to the beneficiary home bay when no preassignment exists", async () => {
    const owner_account_id = uuid();
    const site_user_account_id = uuid();
    await createTestAccount(owner_account_id);
    await createTestAccount(site_user_account_id);
    await markVerifiedEmail(site_user_account_id, "ada@example.edu");
    await setAccountHomeBay(site_user_account_id, "bay-1");

    const package_id = await createTestMembershipPackage({
      owner_account_id,
      kind: "site",
      membership_class: teamTier,
      seat_count: 3,
      metadata: {
        interval: "year",
        seat_price: 100,
        allowed_domains: ["example.edu"],
      },
    });

    const claimables = await listClaimableMembershipPackagesForAccount({
      account_id: site_user_account_id,
    });
    expect(claimables).toHaveLength(1);
    expect(claimables[0]).toMatchObject({
      package_id,
      reason: "domain-match",
      matched_email_address: "ada@example.edu",
    });

    const claimed = await claimMembershipPackageSeat({
      package_id,
      account_id: site_user_account_id,
    });
    expect(claimed.account_id).toBe(site_user_account_id);
    expect(claimed.email_address).toBe("ada@example.edu");
    expect(claimed.metadata?.grant_home_bay_id).toBe("bay-1");
    expect(remoteGrantUpserts).toHaveLength(1);
    expect(remoteGrantUpserts[0]).toMatchObject({
      dest_bay: "bay-1",
      grant: {
        account_id: site_user_account_id,
        source: "site-license",
        package_id,
      },
    });
    const localGrantCount = await getPool("medium").query(
      `SELECT COUNT(*)::int AS count
       FROM membership_grants
       WHERE account_id=$1
         AND package_id=$2`,
      [site_user_account_id, package_id],
    );
    expect(localGrantCount.rows[0]?.count).toBe(0);
  });

  it("rejects package purchase writes on a stale non-home bay", async () => {
    const owner_account_id = uuid();
    await createTestAccount(owner_account_id);
    await setAccountHomeBay(owner_account_id, "bay-1");

    await expect(
      purchaseMembershipPackage({
        account_id: owner_account_id,
        amount: 200,
        product: {
          type: "membership-package",
          kind: "team",
          membership_class: teamTier,
          seat_count: 1,
          interval: "month",
        },
      }),
    ).rejects.toThrow(/account is homed on bay-1/);
  });

  it("rejects seat assignment writes on a stale non-home bay", async () => {
    const owner_account_id = uuid();
    const invited_account_id = uuid();
    await createTestAccount(owner_account_id);
    await createTestAccount(invited_account_id);

    const package_id = await createTestMembershipPackage({
      owner_account_id,
      kind: "team",
      membership_class: teamTier,
      seat_count: 1,
      metadata: {
        interval: "month",
        seat_price: 20,
      },
    });
    await setAccountHomeBay(owner_account_id, "bay-1");

    await expect(
      assignMembershipPackageSeat({
        package_id,
        account_id: invited_account_id,
        assigned_by_account_id: owner_account_id,
      }),
    ).rejects.toThrow(/account is homed on bay-1/);
  });

  it("routes reserved-email claims to the beneficiary home bay", async () => {
    const owner_account_id = uuid();
    const invited_account_id = uuid();
    await createTestAccount(owner_account_id);
    await createTestAccount(invited_account_id);
    await markVerifiedEmail(invited_account_id, "remote-student@example.com");

    const package_id = await createTestMembershipPackage({
      owner_account_id,
      kind: "team",
      membership_class: teamTier,
      seat_count: 1,
      metadata: {
        interval: "month",
        seat_price: 20,
      },
    });

    await assignMembershipPackageSeat({
      package_id,
      email_address: "remote-student@example.com",
      assigned_by_account_id: owner_account_id,
    });
    await setAccountHomeBay(invited_account_id, "bay-1");

    const claimed = await claimMembershipPackageSeat({
      package_id,
      account_id: invited_account_id,
    });
    expect(claimed.account_id).toBe(invited_account_id);
    expect(claimed.email_address).toBe("remote-student@example.com");
    expect(claimed.metadata?.grant_home_bay_id).toBe("bay-1");
    expect(remoteGrantUpserts).toHaveLength(1);
    expect(remoteGrantUpserts[0]).toMatchObject({
      dest_bay: "bay-1",
      grant: {
        account_id: invited_account_id,
        source: "team-seat",
        package_id,
      },
    });
    const localGrantCount = await getPool("medium").query(
      `SELECT COUNT(*)::int AS count
       FROM membership_grants
       WHERE account_id=$1
         AND package_id=$2`,
      [invited_account_id, package_id],
    );
    expect(localGrantCount.rows[0]?.count).toBe(0);
  });

  it("routes direct seat assignment and revocation to the beneficiary home bay", async () => {
    const owner_account_id = uuid();
    const invited_account_id = uuid();
    await createTestAccount(owner_account_id);
    await createTestAccount(invited_account_id);
    await setAccountHomeBay(invited_account_id, "bay-1");

    const package_id = await createTestMembershipPackage({
      owner_account_id,
      kind: "team",
      membership_class: teamTier,
      seat_count: 1,
      metadata: {
        interval: "month",
        seat_price: 20,
      },
    });

    const assignment = await assignMembershipPackageSeat({
      package_id,
      account_id: invited_account_id,
      assigned_by_account_id: owner_account_id,
    });
    expect(assignment.account_id).toBe(invited_account_id);
    expect(assignment.metadata?.grant_home_bay_id).toBe("bay-1");
    expect(remoteGrantUpserts).toHaveLength(1);
    expect(remoteGrantUpserts[0]).toMatchObject({
      dest_bay: "bay-1",
      grant: {
        account_id: invited_account_id,
        source: "team-seat",
        package_id,
      },
    });

    const localGrantCount = await getPool("medium").query(
      `SELECT COUNT(*)::int AS count
       FROM membership_grants
       WHERE account_id=$1
         AND package_id=$2`,
      [invited_account_id, package_id],
    );
    expect(localGrantCount.rows[0]?.count).toBe(0);

    await expect(
      revokeMembershipPackageSeat({
        package_id,
        account_id: invited_account_id,
      }),
    ).resolves.toBe(true);
    expect(remoteGrantRevocations).toHaveLength(1);
    expect(remoteGrantRevocations[0]).toMatchObject({
      dest_bay: "bay-1",
      opts: {
        account_id: invited_account_id,
        grant_id: assignment.grant_id,
      },
    });
  });
});
