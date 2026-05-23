/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type MembershipPackageKind = "course" | "team" | "site";

export interface MembershipPackageProduct {
  type: "membership-package";
  kind: MembershipPackageKind;
  membership_class: string;
  seat_count: number;
  interval?: "month" | "year";
  package_id?: string;
  course_project_id?: string;
  starts_at?: Date | string;
  expires_at?: Date | string;
  price_per_seat?: number;
  metadata?: Record<string, unknown>;
}
