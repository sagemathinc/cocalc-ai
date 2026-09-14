/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { MembershipPackageProduct } from "@cocalc/util/membership-package-product";
import { isValidUUID } from "@cocalc/util/misc";

export function normalizeAdminMembershipPackageUuid(
  value: unknown,
  field: string,
): string {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  if (!isValidUUID(normalized)) {
    throw Error(`${field} must be a valid UUID`);
  }
  return normalized;
}

export function normalizeAdminMembershipPackageProduct(
  product: MembershipPackageProduct,
): MembershipPackageProduct {
  const suppliedProjectId = `${product.course_project_id ?? ""}`.trim();
  if (!suppliedProjectId) {
    if (product.kind === "course") {
      throw Error("course_project_id must be a valid UUID");
    }
    return product.course_project_id == null
      ? product
      : { ...product, course_project_id: undefined };
  }
  const course_project_id = normalizeAdminMembershipPackageUuid(
    suppliedProjectId,
    "course_project_id",
  );
  return course_project_id === product.course_project_id
    ? product
    : { ...product, course_project_id };
}

export function adminMembershipPackageInvoiceId(
  adminAccountId: string,
  idempotencyKey: string,
): string {
  const adminId = normalizeAdminMembershipPackageUuid(
    adminAccountId,
    "admin_account_id",
  );
  return `admin-membership-package:${adminId}:${idempotencyKey}`;
}
