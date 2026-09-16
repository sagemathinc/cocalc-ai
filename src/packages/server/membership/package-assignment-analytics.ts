/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { PoolClient } from "@cocalc/database/pool";
import type {
  MembershipAllocationBillingInterval,
  MembershipAllocationChannel,
  MembershipPackageAssignment,
  MembershipPackageRecord,
} from "@cocalc/conat/hub/api/purchases";
import { recordMembershipAllocationFact } from "./allocation-analytics";

export type PackageAssignmentKind = "course" | "team" | "site";

export interface PackageAssignmentAllocationSource {
  assignment_id: string;
  account_id: string;
  assigned_at: Date | string;
  revoked_at?: Date | string | null;
  assignment_metadata?: Record<string, unknown> | null;
  package_kind: PackageAssignmentKind;
  package_metadata?: Record<string, unknown> | null;
  membership_class: string;
  package_starts_at?: Date | string | null;
  package_expires_at?: Date | string | null;
}

export interface PackageAssignmentAllocationInterval {
  month: string;
  allocation_start: string;
  allocation_end: string;
}

export interface RecordPackageAssignmentMonthResult {
  assignment: boolean;
  correction: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function validDate(value: unknown): Date | undefined {
  if (value == null || value === "") return;
  const date = new Date(value as Date | string);
  return Number.isFinite(date.valueOf()) ? date : undefined;
}

function dayKey(value: Date | string): string {
  const date = validDate(value);
  if (!date) throw Error(`invalid membership assignment date: ${value}`);
  return date.toISOString().slice(0, 10);
}

function dayNumber(value: string): number {
  return Date.parse(`${value}T00:00:00.000Z`) / DAY_MS;
}

function dayFromNumber(value: number): string {
  return new Date(value * DAY_MS).toISOString().slice(0, 10);
}

function monthStart(month: string): string {
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw Error(`invalid membership assignment month: ${month}`);
  }
  return `${month}-01`;
}

function nextMonthStart(month: string): string {
  const start = new Date(`${monthStart(month)}T00:00:00.000Z`);
  start.setUTCMonth(start.getUTCMonth() + 1);
  return dayKey(start);
}

export function packageAssignmentMonth(value: Date | string): string {
  return dayKey(value).slice(0, 7);
}

export function packageAssignmentChannel(
  kind: PackageAssignmentKind,
): MembershipAllocationChannel {
  return kind;
}

function isDirectStudentPackage({
  pkg,
  assignment,
}: {
  pkg: MembershipPackageRecord;
  assignment: MembershipPackageAssignment;
}): boolean {
  return (
    pkg.metadata?.direct_student_purchase === true ||
    assignment.metadata?.direct_student_purchase === true
  );
}

export function packageAssignmentAllocationSource({
  pkg,
  assignment,
}: {
  pkg: MembershipPackageRecord;
  assignment: MembershipPackageAssignment;
}): PackageAssignmentAllocationSource | undefined {
  const accountId = `${assignment.account_id ?? ""}`.trim();
  if (!accountId || assignment.assigned_at == null) return;
  // Direct student purchases already combine assignment and revenue in their
  // direct-student fact; recording this assignment would count it twice.
  if (pkg.kind === "course" && isDirectStudentPackage({ pkg, assignment })) {
    return;
  }
  return {
    assignment_id: assignment.id,
    account_id: accountId,
    assigned_at: assignment.assigned_at,
    revoked_at: assignment.revoked_at,
    assignment_metadata: {
      ...assignment.metadata,
      ...(assignment.grant_expires_at == null
        ? {}
        : { grant_expires_at: assignment.grant_expires_at }),
    },
    package_kind: pkg.kind,
    package_metadata: pkg.metadata,
    membership_class: pkg.membership_class,
    package_starts_at: pkg.starts_at,
    package_expires_at: pkg.expires_at,
  };
}

export async function recordMembershipPackageAssignmentMonth({
  pkg,
  assignment,
  month = packageAssignmentMonth(new Date()),
  client,
}: {
  pkg: MembershipPackageRecord;
  assignment: MembershipPackageAssignment;
  month?: string;
  client: PoolClient;
}): Promise<RecordPackageAssignmentMonthResult> {
  const source = packageAssignmentAllocationSource({ pkg, assignment });
  if (!source) return { assignment: false, correction: false };
  return await recordPackageAssignmentMonth({ source, month, client });
}

function packageAssignmentBillingInterval(
  source: PackageAssignmentAllocationSource,
): MembershipAllocationBillingInterval {
  return source.package_kind === "team" &&
    `${source.package_metadata?.team_license_id ?? ""}`.trim()
    ? "year"
    : "fixed";
}

function activationDate(source: PackageAssignmentAllocationSource): string {
  const claimedAt = validDate(source.assignment_metadata?.claimed_at);
  const assignedAt = validDate(source.assigned_at);
  if (!assignedAt) {
    throw Error(`invalid membership assignment date: ${source.assigned_at}`);
  }
  const startsAt = validDate(source.package_starts_at);
  return [claimedAt, assignedAt, startsAt]
    .filter((value): value is Date => value != null)
    .map(dayKey)
    .sort()
    .at(-1)!;
}

function expirationDate(
  source: PackageAssignmentAllocationSource,
): string | undefined {
  const grantExpiresAt = validDate(
    source.assignment_metadata?.grant_expires_at,
  );
  const packageExpiresAt = validDate(source.package_expires_at);
  const dates = [grantExpiresAt, packageExpiresAt]
    .filter((value): value is Date => value != null)
    .map(dayKey)
    .sort();
  return dates[0];
}

function effectiveMembershipClass(
  source: PackageAssignmentAllocationSource,
): string {
  const override =
    `${source.assignment_metadata?.grant_membership_class ?? ""}`.trim();
  return override || source.membership_class;
}

export function packageAssignmentAllocationInterval({
  source,
  month,
}: {
  source: PackageAssignmentAllocationSource;
  month: string;
}): PackageAssignmentAllocationInterval | undefined {
  const start = Math.max(
    dayNumber(monthStart(month)),
    dayNumber(activationDate(source)),
  );
  const expires = expirationDate(source);
  const end = Math.min(
    dayNumber(nextMonthStart(month)),
    expires == null ? Number.POSITIVE_INFINITY : dayNumber(expires),
  );
  if (end <= start) return;
  return {
    month,
    allocation_start: dayFromNumber(start),
    allocation_end: dayFromNumber(end),
  };
}

export function packageAssignmentAllocationMonths({
  source,
  through = new Date(),
}: {
  source: PackageAssignmentAllocationSource;
  through?: Date | string;
}): string[] {
  const start = packageAssignmentMonth(activationDate(source));
  const terminalDates = [
    dayKey(through),
    expirationDate(source),
    source.revoked_at == null ? undefined : dayKey(source.revoked_at),
  ].filter((value): value is string => value != null);
  const end = packageAssignmentMonth(terminalDates.sort()[0]);
  const months: string[] = [];
  const cursor = new Date(`${monthStart(start)}T00:00:00.000Z`);
  const terminal = new Date(`${monthStart(end)}T00:00:00.000Z`);
  while (cursor <= terminal) {
    months.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

function assignmentFactKey(assignmentId: string, month: string): string {
  return `package-assignment:${assignmentId}:${month}`;
}

export async function recordPackageAssignmentMonth({
  source,
  month,
  client,
}: {
  source: PackageAssignmentAllocationSource;
  month: string;
  client: PoolClient;
}): Promise<RecordPackageAssignmentMonthResult> {
  const interval = packageAssignmentAllocationInterval({ source, month });
  if (!interval) return { assignment: false, correction: false };
  const common = {
    account_id: source.account_id,
    channel: packageAssignmentChannel(source.package_kind),
    membership_class: effectiveMembershipClass(source),
    billing_interval: packageAssignmentBillingInterval(source),
    lifecycle: "first_paid" as const,
    allocation_end: interval.allocation_end,
    client,
  };
  const factKey = assignmentFactKey(source.assignment_id, month);
  const assignment = await recordMembershipAllocationFact({
    ...common,
    fact_key: factKey,
    occurred_at: validDate(source.assigned_at),
    source_kind: "assignment",
    allocation_start: interval.allocation_start,
    active_memberships: 1,
  });

  const revokedAt = validDate(source.revoked_at);
  if (!revokedAt) return { assignment, correction: false };
  const correctionStart = dayFromNumber(
    Math.max(
      dayNumber(interval.allocation_start),
      dayNumber(dayKey(revokedAt)),
    ),
  );
  if (dayNumber(correctionStart) >= dayNumber(interval.allocation_end)) {
    return { assignment, correction: false };
  }
  const correction = await recordMembershipAllocationFact({
    ...common,
    fact_key: `${factKey}:revoked`,
    occurred_at: revokedAt,
    source_kind: "correction",
    allocation_start: correctionStart,
    active_memberships: -1,
    reverses_fact_key: factKey,
  });
  return { assignment, correction };
}
