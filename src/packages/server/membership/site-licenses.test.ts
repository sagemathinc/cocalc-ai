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
import dayjs from "dayjs";
import { uuid } from "@cocalc/util/misc";
import {
  claimMembershipPackageSeat,
  claimMembershipPackageSeatWithVerifiedEmailsOnLocalBay,
  listClaimableMembershipPackagesForAccount,
  listMembershipPackageAssignments,
} from "./packages";
import { resolveMembershipForAccount } from "./resolve";
import { runMembershipSideEffectsPass } from "./side-effects";
import { runSiteLicenseAffiliationReleaseMaintenancePass } from "./site-license-affiliation-maintenance";
import {
  adminProvisionSiteLicense,
  getSiteLicenseAffiliationReverificationStatusForAccount,
  getSiteLicenseOverview,
  listSiteLicenseAffiliationReverificationSeats,
  releaseGraceExpiredSiteLicenseAffiliationSeats,
  requestSiteLicensePool,
  refreshSiteLicenseAffiliationVerificationForAccount,
  removeSiteLicenseManager,
  reviewSiteLicensePoolRequest,
  setSiteLicenseManager,
  updateSiteLicense,
  updateSiteLicensePool,
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

  async function setAccountHomeBay(account_id: string, home_bay_id: string) {
    await getPool().query(
      "UPDATE accounts SET home_bay_id=$2 WHERE account_id=$1",
      [account_id, home_bay_id],
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
    const managerNotice = await getPool().query(
      `SELECT t.target_account_id, t.dedupe_key, e.payload_json
         FROM notification_targets t
         JOIN notification_events e ON e.event_id=t.event_id
        WHERE t.dedupe_key=$1`,
      [`site-license-pool-request:${request.id}:created:${owner_account_id}`],
    );
    expect(managerNotice.rows).toEqual([
      expect.objectContaining({
        target_account_id: owner_account_id,
        payload_json: expect.objectContaining({
          title: "New Math Department Launch request",
          request_id: request.id,
          package_id: instructorPool.id,
        }),
      }),
    ]);
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

    await setAccountHomeBay(owner_account_id, "bay-1");
    const approved = await reviewSiteLicensePoolRequest({
      actor_account_id: owner_account_id,
      request_id: request.id,
      action: "approve",
      review_note: "Instructor confirmed.",
    });
    expect(approved.state).toBe("approved");
    const requesterNotice = await getPool().query(
      `SELECT t.target_account_id, t.dedupe_key, e.payload_json
         FROM notification_targets t
         JOIN notification_events e ON e.event_id=t.event_id
        WHERE t.dedupe_key=$1`,
      [
        `site-license-pool-request:${request.id}:approved:${student_account_id}`,
      ],
    );
    expect(requesterNotice.rows).toEqual([
      expect.objectContaining({
        target_account_id: student_account_id,
        payload_json: expect.objectContaining({
          title: "Math Department Launch request approved",
          request_id: request.id,
          package_id: instructorPool.id,
        }),
      }),
    ]);
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

  it("prevents active site license domain overlap", async () => {
    const admin_account_id = uuid();
    const first_owner_account_id = uuid();
    const second_owner_account_id = uuid();
    const domain = `overlap-${uuid().slice(0, 8)}.edu`;
    await createTestAccount(admin_account_id);
    await createTestAccount(first_owner_account_id);
    await createTestAccount(second_owner_account_id);
    await markAdmin(admin_account_id);

    await adminProvisionSiteLicense({
      actor_account_id: admin_account_id,
      owner_account_id: first_owner_account_id,
      name: "Active Campus",
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
      ],
    });

    await expect(
      adminProvisionSiteLicense({
        actor_account_id: admin_account_id,
        owner_account_id: second_owner_account_id,
        name: "Duplicate Campus",
        organization_name: "Other University",
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
        ],
      }),
    ).rejects.toThrow(`site license domain '${domain}' overlaps`);

    await expect(
      adminProvisionSiteLicense({
        actor_account_id: admin_account_id,
        owner_account_id: second_owner_account_id,
        name: "Subdomain Campus",
        organization_name: "Other University",
        allowed_domains: [`dept.${domain}`],
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
      }),
    ).rejects.toThrow(`site license domain 'dept.${domain}' overlaps`);
  });

  it("indexes active site license domains for seed-global conflict checks", async () => {
    const admin_account_id = uuid();
    const owner_account_id = uuid();
    const second_owner_account_id = uuid();
    const domain = `domain-index-${uuid().slice(0, 8)}.edu`;
    const indexOnlyDomain = `index-only-${uuid().slice(0, 8)}.edu`;
    await createTestAccount(admin_account_id);
    await createTestAccount(owner_account_id);
    await createTestAccount(second_owner_account_id);
    await markAdmin(admin_account_id);

    const overview = await adminProvisionSiteLicense({
      actor_account_id: admin_account_id,
      owner_account_id,
      name: "Indexed Campus",
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
      ],
    });

    await expect(
      getPool().query(
        `SELECT domain
           FROM site_license_domains
          WHERE site_license_id=$1
          ORDER BY domain`,
        [overview.site_license.id],
      ),
    ).resolves.toMatchObject({
      rows: [{ domain }],
    });

    await getPool().query(
      `INSERT INTO site_license_domains
          (site_license_id, domain, starts_at, expires_at)
       VALUES ($1, $2, NULL, NULL)`,
      [uuid(), indexOnlyDomain],
    );

    await expect(
      adminProvisionSiteLicense({
        actor_account_id: admin_account_id,
        owner_account_id: second_owner_account_id,
        name: "Index Conflict Campus",
        organization_name: "Other University",
        allowed_domains: [`dept.${indexOnlyDomain}`],
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
      }),
    ).rejects.toThrow(`site license domain 'dept.${indexOnlyDomain}' overlaps`);
  });

  it("updates site-license pool domains through the seed domain index", async () => {
    const admin_account_id = uuid();
    const owner_account_id = uuid();
    const second_owner_account_id = uuid();
    const originalDomain = `edit-original-${uuid().slice(0, 8)}.edu`;
    const updatedDomain = `edit-updated-${uuid().slice(0, 8)}.edu`;
    await createTestAccount(admin_account_id);
    await createTestAccount(owner_account_id);
    await createTestAccount(second_owner_account_id);
    await markAdmin(admin_account_id);

    const overview = await adminProvisionSiteLicense({
      actor_account_id: admin_account_id,
      owner_account_id,
      name: "Editable Campus",
      organization_name: "Example University",
      allowed_domains: [originalDomain],
      pools: [
        {
          pool_name: "Students",
          membership_class: studentTier,
          seat_count: 20,
          requires_approval: false,
          verification_policy: "email-domain",
          exclusive_group: "teaching",
          allowed_domains: [originalDomain],
        },
      ],
    });

    await updateSiteLicensePool({
      actor_account_id: owner_account_id,
      package_id: overview.pools[0].id,
      seat_count: 25,
      allowed_domains: [updatedDomain],
    });

    await expect(
      getPool().query(
        `SELECT domain
           FROM site_license_domains
          WHERE site_license_id=$1
          ORDER BY domain`,
        [overview.site_license.id],
      ),
    ).resolves.toMatchObject({
      rows: [{ domain: originalDomain }, { domain: updatedDomain }],
    });

    await expect(
      adminProvisionSiteLicense({
        actor_account_id: admin_account_id,
        owner_account_id: second_owner_account_id,
        name: "Conflict Campus",
        organization_name: "Other University",
        allowed_domains: [updatedDomain],
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
      }),
    ).rejects.toThrow(`site license domain '${updatedDomain}' overlaps`);
  });

  it("updates site-license settings and managers", async () => {
    const admin_account_id = uuid();
    const owner_account_id = uuid();
    const manager_account_id = uuid();
    const originalDomain = `settings-original-${uuid().slice(0, 8)}.edu`;
    const updatedDomain = `settings-updated-${uuid().slice(0, 8)}.edu`;
    await createTestAccount(admin_account_id);
    await createTestAccount(owner_account_id);
    await createTestAccount(manager_account_id);
    await markAdmin(admin_account_id);

    const overview = await adminProvisionSiteLicense({
      actor_account_id: admin_account_id,
      owner_account_id,
      name: "Settings Campus",
      organization_name: "Example University",
      allowed_domains: [originalDomain],
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

    const updated = await updateSiteLicense({
      actor_account_id: owner_account_id,
      site_license_id: overview.site_license.id,
      name: "Updated Settings Campus",
      organization_name: "Updated University",
      allowed_domains: [updatedDomain],
      terms_version_label: "v2",
    });
    expect(updated.site_license).toMatchObject({
      name: "Updated Settings Campus",
      organization_name: "Updated University",
      allowed_domains: [updatedDomain],
      terms_version_label: "v2",
    });

    const withManager = await setSiteLicenseManager({
      actor_account_id: owner_account_id,
      site_license_id: overview.site_license.id,
      target_account_id: manager_account_id,
      role: "manager",
    });
    expect(withManager.managers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          account_id: manager_account_id,
          role: "manager",
        }),
      ]),
    );

    const withoutManager = await removeSiteLicenseManager({
      actor_account_id: owner_account_id,
      site_license_id: overview.site_license.id,
      target_account_id: manager_account_id,
    });
    expect(
      withoutManager.managers.some(
        (manager) => manager.account_id === manager_account_id,
      ),
    ).toBe(false);
    await expect(
      removeSiteLicenseManager({
        actor_account_id: owner_account_id,
        site_license_id: overview.site_license.id,
        target_account_id: owner_account_id,
      }),
    ).rejects.toThrow("cannot remove the last site-license owner");
  });

  it("allows a new site license to reuse an expired site license domain", async () => {
    const admin_account_id = uuid();
    const expired_owner_account_id = uuid();
    const active_owner_account_id = uuid();
    const domain = `expired-overlap-${uuid().slice(0, 8)}.edu`;
    await createTestAccount(admin_account_id);
    await createTestAccount(expired_owner_account_id);
    await createTestAccount(active_owner_account_id);
    await markAdmin(admin_account_id);

    await adminProvisionSiteLicense({
      actor_account_id: admin_account_id,
      owner_account_id: expired_owner_account_id,
      name: "Expired Campus",
      organization_name: "Example University",
      allowed_domains: [domain],
      expires_at: dayjs().subtract(1, "day").toDate(),
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

    const overview = await adminProvisionSiteLicense({
      actor_account_id: admin_account_id,
      owner_account_id: active_owner_account_id,
      name: "Replacement Campus",
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
      ],
    });
    expect(overview.site_license.allowed_domains).toEqual([domain]);
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

  it("classifies site-license affiliation reverification status", async () => {
    const admin_account_id = uuid();
    const owner_account_id = uuid();
    const current_account_id = uuid();
    const due_account_id = uuid();
    const expired_account_id = uuid();
    const instructor_account_id = uuid();
    const domain = `verify-${uuid().slice(0, 8)}.edu`;
    await createTestAccount(admin_account_id);
    await createTestAccount(owner_account_id);
    await createTestAccount(current_account_id);
    await createTestAccount(due_account_id);
    await createTestAccount(expired_account_id);
    await createTestAccount(instructor_account_id);
    await markAdmin(admin_account_id);
    await markVerifiedEmail(current_account_id, `current@${domain}`);
    await markVerifiedEmail(due_account_id, `due@${domain}`);
    await markVerifiedEmail(expired_account_id, `expired@${domain}`);
    await markVerifiedEmail(instructor_account_id, `instructor@${domain}`);

    const overview = await adminProvisionSiteLicense({
      actor_account_id: admin_account_id,
      owner_account_id,
      name: "Reverification Campus",
      organization_name: "Example University",
      allowed_domains: [domain],
      pools: [
        {
          pool_name: "Students",
          membership_class: studentTier,
          seat_count: 10,
          requires_approval: false,
          verification_policy: "email-domain",
          exclusive_group: "teaching",
          affiliation_reverification_days: 30,
          affiliation_reverification_grace_days: 10,
        },
        {
          pool_name: "Instructors",
          membership_class: instructorTier,
          seat_count: 10,
          requires_approval: true,
          verification_policy: "manager-approval",
          exclusive_group: "teaching",
          affiliation_reverification_days: 30,
          affiliation_reverification_grace_days: 10,
        },
      ],
    });
    const studentPool = overview.pools.find(
      (pool) => pool.pool_name === "Students",
    )!;
    const instructorPool = overview.pools.find(
      (pool) => pool.pool_name === "Instructors",
    )!;

    await claimMembershipPackageSeat({
      account_id: current_account_id,
      package_id: studentPool.id,
    });
    await claimMembershipPackageSeat({
      account_id: due_account_id,
      package_id: studentPool.id,
    });
    await claimMembershipPackageSeat({
      account_id: expired_account_id,
      package_id: studentPool.id,
    });

    const instructorRequest = await requestSiteLicensePool({
      account_id: instructor_account_id,
      package_id: instructorPool.id,
    });
    await reviewSiteLicensePoolRequest({
      actor_account_id: owner_account_id,
      request_id: instructorRequest.id,
      action: "approve",
    });

    async function setVerifiedAt(account_id: string, verified_at: string) {
      await getPool().query(
        `UPDATE membership_package_assignments
            SET metadata=jsonb_set(
                  COALESCE(metadata, '{}'::jsonb),
                  '{affiliation_verified_at}',
                  to_jsonb($3::text),
                  true
                )
          WHERE package_id=$1
            AND account_id=$2`,
        [studentPool.id, account_id, verified_at],
      );
      await getPool().query(
        `UPDATE membership_grants
            SET metadata=jsonb_set(
                  COALESCE(metadata, '{}'::jsonb),
                  '{affiliation_verified_at}',
                  to_jsonb($3::text),
                  true
                )
          WHERE package_id=$1
            AND account_id=$2`,
        [studentPool.id, account_id, verified_at],
      );
    }
    await setVerifiedAt(current_account_id, "2026-05-01T00:00:00.000Z");
    await setVerifiedAt(due_account_id, "2026-04-15T00:00:00.000Z");
    await setVerifiedAt(expired_account_id, "2026-04-01T00:00:00.000Z");

    const seats = await listSiteLicenseAffiliationReverificationSeats({
      account_id: owner_account_id,
      site_license_id: overview.site_license.id,
      now: new Date("2026-05-20T00:00:00.000Z"),
    });
    expect(seats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          account_id: current_account_id,
          state: "current",
          verification_policy: "email-domain",
          matched_email_address: `current@${domain}`,
          affiliation_verified_at: new Date("2026-05-01T00:00:00.000Z"),
          reverification_due_at: new Date("2026-05-31T00:00:00.000Z"),
        }),
        expect.objectContaining({
          account_id: due_account_id,
          state: "pending_reverification",
          reverification_due_at: new Date("2026-05-15T00:00:00.000Z"),
          reverification_grace_expires_at: new Date("2026-05-25T00:00:00.000Z"),
        }),
        expect.objectContaining({
          account_id: expired_account_id,
          state: "grace_expired",
          reverification_due_at: new Date("2026-05-01T00:00:00.000Z"),
          reverification_grace_expires_at: new Date("2026-05-11T00:00:00.000Z"),
        }),
        expect.objectContaining({
          account_id: instructor_account_id,
          state: "current",
          verification_policy: "manager-approval",
          matched_email_address: `instructor@${domain}`,
        }),
      ]),
    );
    await expect(
      listSiteLicenseAffiliationReverificationSeats({
        account_id: owner_account_id,
        site_license_id: overview.site_license.id,
        states: ["pending_reverification", "grace_expired"],
        now: new Date("2026-05-20T00:00:00.000Z"),
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        account_id: expired_account_id,
        state: "grace_expired",
      }),
      expect.objectContaining({
        account_id: due_account_id,
        state: "pending_reverification",
      }),
    ]);

    await setAccountHomeBay(owner_account_id, "bay-1");
    const released = await releaseGraceExpiredSiteLicenseAffiliationSeats({
      account_id: owner_account_id,
      site_license_id: overview.site_license.id,
      now: new Date("2026-05-20T00:00:00.000Z"),
    });
    expect(released).toEqual([
      expect.objectContaining({
        account_id: expired_account_id,
        state: "grace_expired",
      }),
    ]);
    expect(
      await listMembershipPackageAssignments({
        package_id: studentPool.id,
        include_revoked: false,
      }),
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ account_id: expired_account_id }),
      ]),
    );
    expect(
      await listMembershipPackageAssignments({
        package_id: studentPool.id,
        include_revoked: false,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ account_id: current_account_id }),
        expect.objectContaining({ account_id: due_account_id }),
      ]),
    );
    const refreshedOverview = await getSiteLicenseOverview({
      account_id: owner_account_id,
      site_license_id: overview.site_license.id,
    });
    expect(refreshedOverview.recent_audit_events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "seat-released-after-reverification-grace",
          actor_account_id: owner_account_id,
          target_account_id: expired_account_id,
          package_id: studentPool.id,
          metadata: expect.objectContaining({
            assignment_id: expect.any(String),
            exclusive_group: "teaching",
            verification_policy: "email-domain",
            released_at: "2026-05-20T00:00:00.000Z",
          }),
        }),
      ]),
    );
  });

  it("refreshes email-domain site-license affiliation verification", async () => {
    const admin_account_id = uuid();
    const owner_account_id = uuid();
    const pending_account_id = uuid();
    const expired_account_id = uuid();
    const wrong_domain_account_id = uuid();
    const instructor_account_id = uuid();
    const domain = `refresh-${uuid().slice(0, 8)}.edu`;
    await createTestAccount(admin_account_id);
    await createTestAccount(owner_account_id);
    await createTestAccount(pending_account_id);
    await createTestAccount(expired_account_id);
    await createTestAccount(wrong_domain_account_id);
    await createTestAccount(instructor_account_id);
    await markAdmin(admin_account_id);
    await markVerifiedEmail(pending_account_id, `pending@${domain}`);
    await markVerifiedEmail(expired_account_id, `expired@${domain}`);
    await markVerifiedEmail(wrong_domain_account_id, `wrong@${domain}`);
    await markVerifiedEmail(instructor_account_id, `instructor@${domain}`);

    const overview = await adminProvisionSiteLicense({
      actor_account_id: admin_account_id,
      owner_account_id,
      name: "Refresh Campus",
      organization_name: "Example University",
      allowed_domains: [domain],
      pools: [
        {
          pool_name: "Students",
          membership_class: studentTier,
          seat_count: 10,
          requires_approval: false,
          verification_policy: "email-domain",
          exclusive_group: "teaching",
          affiliation_reverification_days: 30,
          affiliation_reverification_grace_days: 10,
        },
        {
          pool_name: "Instructors",
          membership_class: instructorTier,
          seat_count: 10,
          requires_approval: true,
          verification_policy: "manager-approval",
          exclusive_group: "teaching",
          affiliation_reverification_days: 30,
          affiliation_reverification_grace_days: 10,
        },
      ],
    });
    const studentPool = overview.pools.find(
      (pool) => pool.pool_name === "Students",
    )!;
    const instructorPool = overview.pools.find(
      (pool) => pool.pool_name === "Instructors",
    )!;

    await claimMembershipPackageSeat({
      account_id: pending_account_id,
      package_id: studentPool.id,
    });
    await claimMembershipPackageSeat({
      account_id: expired_account_id,
      package_id: studentPool.id,
    });
    await claimMembershipPackageSeat({
      account_id: wrong_domain_account_id,
      package_id: studentPool.id,
    });
    const instructorRequest = await requestSiteLicensePool({
      account_id: instructor_account_id,
      package_id: instructorPool.id,
    });
    await reviewSiteLicensePoolRequest({
      actor_account_id: owner_account_id,
      request_id: instructorRequest.id,
      action: "approve",
    });

    async function setVerifiedAt(account_id: string, verified_at: string) {
      await getPool().query(
        `UPDATE membership_package_assignments
            SET metadata=jsonb_set(
                  COALESCE(metadata, '{}'::jsonb),
                  '{affiliation_verified_at}',
                  to_jsonb($3::text),
                  true
                )
          WHERE package_id=$1
            AND account_id=$2`,
        [studentPool.id, account_id, verified_at],
      );
      await getPool().query(
        `UPDATE membership_grants
            SET metadata=jsonb_set(
                  COALESCE(metadata, '{}'::jsonb),
                  '{affiliation_verified_at}',
                  to_jsonb($3::text),
                  true
                )
          WHERE package_id=$1
            AND account_id=$2`,
        [studentPool.id, account_id, verified_at],
      );
    }
    await setVerifiedAt(pending_account_id, "2026-04-15T00:00:00.000Z");
    await setVerifiedAt(expired_account_id, "2026-04-01T00:00:00.000Z");
    await setVerifiedAt(wrong_domain_account_id, "2026-04-15T00:00:00.000Z");
    await markVerifiedEmail(wrong_domain_account_id, `wrong@example.com`);

    await expect(
      getSiteLicenseAffiliationReverificationStatusForAccount({
        account_id: pending_account_id,
        now: new Date("2026-05-20T00:00:00.000Z"),
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        pending_count: 1,
        grace_expired_count: 0,
        seats: [
          expect.objectContaining({
            account_id: pending_account_id,
            state: "pending_reverification",
            organization_name: "Example University",
            site_license_owner_account_id: owner_account_id,
            pool_name: "Students",
            can_refresh_with_verified_email: true,
          }),
        ],
      }),
    );

    await expect(
      refreshSiteLicenseAffiliationVerificationForAccount({
        account_id: pending_account_id,
        site_license_id: overview.site_license.id,
        now: new Date("2026-05-20T00:00:00.000Z"),
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        account_id: pending_account_id,
        state: "current",
        matched_email_address: `pending@${domain}`,
        affiliation_verified_at: new Date("2026-05-20T00:00:00.000Z"),
        reverification_due_at: new Date("2026-06-19T00:00:00.000Z"),
      }),
    ]);
    await expect(
      refreshSiteLicenseAffiliationVerificationForAccount({
        account_id: expired_account_id,
        site_license_id: overview.site_license.id,
        now: new Date("2026-05-20T00:00:00.000Z"),
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        account_id: expired_account_id,
        state: "current",
        affiliation_verified_at: new Date("2026-05-20T00:00:00.000Z"),
      }),
    ]);
    await runMembershipSideEffectsPass({ limit: 100 });
    await expect(
      getSiteLicenseAffiliationReverificationStatusForAccount({
        account_id: pending_account_id,
        now: new Date("2026-05-20T00:00:00.000Z"),
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        pending_count: 0,
        grace_expired_count: 0,
        seats: [
          expect.objectContaining({
            account_id: pending_account_id,
            state: "current",
            affiliation_verified_at: new Date("2026-05-20T00:00:00.000Z"),
          }),
        ],
      }),
    );
    await expect(
      refreshSiteLicenseAffiliationVerificationForAccount({
        account_id: wrong_domain_account_id,
        site_license_id: overview.site_license.id,
        now: new Date("2026-05-20T00:00:00.000Z"),
      }),
    ).resolves.toEqual([]);
    await expect(
      refreshSiteLicenseAffiliationVerificationForAccount({
        account_id: instructor_account_id,
        site_license_id: overview.site_license.id,
        now: new Date("2026-05-20T00:00:00.000Z"),
      }),
    ).resolves.toEqual([]);

    const seats = await listSiteLicenseAffiliationReverificationSeats({
      account_id: owner_account_id,
      site_license_id: overview.site_license.id,
      now: new Date("2026-05-20T00:00:00.000Z"),
    });
    expect(seats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          account_id: pending_account_id,
          state: "current",
        }),
        expect.objectContaining({
          account_id: expired_account_id,
          state: "current",
        }),
        expect.objectContaining({
          account_id: wrong_domain_account_id,
          state: "pending_reverification",
          affiliation_verified_at: new Date("2026-04-15T00:00:00.000Z"),
        }),
        expect.objectContaining({
          account_id: instructor_account_id,
          state: "current",
          verification_policy: "manager-approval",
        }),
      ]),
    );
    const refreshedOverview = await getSiteLicenseOverview({
      account_id: owner_account_id,
      site_license_id: overview.site_license.id,
    });
    expect(refreshedOverview.recent_audit_events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "seat-affiliation-reverified",
          actor_account_id: pending_account_id,
          target_account_id: pending_account_id,
          package_id: studentPool.id,
          metadata: expect.objectContaining({
            assignment_id: expect.any(String),
            previous_state: "pending_reverification",
            verification_policy: "email-domain",
            affiliation_verified_at: "2026-05-20T00:00:00.000Z",
          }),
        }),
        expect.objectContaining({
          action: "seat-affiliation-reverified",
          actor_account_id: expired_account_id,
          target_account_id: expired_account_id,
          package_id: studentPool.id,
          metadata: expect.objectContaining({
            previous_state: "grace_expired",
          }),
        }),
      ]),
    );
  });

  it("releases grace-expired site-license seats from maintenance", async () => {
    const admin_account_id = uuid();
    const owner_account_id = uuid();
    const expired_account_id = uuid();
    const current_account_id = uuid();
    const domain = `maintenance-${uuid().slice(0, 8)}.edu`;
    await createTestAccount(admin_account_id);
    await createTestAccount(owner_account_id);
    await createTestAccount(expired_account_id);
    await createTestAccount(current_account_id);
    await markAdmin(admin_account_id);
    await markVerifiedEmail(expired_account_id, `expired@${domain}`);
    await markVerifiedEmail(current_account_id, `current@${domain}`);

    const overview = await adminProvisionSiteLicense({
      actor_account_id: admin_account_id,
      owner_account_id,
      name: "Maintenance Campus",
      organization_name: "Example University",
      allowed_domains: [domain],
      pools: [
        {
          pool_name: "Students",
          membership_class: studentTier,
          seat_count: 10,
          requires_approval: false,
          verification_policy: "email-domain",
          exclusive_group: "teaching",
          affiliation_reverification_days: 30,
          affiliation_reverification_grace_days: 10,
        },
      ],
    });
    const studentPool = overview.pools[0]!;

    await claimMembershipPackageSeat({
      account_id: expired_account_id,
      package_id: studentPool.id,
    });
    await claimMembershipPackageSeat({
      account_id: current_account_id,
      package_id: studentPool.id,
    });
    await getPool().query(
      `UPDATE membership_package_assignments
          SET metadata=jsonb_set(
                COALESCE(metadata, '{}'::jsonb),
                '{affiliation_verified_at}',
                to_jsonb(CASE
                  WHEN account_id=$2 THEN '2026-04-01T00:00:00.000Z'
                  ELSE '2026-05-01T00:00:00.000Z'
                END::text),
                true
              )
        WHERE package_id=$1
          AND account_id IN ($2, $3)`,
      [studentPool.id, expired_account_id, current_account_id],
    );

    await expect(
      runSiteLicenseAffiliationReleaseMaintenancePass({
        now: new Date("2026-05-20T00:00:00.000Z"),
        site_license_limit: 10_000,
        seat_limit: 100,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        scanned_site_licenses: expect.any(Number),
        site_licenses_with_releases: expect.any(Number),
        released_seats: expect.any(Number),
        failed_site_licenses: 0,
      }),
    );
    expect(
      await listMembershipPackageAssignments({
        package_id: studentPool.id,
        include_revoked: false,
      }),
    ).toEqual([
      expect.objectContaining({
        account_id: current_account_id,
      }),
    ]);
    const refreshedOverview = await getSiteLicenseOverview({
      account_id: owner_account_id,
      site_license_id: overview.site_license.id,
    });
    expect(refreshedOverview.recent_audit_events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "seat-released-after-reverification-grace",
          actor_account_id: null,
          target_account_id: expired_account_id,
          package_id: studentPool.id,
          metadata: expect.objectContaining({
            released_by: "site-license-affiliation-maintenance",
            released_at: "2026-05-20T00:00:00.000Z",
          }),
        }),
      ]),
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
