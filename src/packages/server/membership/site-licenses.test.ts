/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { after, before } from "@cocalc/server/test";
import {
  createTestAccount,
  createTestMembershipTier,
} from "@cocalc/server/purchases/test-data";
import { uuid } from "@cocalc/util/misc";
import {
  claimMembershipPackageSeat,
  listClaimableMembershipPackagesForAccount,
  listMembershipPackageAssignments,
} from "./packages";
import { resolveMembershipForAccount } from "./resolve";
import {
  adminProvisionSiteLicense,
  requestSiteLicensePool,
  reviewSiteLicensePoolRequest,
} from "./site-licenses";

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);

afterAll(after);

describe("site license seat pools", () => {
  const studentTier = `student-tier-${uuid()}`;
  const instructorTier = `instructor-tier-${uuid()}`;
  const researcherTier = `researcher-tier-${uuid()}`;

  beforeAll(async () => {
    await createTestMembershipTier({
      id: studentTier,
      priority: 10,
      price_yearly: 100,
    });
    await createTestMembershipTier({
      id: instructorTier,
      priority: 20,
      price_yearly: 200,
    });
    await createTestMembershipTier({
      id: researcherTier,
      priority: 30,
      price_yearly: 300,
    });
  });

  async function markAdmin(account_id: string) {
    await getPool().query(
      "UPDATE accounts SET groups=ARRAY['admin']::text[] WHERE account_id=$1",
      [account_id],
    );
  }

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

  it("provisions pools and requires manager approval for higher tier seats", async () => {
    const admin_account_id = uuid();
    const owner_account_id = uuid();
    const student_account_id = uuid();
    const researcher_account_id = uuid();
    const domain = `site-${uuid().slice(0, 8)}.edu`;
    await createTestAccount(admin_account_id);
    await createTestAccount(owner_account_id);
    await createTestAccount(student_account_id);
    await createTestAccount(researcher_account_id);
    await markAdmin(admin_account_id);
    await markVerifiedEmail(student_account_id, `ada@${domain}`);
    await markVerifiedEmail(researcher_account_id, `ada+research@${domain}`);

    const overview = await adminProvisionSiteLicense({
      actor_account_id: admin_account_id,
      owner_account_id,
      name: "Math Department Launch",
      organization_name: "Example University",
      allowed_domains: [domain],
      pools: [
        {
          pool_name: "Students",
          membership_class: studentTier,
          seat_count: 20,
          requires_approval: false,
          verification_policy: "email-domain",
          exclusive_group: "teaching",
        },
        {
          pool_name: "Instructors",
          membership_class: instructorTier,
          seat_count: 5,
          requires_approval: true,
          verification_policy: "manager-approval",
          exclusive_group: "teaching",
        },
        {
          pool_name: "Researchers",
          membership_class: researcherTier,
          seat_count: 50,
          requires_approval: true,
          verification_policy: "manager-approval",
          exclusive_group: "research",
        },
      ],
    });

    expect(overview.site_license.allowed_domains).toEqual([domain]);
    expect(overview.pools.map((pool) => pool.pool_name).sort()).toEqual([
      "Instructors",
      "Researchers",
      "Students",
    ]);
    expect(overview.managers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          account_id: owner_account_id,
          role: "owner",
        }),
      ]),
    );
    const studentPool = overview.pools.find(
      (pool) => pool.pool_name === "Students",
    )!;
    const instructorPool = overview.pools.find(
      (pool) => pool.pool_name === "Instructors",
    )!;
    const researcherPool = overview.pools.find(
      (pool) => pool.pool_name === "Researchers",
    )!;
    expect(studentPool.requires_approval).toBe(false);
    expect(instructorPool.requires_approval).toBe(true);
    expect(researcherPool.requires_approval).toBe(true);
    expect(studentPool.exclusive_group).toBe("teaching");
    expect(instructorPool.exclusive_group).toBe("teaching");
    expect(researcherPool.exclusive_group).toBe("research");

    const claimables = await listClaimableMembershipPackagesForAccount({
      account_id: student_account_id,
    });
    expect(claimables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ package_id: studentPool.id }),
      ]),
    );
    expect(claimables).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ package_id: instructorPool.id }),
      ]),
    );
    await expect(
      claimMembershipPackageSeat({
        package_id: instructorPool.id,
        account_id: student_account_id,
      }),
    ).rejects.toThrow("no claimable seat found for this account");

    const studentClaim = await claimMembershipPackageSeat({
      package_id: studentPool.id,
      account_id: student_account_id,
    });
    expect(studentClaim.grant_source).toBe("site-license");
    expect((await resolveMembershipForAccount(student_account_id)).class).toBe(
      studentTier,
    );

    const request = await requestSiteLicensePool({
      account_id: student_account_id,
      package_id: instructorPool.id,
      requester_note: "Teaching MATH 101",
      accepted_terms: true,
    });
    expect(request).toMatchObject({
      site_license_id: overview.site_license.id,
      package_id: instructorPool.id,
      account_id: student_account_id,
      state: "pending",
      canonical_identity: `ada@${domain}`,
    });

    const approved = await reviewSiteLicensePoolRequest({
      actor_account_id: owner_account_id,
      request_id: request.id,
      action: "approve",
      review_note: "Instructor confirmed.",
    });
    expect(approved.state).toBe("approved");
    expect((await resolveMembershipForAccount(student_account_id)).class).toBe(
      instructorTier,
    );
    expect(
      (
        await listMembershipPackageAssignments({
          package_id: studentPool.id,
          include_revoked: false,
        })
      ).filter((assignment) => assignment.account_id === student_account_id),
    ).toHaveLength(0);
    expect(
      await listMembershipPackageAssignments({
        package_id: instructorPool.id,
        include_revoked: false,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ account_id: student_account_id }),
      ]),
    );

    await expect(
      requestSiteLicensePool({
        account_id: researcher_account_id,
        package_id: instructorPool.id,
      }),
    ).rejects.toThrow("site-license pool already claimed for this identity");

    const researcherRequest = await requestSiteLicensePool({
      account_id: researcher_account_id,
      package_id: researcherPool.id,
      requester_note: "Running a research group.",
      accepted_terms: true,
    });
    expect(researcherRequest).toMatchObject({
      site_license_id: overview.site_license.id,
      package_id: researcherPool.id,
      account_id: researcher_account_id,
      state: "pending",
      canonical_identity: `ada@${domain}`,
    });
    await reviewSiteLicensePoolRequest({
      actor_account_id: owner_account_id,
      request_id: researcherRequest.id,
      action: "approve",
      review_note: "Researcher confirmed.",
    });
    expect(
      (await resolveMembershipForAccount(researcher_account_id)).class,
    ).toBe(researcherTier);
    expect(
      await listMembershipPackageAssignments({
        package_id: instructorPool.id,
        include_revoked: false,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ account_id: student_account_id }),
      ]),
    );
    expect(
      await listMembershipPackageAssignments({
        package_id: researcherPool.id,
        include_revoked: false,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ account_id: researcher_account_id }),
      ]),
    );
  });
});
