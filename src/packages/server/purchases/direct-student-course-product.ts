/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getProjectReadDetailsAllowRemote } from "@cocalc/server/conat/api/projects";
import type { MembershipPackageProduct } from "@cocalc/util/membership-package-product";

export async function verifyDirectStudentCourseProduct({
  account_id,
  product,
}: {
  account_id: string;
  product: MembershipPackageProduct;
}): Promise<MembershipPackageProduct> {
  const metadata = product.metadata ?? {};
  if (product.kind !== "course" || metadata.direct_student_purchase !== true) {
    return product;
  }
  const studentProjectId = `${metadata.project_id ?? ""}`.trim();
  const courseProjectId = `${product.course_project_id ?? ""}`.trim();
  if (!studentProjectId) {
    throw Error("student project id is required for course purchases");
  }
  const details = await getProjectReadDetailsAllowRemote({
    account_id,
    project_id: studentProjectId,
  });
  const course = details.course;
  if (
    course?.type !== "student" ||
    course.account_id !== account_id ||
    `${course.project_id ?? ""}`.trim() !== courseProjectId
  ) {
    throw Error("course membership purchase is not available for this project");
  }
  const requiredMembershipClass = `${
    course.required_membership_class ?? ""
  }`.trim();
  if (
    !requiredMembershipClass ||
    requiredMembershipClass !== `${product.membership_class ?? ""}`.trim()
  ) {
    throw Error("course membership tier does not match this course");
  }
  return {
    ...product,
    metadata: {
      ...metadata,
      course_project_id: courseProjectId,
      course_path: course.path,
      verified_student_course_purchase: true,
    },
  };
}

export async function verifyDirectStudentCourseProducts({
  account_id,
  products,
}: {
  account_id: string;
  products: MembershipPackageProduct[];
}): Promise<MembershipPackageProduct[]> {
  return await Promise.all(
    products.map((product) =>
      verifyDirectStudentCourseProduct({ account_id, product }),
    ),
  );
}
