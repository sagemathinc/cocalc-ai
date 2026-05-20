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
  claimMembershipPackageSeatWithVerifiedEmailsOnLocalBay,
  listClaimableMembershipPackagesForAccount,
  listMembershipPackageAssignments,
} from "./packages";
import { resolveMembershipForAccount } from "./resolve";
import {
  adminProvisionSiteLicense,
  getSiteLicenseOverview,
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
    expect(overview.recent_audit_events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "site-license-provisioned",
          actor_account_id: admin_account_id,
          target_account_id: owner_account_id,
        }),
        expect.objectContaining({
          action: "manager-added",
          actor_account_id: admin_account_id,
          target_account_id: owner_account_id,
        }),
        expect.objectContaining({
          action: "pool-created",
          actor_account_id: admin_account_id,
          target_account_id: owner_account_id,
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
    expect(claimables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          package_id: instructorPool.id,
          requires_approval: true,
          pool_name: "Instructors",
          site_license_id: overview.site_license.id,
        }),
      ]),
    );
    await expect(
      claimMembershipPackageSeat({
        package_id: instructorPool.id,
        account_id: student_account_id,
      }),
    ).rejects.toThrow("this site-license pool requires manager approval");

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
    let refreshedOverview = await getSiteLicenseOverview({
      account_id: owner_account_id,
      site_license_id: overview.site_license.id,
    });
    expect(refreshedOverview.recent_audit_events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "pool-request-created",
          actor_account_id: student_account_id,
          target_account_id: student_account_id,
          package_id: instructorPool.id,
          request_id: request.id,
        }),
      ]),
    );

    const approved = await reviewSiteLicensePoolRequest({
      actor_account_id: owner_account_id,
      request_id: request.id,
      action: "approve",
      review_note: "Instructor confirmed.",
    });
    expect(approved.state).toBe("approved");
    refreshedOverview = await getSiteLicenseOverview({
      account_id: owner_account_id,
      site_license_id: overview.site_license.id,
    });
    expect(refreshedOverview.recent_audit_events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "pool-request-approved",
          actor_account_id: owner_account_id,
          target_account_id: student_account_id,
          package_id: instructorPool.id,
          request_id: request.id,
        }),
        expect.objectContaining({
          action: "seat-released-for-upgrade",
          actor_account_id: owner_account_id,
          target_account_id: student_account_id,
          package_id: studentPool.id,
          request_id: request.id,
        }),
      ]),
    );
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

  it("returns provisioned overview for trusted remote admin actor", async () => {
    const remote_admin_account_id = uuid();
    const owner_account_id = uuid();
    const domain = `trusted-${uuid().slice(0, 8)}.edu`;
    await createTestAccount(remote_admin_account_id);
    await createTestAccount(owner_account_id);

    const overview = await adminProvisionSiteLicense({
      actor_account_id: remote_admin_account_id,
      owner_account_id,
      name: "Trusted Remote Campus",
      organization_name: "Example University",
      allowed_domains: [domain],
      trusted_admin: true,
      pools: [
        {
          pool_name: "Students",
          membership_class: studentTier,
          seat_count: 20,
          requires_approval: false,
          verification_policy: "email-domain",
          exclusive_group: "teaching",
        },
      ],
    });

    expect(overview.site_license.name).toBe("Trusted Remote Campus");
    expect(overview.managers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          account_id: owner_account_id,
          role: "owner",
        }),
      ]),
    );
    await expect(
      getSiteLicenseOverview({
        account_id: remote_admin_account_id,
        site_license_id: overview.site_license.id,
      }),
    ).rejects.toThrow("must view site license");
  });

  it("requires custom terms acceptance before claim or request", async () => {
    const admin_account_id = uuid();
    const owner_account_id = uuid();
    const student_account_id = uuid();
    const instructor_account_id = uuid();
    const domain = `terms-${uuid().slice(0, 8)}.edu`;
    await createTestAccount(admin_account_id);
    await createTestAccount(owner_account_id);
    await createTestAccount(student_account_id);
    await createTestAccount(instructor_account_id);
    await markAdmin(admin_account_id);
    await markVerifiedEmail(student_account_id, `student@${domain}`);
    await markVerifiedEmail(instructor_account_id, `instructor@${domain}`);

    const overview = await adminProvisionSiteLicense({
      actor_account_id: admin_account_id,
      owner_account_id,
      name: "Custom Terms Campus",
      organization_name: "Example University",
      allowed_domains: [domain],
      custom_terms_url: "https://example.edu/cocalc-terms",
      custom_policy_url: "https://example.edu/cocalc-policy",
      terms_version_label: "2026 pilot",
      pools: [
        {
          pool_name: "Students",
          membership_class: studentTier,
          seat_count: 2,
          requires_approval: false,
          verification_policy: "email-domain",
          exclusive_group: "teaching",
        },
        {
          pool_name: "Instructors",
          membership_class: instructorTier,
          seat_count: 2,
          requires_approval: true,
          verification_policy: "manager-approval",
          exclusive_group: "teaching",
        },
      ],
    });
    const studentPool = overview.pools.find(
      (pool) => pool.pool_name === "Students",
    )!;
    const instructorPool = overview.pools.find(
      (pool) => pool.pool_name === "Instructors",
    )!;

    const claimables = await listClaimableMembershipPackagesForAccount({
      account_id: student_account_id,
    });
    expect(claimables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          package_id: studentPool.id,
          requires_terms_acceptance: true,
          custom_terms_url: "https://example.edu/cocalc-terms",
          custom_policy_url: "https://example.edu/cocalc-policy",
          terms_version_label: "2026 pilot",
        }),
      ]),
    );
    await expect(
      claimMembershipPackageSeat({
        package_id: studentPool.id,
        account_id: student_account_id,
      }),
    ).rejects.toThrow("accept the site-license terms");
    const claimed = await claimMembershipPackageSeat({
      package_id: studentPool.id,
      account_id: student_account_id,
      accepted_terms: true,
    });
    expect(claimed.metadata).toEqual(
      expect.objectContaining({
        accepted_terms: true,
        custom_terms_url: "https://example.edu/cocalc-terms",
        custom_policy_url: "https://example.edu/cocalc-policy",
        terms_version_label: "2026 pilot",
      }),
    );
    expect(claimed.metadata?.terms_accepted_at).toBeTruthy();

    await expect(
      requestSiteLicensePool({
        account_id: instructor_account_id,
        package_id: instructorPool.id,
      }),
    ).rejects.toThrow("accept the site-license terms");
    const request = await requestSiteLicensePool({
      account_id: instructor_account_id,
      package_id: instructorPool.id,
      accepted_terms: true,
    });
    expect(request.metadata).toEqual(
      expect.objectContaining({
        accepted_terms: true,
        custom_terms_url: "https://example.edu/cocalc-terms",
        custom_policy_url: "https://example.edu/cocalc-policy",
        terms_version_label: "2026 pilot",
      }),
    );
    expect(request.metadata?.terms_accepted_at).toBeTruthy();
  });

  it("prevents direct claims for a second pool in the same exclusive group", async () => {
    const admin_account_id = uuid();
    const owner_account_id = uuid();
    const account_id = uuid();
    const teachingDomain = `teach-${uuid().slice(0, 8)}.edu`;
    const researchDomain = `research-${uuid().slice(0, 8)}.edu`;
    await createTestAccount(admin_account_id);
    await createTestAccount(owner_account_id);
    await createTestAccount(account_id);
    await markAdmin(admin_account_id);
    await getPool().query(
      `UPDATE accounts
       SET email_address=$2,
           email_address_verified=$3::jsonb
       WHERE account_id=$1`,
      [
        account_id,
        `ada@${teachingDomain}`,
        {
          [`ada@${teachingDomain}`]: new Date().toISOString(),
          [`ada+research@${researchDomain}`]: new Date().toISOString(),
        },
      ],
    );

    const overview = await adminProvisionSiteLicense({
      actor_account_id: admin_account_id,
      owner_account_id,
      name: "Exclusive Group Campus",
      organization_name: "Example University",
      allowed_domains: [teachingDomain, researchDomain],
      pools: [
        {
          pool_name: "Students",
          membership_class: studentTier,
          seat_count: 5,
          requires_approval: false,
          verification_policy: "email-domain",
          exclusive_group: "teaching",
          allowed_domains: [teachingDomain],
        },
        {
          pool_name: "Teaching Staff",
          membership_class: instructorTier,
          seat_count: 5,
          requires_approval: false,
          verification_policy: "email-domain",
          exclusive_group: "teaching",
          allowed_domains: [researchDomain],
        },
        {
          pool_name: "Researchers",
          membership_class: researcherTier,
          seat_count: 5,
          requires_approval: false,
          verification_policy: "email-domain",
          exclusive_group: "research",
          allowed_domains: [researchDomain],
        },
      ],
    });
    const studentPool = overview.pools.find(
      (pool) => pool.pool_name === "Students",
    )!;
    const teachingStaffPool = overview.pools.find(
      (pool) => pool.pool_name === "Teaching Staff",
    )!;
    const researcherPool = overview.pools.find(
      (pool) => pool.pool_name === "Researchers",
    )!;

    await claimMembershipPackageSeat({
      account_id,
      package_id: studentPool.id,
    });
    const claimablesAfterStudentClaim =
      await listClaimableMembershipPackagesForAccount({ account_id });
    expect(
      claimablesAfterStudentClaim.some(
        (claimable) => claimable.package_id === teachingStaffPool.id,
      ),
    ).toBe(false);
    expect(claimablesAfterStudentClaim).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ package_id: researcherPool.id }),
      ]),
    );

    await expect(
      claimMembershipPackageSeatWithVerifiedEmailsOnLocalBay({
        account_id,
        package_id: teachingStaffPool.id,
        verified_email_addresses: [
          `ada@${teachingDomain}`,
          `ada+research@${researchDomain}`,
        ],
      }),
    ).rejects.toThrow(
      "account already has an active site-license seat in this teaching group",
    );
    await expect(
      claimMembershipPackageSeat({
        account_id,
        package_id: researcherPool.id,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        account_id,
        package_id: researcherPool.id,
      }),
    );
  });

  it("rechecks approval-required pool capacity at review time", async () => {
    const admin_account_id = uuid();
    const owner_account_id = uuid();
    const first_account_id = uuid();
    const second_account_id = uuid();
    const domain = `cap-${uuid().slice(0, 8)}.edu`;
    await createTestAccount(admin_account_id);
    await createTestAccount(owner_account_id);
    await createTestAccount(first_account_id);
    await createTestAccount(second_account_id);
    await markAdmin(admin_account_id);
    await markVerifiedEmail(first_account_id, `first@${domain}`);
    await markVerifiedEmail(second_account_id, `second@${domain}`);

    const overview = await adminProvisionSiteLicense({
      actor_account_id: admin_account_id,
      owner_account_id,
      name: "Capacity Campus",
      organization_name: "Example University",
      allowed_domains: [domain],
      pools: [
        {
          pool_name: "Instructors",
          membership_class: instructorTier,
          seat_count: 1,
          requires_approval: true,
          verification_policy: "manager-approval",
          exclusive_group: "teaching",
        },
      ],
    });
    const instructorPool = overview.pools[0]!;
    const firstRequest = await requestSiteLicensePool({
      account_id: first_account_id,
      package_id: instructorPool.id,
    });
    const secondRequest = await requestSiteLicensePool({
      account_id: second_account_id,
      package_id: instructorPool.id,
    });

    await reviewSiteLicensePoolRequest({
      actor_account_id: owner_account_id,
      request_id: firstRequest.id,
      action: "approve",
    });
    await expect(
      reviewSiteLicensePoolRequest({
        actor_account_id: owner_account_id,
        request_id: secondRequest.id,
        action: "approve",
      }),
    ).rejects.toThrow("no seats available in membership package");
  });
});
