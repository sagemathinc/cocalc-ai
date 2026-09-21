import { fromJS } from "immutable";
import {
  allocationDraft,
  budgetCsv,
  budgetStudents,
} from "./compute-budget-model";
import type { StudentsMap } from "./store";

const account = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const defaults = {
  course_project_id: "33333333-3333-4333-8333-333333333333",
  course_instance_id: "44444444-4444-4444-8444-444444444444",
  starts_at: "2026-09-12T00:00:00Z",
  ends_at: "2026-09-19T00:00:00Z",
  lane: "prepaid" as const,
  per_student_usd: "50",
  allow_overcommit: false,
  students: [
    { id: "a", name: "Alice", account_id: account },
    { id: "b", name: "Bob", account_id: other },
  ],
  selected: ["a", "b"],
};

it("creates one batch with exact decimal totals and account recipients", () => {
  const draft = allocationDraft({ ...defaults, per_student_usd: "0.29" });
  expect(Number(draft.amount_usd)).toBe(0.58);
  expect(
    draft.recipients.map((recipient) => recipient.beneficiary_account_id),
  ).toEqual([account, other]);
});

it("does not double allocate duplicate course rows for the same account", () => {
  const draft = allocationDraft({
    ...defaults,
    students: [
      defaults.students[0],
      { ...defaults.students[1], account_id: account },
    ],
  });
  expect(draft.recipients).toHaveLength(1);
  expect(Number(draft.amount_usd)).toBe(50);
});

it("requires a selected linked account and explicit overcommit", () => {
  expect(() => allocationDraft({ ...defaults, selected: [] })).toThrow(
    "Select",
  );
  expect(() =>
    allocationDraft({ ...defaults, students: [{ id: "a", name: "Unlinked" }] }),
  ).toThrow("account");
  expect(() => allocationDraft({ ...defaults, pool_usd: "50" })).toThrow(
    "exceed",
  );
  expect(
    Number(
      allocationDraft({ ...defaults, pool_usd: "50", allow_overcommit: true })
        .amount_usd,
    ),
  ).toBe(50);
});

it("normalizes immutable course students without retaining removed accounts", () => {
  const students = fromJS({
    a: { student_id: "a", account_id: account, first_name: "Alice" },
    b: { student_id: "b", deleted: true },
    c: { student_id: "c", deleted_account: true },
    d: { student_id: "d", email_address: "pending@example.test" },
  }) as StudentsMap;
  expect(budgetStudents(students)).toEqual([
    { id: "a", account_id: account, name: "Alice", email: undefined },
    {
      id: "d",
      account_id: undefined,
      name: "pending@example.test",
      email: "pending@example.test",
    },
  ]);
});

it("quotes CSV values and neutralizes spreadsheet formulas", () => {
  expect(
    budgetCsv([["=1+1", 'a"b', "line\nbreak", "12.30", "\t@SUM(A1)"]]),
  ).toBe('"\'=1+1","a""b","line\nbreak","12.30","\'\t@SUM(A1)"');
});
