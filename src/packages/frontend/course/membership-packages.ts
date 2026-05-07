/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  MembershipPackageAssignment,
  MembershipPackageDetails,
} from "@cocalc/conat/hub/api/purchases";

function toTime(value?: Date): number {
  return value instanceof Date ? value.valueOf() : 0;
}

export function isActiveMembershipPackageAssignment(
  assignment?: MembershipPackageAssignment | null,
): boolean {
  return !!assignment && !assignment.revoked_at;
}

export function isCourseMembershipPackageForProject(
  membershipPackage: MembershipPackageDetails | undefined,
  course_project_id: string,
): boolean {
  return (
    membershipPackage?.kind === "course" &&
    membershipPackage?.metadata?.course_project_id === course_project_id
  );
}

export function getCourseMembershipPackage(
  packages: MembershipPackageDetails[],
  course_project_id: string,
): MembershipPackageDetails | undefined {
  return packages
    .filter((membershipPackage) =>
      isCourseMembershipPackageForProject(membershipPackage, course_project_id),
    )
    .sort(
      (left, right) =>
        toTime(right.updated) - toTime(left.updated) ||
        toTime(right.created) - toTime(left.created),
    )[0];
}

export function getActiveMembershipPackageAssignmentForAccount(
  membershipPackage: MembershipPackageDetails | undefined,
  account_id: string | undefined,
): MembershipPackageAssignment | undefined {
  if (!membershipPackage || !account_id) {
    return;
  }
  return membershipPackage.assignments.find(
    (assignment) =>
      assignment.account_id === account_id &&
      isActiveMembershipPackageAssignment(assignment),
  );
}
