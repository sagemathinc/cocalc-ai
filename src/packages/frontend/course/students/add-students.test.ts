/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { Map as iMap } from "immutable";

import { existingStudentEmails, parseRoster } from "./add-students";

function roster(students: Record<string, Record<string, unknown>>) {
  return iMap(
    Object.entries(students).map(([id, student]) => [id, iMap(student)]),
  ) as any;
}

describe("adding students to a course", () => {
  it("treats current students' emails as already in the course", () => {
    const existing = existingStudentEmails(
      roster({ a: { email_address: "Ada@Example.edu" } }),
    );
    expect(parseRoster("ada@example.edu", existing)).toMatchObject({
      students: [],
      alreadyAdded: ["ada@example.edu"],
    });
  });

  it("lets a deleted student's email be added again", () => {
    const existing = existingStudentEmails(
      roster({
        a: { email_address: "ada@example.edu", deleted: true },
        b: { email_address: "grace@example.edu" },
      }),
    );
    expect([...existing]).toEqual(["grace@example.edu"]);
    const parsed = parseRoster("ada@example.edu", existing);
    expect(parsed.alreadyAdded).toEqual([]);
    expect(parsed.students.map((s) => s.email_address)).toEqual([
      "ada@example.edu",
    ]);
  });
});
