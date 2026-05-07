/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { after, before } from "@cocalc/server/test";
import {
  createTestAccount,
  createTestMembershipPackage,
  createTestMembershipTier,
} from "@cocalc/server/purchases/test-data";
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

  beforeAll(async () => {
    await createTestMembershipTier({
      id: teamTier,
      priority: 25,
      price_monthly: 20,
      price_yearly: 200,
    });
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

  it("lets a verified domain claim a site seat without a preassignment", async () => {
    const owner_account_id = uuid();
    const site_user_account_id = uuid();
    await createTestAccount(owner_account_id);
    await createTestAccount(site_user_account_id);
    await markVerifiedEmail(site_user_account_id, "ada@example.edu");

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

    const membership = await resolveMembershipForAccount(site_user_account_id);
    expect(membership.class).toBe(teamTier);
    expect(membership.grant_source).toBe("site-license");
  });
});
