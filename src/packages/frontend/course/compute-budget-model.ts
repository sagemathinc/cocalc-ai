/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { CourseFundingDraft } from "@cocalc/util/compute-funding";
import { normalizeCourseFundingDraft } from "@cocalc/util/compute-funding";
import { moneyToDbString, toDecimal } from "@cocalc/util/money";
import type { StudentsMap } from "./store";

export interface BudgetStudent {
  id: string;
  account_id?: string;
  name: string;
  email?: string;
}

export function budgetStudents(students: StudentsMap): BudgetStudent[] {
  return students
    .valueSeq()
    .toArray()
    .filter(
      (student) => !student.get("deleted") && !student.get("deleted_account"),
    )
    .map((student) => ({
      id: student.get("student_id"),
      account_id: student.get("account_id"),
      name:
        student.get("display_name") ||
        [student.get("first_name"), student.get("last_name")]
          .filter(Boolean)
          .join(" ") ||
        student.get("email_address") ||
        "Unnamed student",
      email: student.get("email_address"),
    }));
}

export function allocationDraft(opts: {
  course_project_id: string;
  course_instance_id: string;
  students: BudgetStudent[];
  selected: string[];
  per_student_usd: string;
  lane: CourseFundingDraft["lane"];
  starts_at: string;
  ends_at: string;
  pool_usd?: string;
  allow_overcommit: boolean;
}): CourseFundingDraft {
  const selected = new Set(opts.selected);
  const accounts = new Set<string>();
  for (const student of opts.students) {
    if (!selected.has(student.id)) continue;
    if (!student.account_id)
      throw new Error(
        "Selected students need an account before receiving credit.",
      );
    accounts.add(student.account_id.toLowerCase());
  }
  if (!accounts.size) throw new Error("Select at least one student.");
  return normalizeCourseFundingDraft({
    course_project_id: opts.course_project_id,
    course_instance_id: opts.course_instance_id,
    currency: "USD",
    lane: opts.lane,
    starts_at: new Date(opts.starts_at).toISOString(),
    ends_at: new Date(opts.ends_at).toISOString(),
    allow_overcommit: opts.allow_overcommit,
    amount_usd:
      opts.pool_usd ??
      moneyToDbString(toDecimal(opts.per_student_usd).mul(accounts.size)),
    recipients: [...accounts].map((beneficiary_account_id) => ({
      beneficiary_account_id,
      amount_usd: opts.per_student_usd,
    })),
  });
}

export function localDateTime(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

export function budgetCsv(rows: Array<Array<string | number>>): string {
  // Spreadsheet applications may execute formulas even in quoted CSV cells.
  return rows
    .map((row) =>
      row
        .map((value) => {
          let text = String(value);
          if (/^[\s]*[=+@\-]/.test(text) || /^[\t\r\n]/.test(text))
            text = `'${text}`;
          return `"${text.replaceAll('"', '""')}"`;
        })
        .join(","),
    )
    .join("\r\n");
}
