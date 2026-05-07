/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  getActiveMembershipPackageAssignmentForAccount,
  getCourseMembershipPackage,
  isActiveMembershipPackageAssignment,
} from "./membership-packages";

describe("course membership package helpers", () => {
  it("selects the most recently updated package for a course", () => {
    const selected = getCourseMembershipPackage(
      [
        {
          id: "older",
          owner_account_id: "owner",
          kind: "course",
          membership_class: "student",
          seat_count: 3,
          metadata: { course_project_id: "course-1" },
          assignments: [],
          active_assignment_count: 0,
          available_seat_count: 3,
          updated: new Date("2026-05-01T00:00:00Z"),
        },
        {
          id: "other-course",
          owner_account_id: "owner",
          kind: "course",
          membership_class: "student",
          seat_count: 2,
          metadata: { course_project_id: "course-2" },
          assignments: [],
          active_assignment_count: 0,
          available_seat_count: 2,
          updated: new Date("2026-05-03T00:00:00Z"),
        },
        {
          id: "newer",
          owner_account_id: "owner",
          kind: "course",
          membership_class: "student",
          seat_count: 5,
          metadata: { course_project_id: "course-1" },
          assignments: [],
          active_assignment_count: 0,
          available_seat_count: 5,
          updated: new Date("2026-05-02T00:00:00Z"),
        },
      ],
      "course-1",
    );

    expect(selected?.id).toBe("newer");
  });

  it("finds only active assignments for the requested account", () => {
    const membershipPackage = {
      id: "package-1",
      owner_account_id: "owner",
      kind: "course",
      membership_class: "student",
      seat_count: 5,
      metadata: { course_project_id: "course-1" },
      assignments: [
        {
          id: "revoked",
          package_id: "package-1",
          account_id: "student-1",
          revoked_at: new Date("2026-05-01T00:00:00Z"),
        },
        {
          id: "active",
          package_id: "package-1",
          account_id: "student-1",
        },
      ],
      active_assignment_count: 1,
      available_seat_count: 4,
    };

    expect(
      isActiveMembershipPackageAssignment(membershipPackage.assignments[0]),
    ).toBe(false);
    expect(
      getActiveMembershipPackageAssignmentForAccount(
        membershipPackage,
        "student-1",
      )?.id,
    ).toBe("active");
  });
});
