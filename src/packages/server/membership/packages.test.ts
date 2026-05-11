/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

import dayjs from "dayjs";

let createInterBayAccountLocalClientMock: jest.Mock;
let getInterBayFabricClientMock: jest.Mock;
let projectControlSetUsageAccountMock: jest.Mock;

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

jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  __esModule: true,
  getInterBayBridge: jest.fn(() => ({
    projectControl: jest.fn((dest_bay: string) => ({
      setUsageAccount: (opts: any) =>
        projectControlSetUsageAccountMock(dest_bay, opts),
    })),
  })),
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
import { getMembershipClaimIdentity } from "./claim-directory";
import {
  assignMembershipPackageSeat,
  claimMembershipPackageSeat,
  listClaimableMembershipPackagesForAccount,
  listMembershipPackageDetailsForOwner,
  resolveMembershipPackageQuote,
  revokeMembershipPackageSeat,
} from "./packages";
import {
  resetMembershipSideEffectsMaintenanceStateForTests,
  runMembershipSideEffectsPass,
} from "./side-effects";

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);

afterAll(after);

describe("membership packages", () => {
  const teamTier = `team-tier-${uuid()}`;
  const courseTier = `course-tier-${uuid()}`;
  let remoteGrantUpserts: Array<{ dest_bay: string; grant: any }>;
  let remoteGrantRevocations: Array<{ dest_bay: string; opts: any }>;
  let remoteProjectUsageUpdates: Array<{ dest_bay: string; opts: any }>;
  const clusterBayIdsEnv = process.env.COCALC_CLUSTER_BAY_IDS;

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
    await createTestMembershipTier({
      id: courseTier,
      priority: 10,
      course_store_visible: true,
      course_price: 25,
      course_duration_days: 122,
      course_grace_days: 14,
    });
  });

  async function listOutboxKinds(): Promise<string[]> {
    const result = await getPool("medium").query<{ effect_kind: string }>(
      `SELECT effect_kind
       FROM membership_side_effects_outbox
       WHERE desired_revision > applied_revision
       ORDER BY effect_kind, effect_key`,
    );
    return result.rows.map((row) => row.effect_kind);
  }

  async function listOutboxKindsForAssignment(
    assignment_id: string,
  ): Promise<string[]> {
    const result = await getPool("medium").query<{ effect_kind: string }>(
      `SELECT effect_kind
       FROM membership_side_effects_outbox
       WHERE assignment_id = $1
         AND desired_revision > applied_revision
       ORDER BY effect_kind, effect_key`,
      [assignment_id],
    );
    return result.rows.map((row) => row.effect_kind);
  }

  beforeEach(async () => {
    remoteGrantUpserts = [];
    remoteGrantRevocations = [];
    remoteProjectUsageUpdates = [];
    resetMembershipSideEffectsMaintenanceStateForTests();
    await getPool("medium").query("DELETE FROM membership_side_effects_outbox");
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
        getClaimableMembershipPackages: jest.fn(async () => []),
        claimMembershipPackageSeat: jest.fn(async () => {
          throw new Error("unexpected remote claim");
        }),
      }),
    );
    projectControlSetUsageAccountMock = jest.fn(
      async (dest_bay: string, opts: any) => {
        remoteProjectUsageUpdates.push({ dest_bay, opts });
        return { updated: true };
      },
    );
  });

  afterEach(() => {
    if (clusterBayIdsEnv === undefined) {
      delete process.env.COCALC_CLUSTER_BAY_IDS;
    } else {
      process.env.COCALC_CLUSTER_BAY_IDS = clusterBayIdsEnv;
    }
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

  it("marks self-purchased course package grants distinctly", async () => {
    const student_account_id = uuid();
    await createTestAccount(student_account_id);

    const package_id = await createTestMembershipPackage({
      owner_account_id: student_account_id,
      kind: "course",
      membership_class: courseTier,
      seat_count: 1,
      metadata: {
        direct_student_purchase: true,
        course_project_id: uuid(),
      },
    });

    const assignment = await assignMembershipPackageSeat({
      package_id,
      account_id: student_account_id,
      assigned_by_account_id: student_account_id,
      metadata: {
        direct_student_purchase: true,
        grant_source: "student-course-purchase",
      },
    });
    expect(assignment.grant_source).toBe("student-course-purchase");

    const membership = await resolveMembershipForAccount(student_account_id);
    expect(membership.class).toBe(courseTier);
    expect(membership.grant_package_id).toBe(package_id);
    expect(membership.grant_source).toBe("student-course-purchase");
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

  it("quotes course seats from the selected course-visible membership tier", async () => {
    const course_project_id = uuid();
    await getPool("medium").query(
      `INSERT INTO projects (project_id, title, users, course, last_edited)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, NOW())`,
      [
        course_project_id,
        "Math 101",
        "{}",
        JSON.stringify({
          type: "student",
          project_id: course_project_id,
          path: "math101.course",
        }),
      ],
    );

    const quote = await resolveMembershipPackageQuote({
      type: "membership-package",
      kind: "course",
      membership_class: courseTier,
      course_project_id,
      seat_count: 3,
    });

    expect(quote.kind).toBe("course");
    expect(quote.membership_class).toBe(courseTier);
    expect(quote.seat_price).toBe(25);
    expect(quote.total_price).toBe(75);
    expect(quote.metadata).toMatchObject({
      course_project_id,
      course_path: "math101.course",
      course_title: "Math 101",
      course_duration_days: 122,
      course_grace_days: 14,
      seat_price: 25,
    });
    expect(dayjs(quote.expires_at).diff(dayjs(quote.starts_at), "day")).toBe(
      122,
    );
  });

  it("allows expanding an existing package without resupplying the package kind", async () => {
    const owner_account_id = uuid();
    await createTestAccount(owner_account_id);

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

    const quote = await resolveMembershipPackageQuote({
      type: "membership-package",
      membership_class: teamTier,
      seat_count: 1,
      package_id,
    });

    expect(quote.package_id).toBe(package_id);
    expect(quote.kind).toBe("team");
    expect(quote.total_price).toBe(20);
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

  it("routes course usage attribution writes to the project-owning bay", async () => {
    const owner_account_id = uuid();
    const student_account_id = uuid();
    const project_id = uuid();
    await createTestAccount(owner_account_id);
    await createTestAccount(student_account_id);

    await getPool("medium").query(
      `INSERT INTO projects (project_id, title, users, last_edited, usage_account_id, owning_bay_id)
       VALUES ($1, $2, $3::jsonb, NOW(), NULL, $4)`,
      [
        project_id,
        "Remote Student Project",
        JSON.stringify({
          [owner_account_id]: { group: "owner" },
        }),
        "bay-2",
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

    expect(remoteProjectUsageUpdates).toHaveLength(0);
    expect(await listOutboxKinds()).toContain("project-usage-sync");
    await runMembershipSideEffectsPass();
    expect(remoteProjectUsageUpdates).toHaveLength(1);
    expect(remoteProjectUsageUpdates[0]).toMatchObject({
      dest_bay: "bay-2",
      opts: {
        project_id,
        usage_account_id: student_account_id,
        epoch: 0,
      },
    });

    await revokeMembershipPackageSeat({
      package_id,
      account_id: student_account_id,
    });

    expect(remoteProjectUsageUpdates).toHaveLength(1);
    await runMembershipSideEffectsPass();
    expect(remoteProjectUsageUpdates).toHaveLength(2);
    expect(remoteProjectUsageUpdates[1]).toMatchObject({
      dest_bay: "bay-2",
      opts: {
        project_id,
        usage_account_id: null,
        expected_current_usage_account_id: student_account_id,
        epoch: 0,
      },
    });
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

  it("routes reserved course-seat claims to the project-owning bay", async () => {
    const owner_account_id = uuid();
    const student_account_id = uuid();
    const project_id = uuid();
    await createTestAccount(owner_account_id);
    await createTestAccount(student_account_id);
    await markVerifiedEmail(student_account_id, "remote-claim@example.com");

    await getPool("medium").query(
      `INSERT INTO projects (project_id, title, users, last_edited, usage_account_id, owning_bay_id)
       VALUES ($1, $2, $3::jsonb, NOW(), NULL, $4)`,
      [
        project_id,
        "Remote Reserved Student Project",
        JSON.stringify({
          [owner_account_id]: { group: "owner" },
        }),
        "bay-2",
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
      email_address: "remote-claim@example.com",
      assigned_by_account_id: owner_account_id,
      metadata: {
        project_id,
      },
    });

    await claimMembershipPackageSeat({
      package_id,
      account_id: student_account_id,
    });

    expect(remoteProjectUsageUpdates).toHaveLength(0);
    await runMembershipSideEffectsPass();
    expect(remoteProjectUsageUpdates).toHaveLength(1);
    expect(remoteProjectUsageUpdates[0]).toMatchObject({
      dest_bay: "bay-2",
      opts: {
        project_id,
        usage_account_id: student_account_id,
        epoch: 0,
      },
    });
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
    expect(remoteGrantUpserts).toHaveLength(0);
    expect(await listOutboxKinds()).toContain("grant-sync");
    await runMembershipSideEffectsPass();
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

  it("dedupes site-license claims across plus aliases until the prior claim is revoked", async () => {
    const owner_account_id = uuid();
    const first_account_id = uuid();
    const second_account_id = uuid();
    const domain = `dept-${uuid().slice(0, 8)}.edu`;
    await createTestAccount(owner_account_id);
    await createTestAccount(first_account_id);
    await createTestAccount(second_account_id);
    await markVerifiedEmail(first_account_id, `ada@${domain}`);
    await markVerifiedEmail(second_account_id, `ada+lab@${domain}`);

    const first_site_package_id = await createTestMembershipPackage({
      owner_account_id,
      kind: "site",
      membership_class: teamTier,
      seat_count: 3,
      metadata: {
        interval: "year",
        seat_price: 100,
        allowed_domains: [domain],
      },
    });
    const second_site_package_id = await createTestMembershipPackage({
      owner_account_id,
      kind: "site",
      membership_class: teamTier,
      seat_count: 3,
      metadata: {
        interval: "year",
        seat_price: 100,
        allowed_domains: [domain],
      },
    });

    const firstClaimables = await listClaimableMembershipPackagesForAccount({
      account_id: first_account_id,
    });
    expect(firstClaimables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ package_id: first_site_package_id }),
        expect.objectContaining({ package_id: second_site_package_id }),
      ]),
    );

    const firstClaim = await claimMembershipPackageSeat({
      package_id: first_site_package_id,
      account_id: first_account_id,
    });
    expect(firstClaim.metadata?.claim_identity_key).toBe(`ada@${domain}`);
    expect(await listOutboxKindsForAssignment(firstClaim.id)).toContain(
      "claim-identity-sync",
    );
    expect(
      await getMembershipClaimIdentity({
        scope_key: `institutional-domains:${domain}`,
        canonical_identity: `ada@${domain}`,
      }),
    ).toEqual(
      expect.objectContaining({
        account_id: first_account_id,
        state: "pending",
      }),
    );
    await runMembershipSideEffectsPass();
    expect(
      await getMembershipClaimIdentity({
        scope_key: `institutional-domains:${domain}`,
        canonical_identity: `ada@${domain}`,
      }),
    ).toEqual(
      expect.objectContaining({
        account_id: first_account_id,
        state: "active",
      }),
    );

    const secondClaimables = await listClaimableMembershipPackagesForAccount({
      account_id: second_account_id,
    });
    expect(
      secondClaimables.some(
        (claimable) =>
          claimable.package_id === first_site_package_id ||
          claimable.package_id === second_site_package_id,
      ),
    ).toBe(false);
    await expect(
      claimMembershipPackageSeat({
        package_id: second_site_package_id,
        account_id: second_account_id,
      }),
    ).rejects.toThrow(/institutional|no claimable seat/i);

    await revokeMembershipPackageSeat({
      package_id: first_site_package_id,
      account_id: first_account_id,
    });

    const stillBlockedClaimables =
      await listClaimableMembershipPackagesForAccount({
        account_id: second_account_id,
      });
    expect(
      stillBlockedClaimables.some(
        (claimable) => claimable.package_id === second_site_package_id,
      ),
    ).toBe(false);

    await runMembershipSideEffectsPass();

    const releasedClaimables = await listClaimableMembershipPackagesForAccount({
      account_id: second_account_id,
    });
    expect(releasedClaimables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          package_id: second_site_package_id,
          matched_email_address: `ada+lab@${domain}`,
        }),
      ]),
    );
  });

  it("discovers remote claimable site packages across the cluster", async () => {
    process.env.COCALC_CLUSTER_BAY_IDS = "bay-0,bay-1";
    const claimant_account_id = uuid();
    const remote_package_id = uuid();
    const verifiedEmail = `ada-${uuid()}@example.edu`;
    await createTestAccount(claimant_account_id);
    await markVerifiedEmail(claimant_account_id, verifiedEmail);

    createInterBayAccountLocalClientMock = jest.fn(
      ({ dest_bay }: { dest_bay: string }) => ({
        upsertMembershipGrant: jest.fn(async (grant) => {
          remoteGrantUpserts.push({ dest_bay, grant });
          return { grant_id: grant.id };
        }),
        revokeMembershipGrant: jest.fn(async (opts) => {
          remoteGrantRevocations.push({ dest_bay, opts });
        }),
        getClaimableMembershipPackages: jest.fn(
          async ({
            account_id,
            verified_email_addresses,
          }: {
            account_id: string;
            verified_email_addresses: string[];
          }) => {
            expect(dest_bay).toBe("bay-1");
            expect(account_id).toBe(claimant_account_id);
            expect(verified_email_addresses).toEqual([verifiedEmail]);
            return [
              {
                package_id: remote_package_id,
                kind: "site",
                membership_class: teamTier,
                owner_account_id: uuid(),
                starts_at: new Date("2026-05-07T00:00:00.000Z"),
                expires_at: null,
                available_seat_count: 1,
                matched_email_address: verifiedEmail,
                reason: "domain-match",
                metadata: { allowed_domains: ["example.edu"] },
              },
            ];
          },
        ),
        claimMembershipPackageSeat: jest.fn(async () => {
          throw new Error("unexpected remote claim");
        }),
      }),
    );

    const claimables = await listClaimableMembershipPackagesForAccount({
      account_id: claimant_account_id,
    });
    expect(claimables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          package_id: remote_package_id,
          kind: "site",
          matched_email_address: verifiedEmail,
          reason: "domain-match",
        }),
      ]),
    );
  });

  it("forwards remote claims to the package-owning bay with verified emails", async () => {
    process.env.COCALC_CLUSTER_BAY_IDS = "bay-0,bay-1";
    const claimant_account_id = uuid();
    const remote_package_id = uuid();
    const verifiedEmail = `ada-${uuid()}@example.edu`;
    const remoteAssignment = {
      id: uuid(),
      package_id: remote_package_id,
      account_id: claimant_account_id,
      email_address: verifiedEmail,
      assigned_by_account_id: uuid(),
      assigned_at: new Date("2026-05-07T00:00:00.000Z"),
      revoked_at: undefined,
      metadata: {
        claimed_from_domain: "example.edu",
      },
      grant_id: uuid(),
      grant_source: "site-license",
      grant_purchase_id: null,
    };
    await createTestAccount(claimant_account_id);
    await markVerifiedEmail(claimant_account_id, verifiedEmail);

    const remoteClaimMock = jest.fn(async () => remoteAssignment);
    createInterBayAccountLocalClientMock = jest.fn(
      ({ dest_bay }: { dest_bay: string }) => ({
        upsertMembershipGrant: jest.fn(async (grant) => {
          remoteGrantUpserts.push({ dest_bay, grant });
          return { grant_id: grant.id };
        }),
        revokeMembershipGrant: jest.fn(async (opts) => {
          remoteGrantRevocations.push({ dest_bay, opts });
        }),
        getClaimableMembershipPackages: jest.fn(async () => [
          {
            package_id: remote_package_id,
            kind: "site",
            membership_class: teamTier,
            owner_account_id: uuid(),
            starts_at: new Date("2026-05-07T00:00:00.000Z"),
            expires_at: null,
            available_seat_count: 1,
            matched_email_address: verifiedEmail,
            reason: "domain-match",
            metadata: { allowed_domains: ["example.edu"] },
          },
        ]),
        claimMembershipPackageSeat: remoteClaimMock,
      }),
    );

    const claimed = await claimMembershipPackageSeat({
      package_id: remote_package_id,
      account_id: claimant_account_id,
    });
    expect(claimed).toEqual(remoteAssignment);
    expect(remoteClaimMock).toHaveBeenCalledWith({
      package_id: remote_package_id,
      account_id: claimant_account_id,
      verified_email_addresses: [verifiedEmail],
    });
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
    expect(remoteGrantUpserts).toHaveLength(0);
    await runMembershipSideEffectsPass();
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
    expect(remoteGrantUpserts).toHaveLength(0);
    await runMembershipSideEffectsPass();
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
    expect(remoteGrantRevocations).toHaveLength(0);
    await runMembershipSideEffectsPass();
    expect(remoteGrantRevocations).toHaveLength(1);
    expect(remoteGrantRevocations[0]).toMatchObject({
      dest_bay: "bay-1",
      opts: {
        account_id: invited_account_id,
        grant_id: assignment.grant_id,
      },
    });
  });

  it("collapses remote grant replay to the latest desired state", async () => {
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

    await assignMembershipPackageSeat({
      package_id,
      account_id: invited_account_id,
      assigned_by_account_id: owner_account_id,
    });
    await revokeMembershipPackageSeat({
      package_id,
      account_id: invited_account_id,
    });

    expect(remoteGrantUpserts).toHaveLength(0);
    expect(remoteGrantRevocations).toHaveLength(0);
    await runMembershipSideEffectsPass();
    expect(remoteGrantUpserts).toHaveLength(0);
    expect(remoteGrantRevocations).toHaveLength(1);
    expect(remoteGrantRevocations[0]).toMatchObject({
      dest_bay: "bay-1",
      opts: {
        account_id: invited_account_id,
      },
    });
  });
});
