/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

export function adminMembershipPackageInvoiceId(
  adminAccountId: string,
  idempotencyKey: string,
): string {
  return `admin-membership-package:${adminAccountId}:${idempotencyKey}`;
}
