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
});
