/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

import dayjs from "dayjs";

let createInterBayAccountLocalClientMock: jest.Mock;
let getInterBayFabricClientMock: jest.Mock;
let projectControlSetUsageAccountMock: jest.Mock;
let projectDetailsGetMock: jest.Mock;

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
    projectDetails: jest.fn((dest_bay: string) => ({
      get: (opts: any) => projectDetailsGetMock(dest_bay, opts),
    })),
  })),
}));

import getPool, { type PoolClient } from "@cocalc/database/pool";
import { after, before } from "@cocalc/server/test";
import {
  createTestAccount,
  createTestMembershipPackage,
  createTestMembershipTier,
} from "@cocalc/server/purchases/test-data";
import purchaseMembershipPackage, {
  purchaseMembershipPackages,
} from "@cocalc/server/purchases/membership-package";
import { uuid } from "@cocalc/util/misc";
import { resolveMembershipForAccount } from "./resolve";
import { getMembershipClaimIdentity } from "./claim-directory";
import {
  addMembershipPackageSeats,
  assignMembershipPackageSeat,
  claimCourseMembershipPackageSeatsForAcceptedInvite,
  claimMembershipPackageSeat,
  listClaimableMembershipPackagesForAccount,
  listLocalClaimableMembershipPackagesForVerifiedEmails,
  listMembershipPackageDetailsForOwner,
  resolveMembershipPackageQuote,
  revokeMembershipPackageSeat,
  updateMembershipPackage,
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
  const teamTier2 = `team-tier-${uuid()}`;
  const hiddenTeamTier = `hidden-team-tier-${uuid()}`;
  const courseTier = `course-tier-${uuid()}`;
  let remoteGrantUpserts: Array<{ dest_bay: string; grant: any }>;
  let remoteGrantRevocations: Array<{ dest_bay: string; opts: any }>;
  let remoteProjectUsageUpdates: Array<{ dest_bay: string; opts: any }>;
  const clusterBayIdsEnv = process.env.COCALC_CLUSTER_BAY_IDS;
  const clusterSeedBayIdEnv = process.env.COCALC_CLUSTER_SEED_BAY_ID;

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

  async function createCourseStudentProject({
    project_id,
    course_project_id,
    student_account_id,
    owner_account_id,
    email_address,
    owning_bay_id,
  }: {
    project_id: string;
    course_project_id: string;
    student_account_id: string;
    owner_account_id: string;
    email_address?: string;
    owning_bay_id?: string;
  }) {
    await getPool("medium").query(
      `INSERT INTO projects
         (project_id, title, users, last_edited, usage_account_id, owning_bay_id, course)
       VALUES ($1, $2, $3::jsonb, NOW(), NULL, $4, $5::jsonb)`,
      [
        project_id,
        "Student Project",
        JSON.stringify({
          [owner_account_id]: { group: "owner" },
          [student_account_id]: { group: "collaborator" },
        }),
        owning_bay_id ?? null,
        JSON.stringify({
          type: "student",
          account_id: student_account_id,
          project_id: course_project_id,
          path: "test.course",
          ...(email_address ? { email_address } : {}),
        }),
      ],
    );
  }

  beforeAll(async () => {
    await createTestMembershipTier({
      id: teamTier,
      priority: 25,
      price_monthly: 20,
      price_yearly: 200,
      team_visible: true,
    });
    await createTestMembershipTier({
      id: teamTier2,
      priority: 30,
      price_monthly: 50,
      price_yearly: 500,
      team_visible: true,
    });
    await createTestMembershipTier({
      id: hiddenTeamTier,
      priority: 35,
      price_monthly: 60,
      price_yearly: 600,
      team_visible: false,
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
    projectDetailsGetMock = jest.fn(async (_dest_bay, { project_id }) => {
      const { rows } = await getPool().query(
        "SELECT course FROM projects WHERE project_id=$1 LIMIT 1",
        [project_id],
      );
      if (!rows[0]) throw Error(`project ${project_id} not found`);
      return { course: rows[0].course };
    });
  });

  afterEach(() => {
    if (clusterBayIdsEnv === undefined) {
      delete process.env.COCALC_CLUSTER_BAY_IDS;
    } else {
      process.env.COCALC_CLUSTER_BAY_IDS = clusterBayIdsEnv;
    }
    if (clusterSeedBayIdEnv === undefined) {
      delete process.env.COCALC_CLUSTER_SEED_BAY_ID;
    } else {
      process.env.COCALC_CLUSTER_SEED_BAY_ID = clusterSeedBayIdEnv;
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
    await markVerifiedEmail(first_account_id, "first-team-seat@example.com");
    await markVerifiedEmail(second_account_id, "second-team-seat@example.com");

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
    expect(
      details[0].assignments.find(
        (assignment) => assignment.account_id === first_account_id,
      )?.account_email_address,
    ).toBe("first-team-seat@example.com");
    expect(
      details[0].assignments.find(
        (assignment) => assignment.account_id === second_account_id,
      )?.account_email_address,
    ).toBe("second-team-seat@example.com");

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

    const allocationFacts = await getPool().query(
      `SELECT channel, source_kind, active_memberships
         FROM membership_allocation_facts
        WHERE fact_key LIKE $1
        ORDER BY source_kind`,
      [`package-assignment:${firstAssignment.id}:%`],
    );
    expect(allocationFacts.rows).toEqual([
      {
        channel: "team",
        source_kind: "assignment",
        active_memberships: 1,
      },
      {
        channel: "team",
        source_kind: "correction",
        active_memberships: -1,
      },
    ]);
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

  it("repairs missing grants when reassigning an existing course package seat", async () => {
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
    expect(assignment.grant_id).toBeTruthy();

    await getPool("medium").query(
      "DELETE FROM membership_grants WHERE package_id=$1 AND account_id=$2",
      [package_id, student_account_id],
    );
    const missingGrantMembership =
      await resolveMembershipForAccount(student_account_id);
    expect(missingGrantMembership.class).toBe("free");

    const repaired = await assignMembershipPackageSeat({
      package_id,
      account_id: student_account_id,
      assigned_by_account_id: student_account_id,
      metadata: {
        direct_student_purchase: true,
        grant_source: "student-course-purchase",
      },
    });
    expect(repaired.id).toBe(assignment.id);
    expect(repaired.grant_id).toBeTruthy();
    expect(repaired.grant_id).not.toBe(assignment.grant_id);
    expect(repaired.grant_source).toBe("student-course-purchase");

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

  it("records course purchase revenue and capacity separately from assignments", async () => {
    const owner_account_id = uuid();
    const course_project_id = uuid();
    await createTestAccount(owner_account_id);
    await getPool("medium").query(
      `INSERT INTO projects (project_id, title, users, course, last_edited)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, NOW())`,
      [
        course_project_id,
        "Analytics Course",
        JSON.stringify({ [owner_account_id]: { group: "owner" } }),
        JSON.stringify({
          type: "student",
          project_id: course_project_id,
          path: "analytics.course",
        }),
      ],
    );

    const purchase = await purchaseMembershipPackage({
      account_id: owner_account_id,
      amount: 75,
      fulfillment_id: `course-analytics-${uuid()}`,
      product: {
        type: "membership-package",
        kind: "course",
        membership_class: courseTier,
        course_project_id,
        seat_count: 3,
      },
    });
    const { rows } = await getPool().query(
      `SELECT channel, active_memberships, purchased_capacity, revenue_cents
         FROM membership_allocation_facts
        WHERE purchase_id=$1`,
      [purchase.purchase_id],
    );
    expect(rows).toEqual([
      {
        channel: "course",
        active_memberships: 0,
        purchased_capacity: 3,
        revenue_cents: "7500",
      },
    ]);
  });

  it("quotes verified direct student course purchases without a local course project row", async () => {
    const course_project_id = uuid();
    const student_project_id = uuid();
    const quote = await resolveMembershipPackageQuote({
      type: "membership-package",
      kind: "course",
      membership_class: courseTier,
      course_project_id,
      seat_count: 1,
      metadata: {
        direct_student_purchase: true,
        grant_source: "student-course-purchase",
        project_id: student_project_id,
        course_project_id,
        course_path: "math101.course",
        course_title: "Math 101",
        verified_student_course_purchase: true,
      },
    });

    expect(quote.kind).toBe("course");
    expect(quote.membership_class).toBe(courseTier);
    expect(quote.seat_price).toBe(25);
    expect(quote.total_price).toBe(25);
    expect(quote.metadata).toMatchObject({
      direct_student_purchase: true,
      grant_source: "student-course-purchase",
      project_id: student_project_id,
      course_project_id,
      course_path: "math101.course",
      course_title: "Math 101",
      verified_student_course_purchase: true,
      course_duration_days: 122,
      course_grace_days: 14,
      seat_price: 25,
    });
  });

  it("records a fixed-term allocation for a direct student purchase", async () => {
    const account_id = uuid();
    const course_project_id = uuid();
    const project_id = uuid();
    const fulfillment_id = `direct-student-${uuid()}`;
    await createTestAccount(account_id);
    const product = {
      type: "membership-package" as const,
      kind: "course" as const,
      membership_class: courseTier,
      course_project_id,
      seat_count: 1,
      metadata: {
        direct_student_purchase: true,
        grant_source: "student-course-purchase",
        project_id,
        course_project_id,
        course_path: "math101.course",
        course_title: "Math 101",
        verified_student_course_purchase: true,
      },
    };

    const first = await purchaseMembershipPackage({
      account_id,
      amount: 25,
      fulfillment_id,
      product,
    });
    const second = await purchaseMembershipPackage({
      account_id,
      amount: 25,
      fulfillment_id,
      product,
    });

    expect(second).toEqual(first);
    const { rows } = await getPool().query(
      `SELECT channel, membership_class, billing_interval, lifecycle,
              active_memberships, purchased_capacity, revenue_cents
         FROM membership_allocation_facts
        WHERE purchase_id=$1`,
      [first.purchase_id],
    );
    expect(rows).toEqual([
      {
        channel: "direct-student",
        membership_class: courseTier,
        billing_interval: "fixed",
        lifecycle: "first_paid",
        active_memberships: 1,
        purchased_capacity: 1,
        revenue_cents: "2500",
      },
    ]);
    const assignmentFacts = await getPool().query(
      `SELECT COUNT(*)::int AS count
         FROM membership_allocation_facts
        WHERE account_id=$1
          AND fact_key LIKE 'package-assignment:%'`,
      [account_id],
    );
    expect(assignmentFacts.rows[0]?.count).toBe(0);
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

  it("rejects expanding an expired membership package", async () => {
    const owner_account_id = uuid();
    await createTestAccount(owner_account_id);

    const package_id = await createTestMembershipPackage({
      owner_account_id,
      kind: "team",
      membership_class: teamTier,
      seat_count: 2,
      expires_at: dayjs().subtract(1, "minute").toDate(),
      metadata: {
        interval: "month",
        seat_price: 20,
      },
    });

    const error = "cannot add seats to an expired membership package";
    await expect(
      resolveMembershipPackageQuote({
        type: "membership-package",
        membership_class: teamTier,
        seat_count: 1,
        package_id,
      }),
    ).rejects.toThrow(error);
    await expect(
      addMembershipPackageSeats({ package_id, seat_count: 1 }),
    ).rejects.toThrow(error);

    const details = await listMembershipPackageDetailsForOwner({
      owner_account_id,
    });
    expect(details.find(({ id }) => id === package_id)).toMatchObject({
      seat_count: 2,
    });
  });

  it("rejects assigning a course seat to the instructor course project", async () => {
    const owner_account_id = uuid();
    const student_account_id = uuid();
    const course_project_id = uuid();
    await createTestAccount(owner_account_id);
    await createTestAccount(student_account_id);
    const package_id = await createTestMembershipPackage({
      owner_account_id,
      kind: "course",
      membership_class: "student",
      seat_count: 1,
      metadata: { course_project_id },
    });

    await expect(
      assignMembershipPackageSeat({
        package_id,
        account_id: student_account_id,
        assigned_by_account_id: owner_account_id,
        metadata: { project_id: course_project_id },
      }),
    ).rejects.toThrow(
      "course seat must target a student project, not the instructor course project",
    );
  });

  it("rejects assigning a course seat to a project from another course", async () => {
    const owner_account_id = uuid();
    const student_account_id = uuid();
    const course_project_id = uuid();
    const student_project_id = uuid();
    await createTestAccount(owner_account_id);
    await createTestAccount(student_account_id);
    await createCourseStudentProject({
      project_id: student_project_id,
      course_project_id: uuid(),
      student_account_id,
      owner_account_id,
    });
    const package_id = await createTestMembershipPackage({
      owner_account_id,
      kind: "course",
      membership_class: "student",
      seat_count: 1,
      metadata: { course_project_id },
    });

    await expect(
      assignMembershipPackageSeat({
        package_id,
        account_id: student_account_id,
        assigned_by_account_id: owner_account_id,
        metadata: { project_id: student_project_id },
      }),
    ).rejects.toThrow(
      `course seat project must be a student project linked to course ${course_project_id}`,
    );
  });

  it("rejects assigning a course seat to another student's project", async () => {
    const owner_account_id = uuid();
    const student_account_id = uuid();
    const other_student_account_id = uuid();
    const course_project_id = uuid();
    const student_project_id = uuid();
    await createTestAccount(owner_account_id);
    await createTestAccount(student_account_id);
    await createTestAccount(other_student_account_id);
    await createCourseStudentProject({
      project_id: student_project_id,
      course_project_id,
      student_account_id: other_student_account_id,
      owner_account_id,
    });
    const package_id = await createTestMembershipPackage({
      owner_account_id,
      kind: "course",
      membership_class: "student",
      seat_count: 1,
      metadata: { course_project_id },
    });

    await expect(
      assignMembershipPackageSeat({
        package_id,
        account_id: student_account_id,
        assigned_by_account_id: owner_account_id,
        metadata: { project_id: student_project_id },
      }),
    ).rejects.toThrow(
      "course seat account does not match the student project account",
    );
  });

  it("updates project usage attribution when assigning and revoking a course seat", async () => {
    const owner_account_id = uuid();
    const student_account_id = uuid();
    const course_project_id = uuid();
    const project_id = uuid();
    await createTestAccount(owner_account_id);
    await createTestAccount(student_account_id);

    await createCourseStudentProject({
      project_id,
      course_project_id,
      student_account_id,
      owner_account_id,
    });

    const package_id = await createTestMembershipPackage({
      owner_account_id,
      kind: "course",
      membership_class: "student",
      seat_count: 1,
      metadata: {
        course_project_id,
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
    const course_project_id = uuid();
    const project_id = uuid();
    await createTestAccount(owner_account_id);
    await createTestAccount(student_account_id);

    await createCourseStudentProject({
      project_id,
      course_project_id,
      student_account_id,
      owner_account_id,
      owning_bay_id: "bay-2",
    });

    const package_id = await createTestMembershipPackage({
      owner_account_id,
      kind: "course",
      membership_class: "student",
      seat_count: 1,
      metadata: {
        course_project_id,
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
    const course_project_id = uuid();
    const project_id = uuid();
    await createTestAccount(owner_account_id);
    await createTestAccount(student_account_id);
    await markVerifiedEmail(student_account_id, "reserved-student@example.com");

    await createCourseStudentProject({
      project_id,
      course_project_id,
      student_account_id,
      owner_account_id,
      email_address: "reserved-student@example.com",
    });

    const package_id = await createTestMembershipPackage({
      owner_account_id,
      kind: "course",
      membership_class: "student",
      seat_count: 1,
      metadata: {
        course_project_id,
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
    const course_project_id = uuid();
    const project_id = uuid();
    await createTestAccount(owner_account_id);
    await createTestAccount(student_account_id);
    await markVerifiedEmail(student_account_id, "remote-claim@example.com");

    await createCourseStudentProject({
      project_id,
      course_project_id,
      student_account_id,
      owner_account_id,
      email_address: "remote-claim@example.com",
      owning_bay_id: "bay-2",
    });

    const package_id = await createTestMembershipPackage({
      owner_account_id,
      kind: "course",
      membership_class: "student",
      seat_count: 1,
      metadata: {
        course_project_id,
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

  it("claims a reserved course seat for the account accepting its invite", async () => {
    const owner_account_id = uuid();
    const accepted_account_id = uuid();
    const course_project_id = uuid();
    const student_project_id = uuid();
    const student_id = uuid();
    await createTestAccount(owner_account_id);
    await createTestAccount(accepted_account_id);
    await markVerifiedEmail(accepted_account_id, "different@example.com");
    await createCourseStudentProject({
      project_id: student_project_id,
      course_project_id,
      student_account_id: accepted_account_id,
      owner_account_id,
      email_address: "invited@example.com",
    });

    const package_id = await createTestMembershipPackage({
      owner_account_id,
      kind: "course",
      membership_class: courseTier,
      seat_count: 1,
      metadata: { course_project_id },
    });
    await assignMembershipPackageSeat({
      package_id,
      email_address: "invited@example.com",
      assigned_by_account_id: owner_account_id,
      metadata: {
        course_project_id,
        project_id: student_project_id,
        student_id,
      },
    });

    const claimables =
      await listLocalClaimableMembershipPackagesForVerifiedEmails({
        account_id: accepted_account_id,
        verified_email_addresses: ["invited@example.com"],
      });
    expect(claimables[0].course_assignment_context).toEqual({
      course_project_id,
      project_id: student_project_id,
      student_id,
    });

    await expect(
      claimCourseMembershipPackageSeatsForAcceptedInvite({
        account_id: accepted_account_id,
        invited_email_address: "invited@example.com",
        course_project_id,
        student_project_id,
        student_id: uuid(),
      }),
    ).resolves.toEqual([]);

    const claimed = await claimCourseMembershipPackageSeatsForAcceptedInvite({
      account_id: accepted_account_id,
      invited_email_address: "invited@example.com",
      course_project_id,
      student_project_id,
      student_id,
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      package_id,
      account_id: accepted_account_id,
      email_address: "invited@example.com",
    });
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

  it("does not use email verification history for site eligibility", async () => {
    const owner_account_id = uuid();
    const account_id = uuid();
    const domain = `history-${uuid().slice(0, 8)}.edu`;
    const emailAddress = `member-${uuid()}@example.net`;
    const historicalEmailAddress = `member@${domain}`;
    await createTestAccount(owner_account_id);
    await createTestAccount(account_id);
    await getPool().query(
      `UPDATE accounts
       SET email_address=$2,
           email_address_verified=$3::jsonb
       WHERE account_id=$1`,
      [
        account_id,
        emailAddress,
        {
          [emailAddress]: new Date().toISOString(),
          [historicalEmailAddress]: new Date().toISOString(),
        },
      ],
    );

    const package_id = await createTestMembershipPackage({
      owner_account_id,
      kind: "site",
      membership_class: teamTier,
      seat_count: 1,
      metadata: {
        interval: "year",
        seat_price: 100,
        allowed_domains: [domain],
      },
    });

    const claimables = await listClaimableMembershipPackagesForAccount({
      account_id,
    });
    expect(claimables.some((row) => row.package_id === package_id)).toBe(false);
    await expect(
      claimMembershipPackageSeat({ package_id, account_id }),
    ).rejects.toThrow("no claimable seat found for this account");
  });

  it("filters site-only discovery in SQL and batches assignment lookup", async () => {
    const owner_account_id = uuid();
    const account_id = uuid();
    const emailAddress = `member-${uuid()}@efficient.example.edu`;
    await createTestAccount(owner_account_id);
    await createTestAccount(account_id);

    const sitePackageId = await createTestMembershipPackage({
      owner_account_id,
      kind: "site",
      membership_class: teamTier,
      seat_count: 2,
      metadata: { allowed_domains: ["efficient.example.edu"] },
    });
    const teamPackageId = await createTestMembershipPackage({
      owner_account_id,
      kind: "team",
      membership_class: teamTier,
      seat_count: 2,
    });
    await assignMembershipPackageSeat({
      package_id: teamPackageId,
      email_address: emailAddress,
      assigned_by_account_id: owner_account_id,
    });

    const client = getPool("medium");
    const querySpy = jest.spyOn(client, "query");
    try {
      const claimables =
        await listLocalClaimableMembershipPackagesForVerifiedEmails({
          account_id,
          site_only: true,
          verified_email_addresses: [emailAddress],
          client: client as unknown as PoolClient,
        });
      expect(claimables.some((row) => row.package_id === sitePackageId)).toBe(
        true,
      );
      expect(claimables.some((row) => row.package_id === teamPackageId)).toBe(
        false,
      );

      const sqlCalls = querySpy.mock.calls.map(([query]) =>
        typeof query === "string" ? query : query.text,
      );
      expect(
        sqlCalls.filter((sql) =>
          sql.includes("FROM membership_package_assignments"),
        ),
      ).toHaveLength(1);
      expect(
        sqlCalls.find((sql) => sql.includes("FROM membership_packages")),
      ).toContain("kind = 'site'");
    } finally {
      querySpy.mockRestore();
    }
  });

  it("can include already claimed site-license pools for account settings", async () => {
    const owner_account_id = uuid();
    const site_user_account_id = uuid();
    const site_user_email = `ada-${uuid().slice(0, 8)}@example.edu`;
    await createTestAccount(owner_account_id);
    await createTestAccount(site_user_account_id);
    await markVerifiedEmail(site_user_account_id, site_user_email);

    const package_id = await createTestMembershipPackage({
      owner_account_id,
      kind: "site",
      membership_class: teamTier,
      seat_count: 2,
      metadata: {
        allowed_domains: ["example.edu"],
        pool_name: "Students",
      },
    });

    const claimed = await claimMembershipPackageSeat({
      package_id,
      account_id: site_user_account_id,
    });

    const defaultClaimables = await listClaimableMembershipPackagesForAccount({
      account_id: site_user_account_id,
    });
    expect(
      defaultClaimables.some(
        (claimable) => claimable.package_id === package_id,
      ),
    ).toBe(false);

    const claimablesWithClaimed =
      await listClaimableMembershipPackagesForAccount({
        account_id: site_user_account_id,
        include_claimed_site_license_pools: true,
      });
    expect(claimablesWithClaimed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assignment_id: claimed.id,
          available_seat_count: 1,
          matched_email_address: site_user_email,
          package_id,
          pool_name: "Students",
          seat_status: "claimed",
        }),
      ]),
    );
  });

  it("does not over-assign a one-seat site-license pool under concurrent claims", async () => {
    const owner_account_id = uuid();
    const first_account_id = uuid();
    const second_account_id = uuid();
    const domain = `race-${uuid().slice(0, 8)}.edu`;
    await createTestAccount(owner_account_id);
    await createTestAccount(first_account_id);
    await createTestAccount(second_account_id);
    await markVerifiedEmail(first_account_id, `first@${domain}`);
    await markVerifiedEmail(second_account_id, `second@${domain}`);

    const package_id = await createTestMembershipPackage({
      owner_account_id,
      kind: "site",
      membership_class: teamTier,
      seat_count: 1,
      metadata: {
        allowed_domains: [domain],
        site_license_id: uuid(),
      },
    });

    const results = await Promise.allSettled([
      claimMembershipPackageSeat({
        package_id,
        account_id: first_account_id,
      }),
      claimMembershipPackageSeat({
        package_id,
        account_id: second_account_id,
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(`${(rejected[0] as PromiseRejectedResult).reason}`).toContain(
      "no seats available",
    );

    const details = await listMembershipPackageDetailsForOwner({
      owner_account_id,
    });
    const pkg = details.find((pkg) => pkg.id === package_id);
    expect(pkg?.active_assignment_count).toBe(1);
    expect(pkg?.available_seat_count).toBe(0);
  });

  it("does not allow direct entitlement expansion for non-site packages", async () => {
    const owner_account_id = uuid();
    await createTestAccount(owner_account_id);
    const expires_at = dayjs().add(30, "day").toDate();
    const package_id = await createTestMembershipPackage({
      owner_account_id,
      kind: "team",
      membership_class: teamTier,
      seat_count: 2,
      expires_at,
      metadata: {
        interval: "month",
        seat_price: 20,
      },
    });

    await expect(
      updateMembershipPackage({
        package_id,
        seat_count: 3,
      }),
    ).rejects.toThrow(
      "seat_count increases must go through membership package purchase",
    );
    await expect(
      updateMembershipPackage({
        package_id,
        expires_at: dayjs(expires_at).add(1, "day").toDate(),
      }),
    ).rejects.toThrow(
      "expires_at extensions must go through membership package purchase",
    );
    await expect(
      updateMembershipPackage({
        package_id,
        expires_at: null,
      }),
    ).rejects.toThrow(
      "expires_at extensions must go through membership package purchase",
    );

    const shortened = dayjs(expires_at).subtract(1, "day").toDate();
    const updated = await updateMembershipPackage({
      package_id,
      seat_count: 1,
      expires_at: shortened,
    });
    expect(updated.seat_count).toBe(1);
    expect(updated.expires_at?.toISOString()).toBe(shortened.toISOString());
  });

  it("updates site-license domains for future claims without revoking existing seats", async () => {
    const owner_account_id = uuid();
    const first_account_id = uuid();
    const second_account_id = uuid();
    const firstDomain = `first-${uuid().slice(0, 8)}.edu`;
    const secondDomain = `second-${uuid().slice(0, 8)}.edu`;
    await createTestAccount(owner_account_id);
    await createTestAccount(first_account_id);
    await createTestAccount(second_account_id);
    await markVerifiedEmail(first_account_id, `ada@${firstDomain}`);
    await markVerifiedEmail(second_account_id, `grace@${secondDomain}`);

    const package_id = await createTestMembershipPackage({
      owner_account_id,
      kind: "site",
      membership_class: teamTier,
      seat_count: 3,
      metadata: {
        interval: "year",
        seat_price: 100,
        allowed_domains: [firstDomain],
      },
    });

    const firstClaim = await claimMembershipPackageSeat({
      package_id,
      account_id: first_account_id,
    });
    expect(firstClaim.grant_source).toBe("site-license");

    const updated = await updateMembershipPackage({
      package_id,
      allowed_domains: [secondDomain],
    });
    expect(updated.metadata?.allowed_domains).toEqual([secondDomain]);
    expect(updated.active_assignment_count).toBe(1);

    expect(
      await listClaimableMembershipPackagesForAccount({
        account_id: first_account_id,
      }),
    ).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ package_id })]),
    );
    expect(
      await listClaimableMembershipPackagesForAccount({
        account_id: second_account_id,
      }),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ package_id })]),
    );

    const membership = await resolveMembershipForAccount(first_account_id);
    expect(membership.class).toBe(teamTier);
    expect(membership.source).toBe("grant");
  });

  it("prevents active site package domain overlap when updating domains", async () => {
    const first_owner_account_id = uuid();
    const second_owner_account_id = uuid();
    const firstDomain = `update-overlap-${uuid().slice(0, 8)}.edu`;
    const secondDomain = `update-other-${uuid().slice(0, 8)}.edu`;
    await createTestAccount(first_owner_account_id);
    await createTestAccount(second_owner_account_id);

    await createTestMembershipPackage({
      owner_account_id: first_owner_account_id,
      kind: "site",
      membership_class: teamTier,
      seat_count: 3,
      metadata: {
        interval: "year",
        seat_price: 100,
        allowed_domains: [firstDomain],
        site_license_id: uuid(),
        pool_name: "Existing pool",
      },
    });
    const package_id = await createTestMembershipPackage({
      owner_account_id: second_owner_account_id,
      kind: "site",
      membership_class: teamTier,
      seat_count: 3,
      metadata: {
        interval: "year",
        seat_price: 100,
        allowed_domains: [secondDomain],
        site_license_id: uuid(),
        pool_name: "Updated pool",
      },
    });

    await expect(
      updateMembershipPackage({
        package_id,
        allowed_domains: [`dept.${firstDomain}`],
      }),
    ).rejects.toThrow(
      `site license domain 'dept.${firstDomain}' overlaps active site license domain '${firstDomain}'`,
    );
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

  it("discovers seed claimable site packages across the cluster", async () => {
    process.env.COCALC_CLUSTER_BAY_IDS = "bay-0,bay-1,bay-2";
    process.env.COCALC_CLUSTER_SEED_BAY_ID = "bay-1";
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
            site_only,
            verified_email_addresses,
          }: {
            account_id: string;
            site_only?: boolean;
            verified_email_addresses: string[];
          }) => {
            expect(dest_bay).toBe("bay-1");
            expect(account_id).toBe(claimant_account_id);
            expect(site_only).toBe(true);
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
      site_only: true,
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

  it("forwards remote site-license claims to the seed bay with verified emails", async () => {
    process.env.COCALC_CLUSTER_BAY_IDS = "bay-0,bay-1";
    process.env.COCALC_CLUSTER_SEED_BAY_ID = "bay-1";
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
    expect(createInterBayAccountLocalClientMock).toHaveBeenCalledWith({
      client: { id: "fabric-client" },
      dest_bay: "bay-1",
    });
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

  it("purchases multiple team package products in one bundle", async () => {
    const owner_account_id = uuid();
    await createTestAccount(owner_account_id);

    const result = await purchaseMembershipPackages({
      account_id: owner_account_id,
      amount: 900,
      products: [
        {
          type: "membership-package",
          kind: "team",
          membership_class: teamTier,
          seat_count: 2,
          interval: "year",
        },
        {
          type: "membership-package",
          kind: "team",
          membership_class: teamTier2,
          seat_count: 1,
          interval: "year",
        },
      ],
    });

    expect(result).toHaveLength(2);
    const details = await listMembershipPackageDetailsForOwner({
      owner_account_id,
    });
    expect(
      details.map(({ kind, membership_class, seat_count }) => ({
        kind,
        membership_class,
        seat_count,
      })),
    ).toEqual(
      expect.arrayContaining([
        { kind: "team", membership_class: teamTier, seat_count: 2 },
        { kind: "team", membership_class: teamTier2, seat_count: 1 },
      ]),
    );
  });

  it("does not duplicate membership package purchases when fulfillment is retried", async () => {
    const owner_account_id = uuid();
    await createTestAccount(owner_account_id);
    const product = {
      type: "membership-package" as const,
      kind: "team" as const,
      membership_class: teamTier,
      seat_count: 2,
      interval: "year" as const,
    };

    const first = await purchaseMembershipPackage({
      account_id: owner_account_id,
      amount: 400,
      fulfillment_id: "pi_membership_package_retry",
      product,
    });
    const second = await purchaseMembershipPackage({
      account_id: owner_account_id,
      amount: 400,
      fulfillment_id: "pi_membership_package_retry",
      product,
    });

    expect(second).toEqual(first);
    const details = await listMembershipPackageDetailsForOwner({
      owner_account_id,
    });
    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({
      id: first.package_id,
      membership_class: teamTier,
      seat_count: 2,
    });
    const purchases = await getPool().query(
      "SELECT COUNT(*)::int AS count FROM purchases WHERE account_id=$1 AND invoice_id LIKE 'membership-package:pi_membership_package_retry:%'",
      [owner_account_id],
    );
    expect(purchases.rows[0].count).toBe(1);
  });

  it("does not duplicate membership package expansions when fulfillment is retried", async () => {
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
    const product = {
      type: "membership-package" as const,
      membership_class: teamTier,
      package_id,
      seat_count: 1,
    };

    const first = await purchaseMembershipPackage({
      account_id: owner_account_id,
      amount: 20,
      fulfillment_id: "pi_membership_package_expand_retry",
      product,
    });
    const second = await purchaseMembershipPackage({
      account_id: owner_account_id,
      amount: 20,
      fulfillment_id: "pi_membership_package_expand_retry",
      product,
    });

    expect(second).toEqual(first);
    const details = await listMembershipPackageDetailsForOwner({
      owner_account_id,
    });
    expect(details.find(({ id }) => id === package_id)).toMatchObject({
      seat_count: 3,
    });
    const purchases = await getPool().query(
      "SELECT COUNT(*)::int AS count FROM purchases WHERE account_id=$1 AND invoice_id LIKE 'membership-package:pi_membership_package_expand_retry:%'",
      [owner_account_id],
    );
    expect(purchases.rows[0].count).toBe(1);
  });

  it("rejects hidden team tiers in membership package purchases and expansions", async () => {
    const owner_account_id = uuid();
    await createTestAccount(owner_account_id);
    const product = {
      type: "membership-package" as const,
      kind: "team" as const,
      membership_class: hiddenTeamTier,
      seat_count: 1,
      interval: "year" as const,
    };

    await expect(resolveMembershipPackageQuote(product)).rejects.toThrow(
      `membership tier "${hiddenTeamTier}" is not available for team packages`,
    );
    await expect(
      purchaseMembershipPackage({
        account_id: owner_account_id,
        amount: 600,
        product,
      }),
    ).rejects.toThrow(
      `membership tier "${hiddenTeamTier}" is not available for team packages`,
    );

    const package_id = await createTestMembershipPackage({
      owner_account_id,
      kind: "team",
      membership_class: hiddenTeamTier,
      seat_count: 1,
      metadata: {
        interval: "year",
        seat_price: 600,
      },
    });
    await expect(
      resolveMembershipPackageQuote({
        ...product,
        package_id,
      }),
    ).rejects.toThrow(
      `membership tier "${hiddenTeamTier}" is not available for team packages`,
    );
  });

  it("rejects generic site membership package purchases", async () => {
    await expect(
      resolveMembershipPackageQuote({
        type: "membership-package",
        kind: "site",
        membership_class: teamTier,
        seat_count: 1,
        interval: "year",
      }),
    ).rejects.toThrow(
      "site membership packages must be managed through site licenses",
    );

    const owner_account_id = uuid();
    await createTestAccount(owner_account_id);
    const package_id = await createTestMembershipPackage({
      owner_account_id,
      kind: "site",
      membership_class: teamTier,
      seat_count: 1,
      metadata: {
        interval: "year",
        seat_price: 200,
      },
    });
    await expect(
      resolveMembershipPackageQuote({
        type: "membership-package",
        kind: "site",
        membership_class: teamTier,
        seat_count: 1,
        interval: "year",
        package_id,
      }),
    ).rejects.toThrow(
      "site membership packages must be managed through site licenses",
    );
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
