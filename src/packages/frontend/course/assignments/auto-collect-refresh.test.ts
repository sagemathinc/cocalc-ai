/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  AUTO_COLLECT_REFRESH_MARGIN_MS,
  autoCollectMissingStudents,
} from "./auto-collect-refresh";

const NOW = Date.parse("2026-10-01T20:48:00Z");
const RUN_AT = "2026-10-10T03:00:00.000Z";

function queued(studentIds: string[]) {
  return {
    status: "queued" as const,
    input: { items: studentIds.map((student_id) => ({ student_id })) },
  };
}

describe("autoCollectMissingStudents", () => {
  it("finds students assigned after the collection was scheduled (support #20954)", () => {
    expect(
      autoCollectMissingStudents({
        summary: queued(["s1"]),
        runAt: RUN_AT,
        eligibleStudentIds: ["s1", "s2", "s3"],
        now: NOW,
      }),
    ).toEqual(["s2", "s3"]);
  });

  it("needs no change when every eligible student is scheduled", () => {
    expect(
      autoCollectMissingStudents({
        summary: queued(["s1", "s2"]),
        runAt: RUN_AT,
        eligibleStudentIds: ["s2", "s1"],
        now: NOW,
      }),
    ).toEqual([]);
  });

  it("leaves collections that already started, finished or were canceled alone", () => {
    for (const status of ["running", "succeeded", "failed", "canceled"]) {
      expect(
        autoCollectMissingStudents({
          summary: { status: status as any, input: { items: [] } },
          runAt: RUN_AT,
          eligibleStudentIds: ["s1"],
          now: NOW,
        }),
      ).toEqual([]);
    }
    expect(
      autoCollectMissingStudents({
        summary: null,
        runAt: RUN_AT,
        eligibleStudentIds: ["s1"],
        now: NOW,
      }),
    ).toEqual([]);
  });

  it("does not race the worker close to the run time", () => {
    const runAt = new Date(
      NOW + AUTO_COLLECT_REFRESH_MARGIN_MS - 1,
    ).toISOString();
    expect(
      autoCollectMissingStudents({
        summary: queued([]),
        runAt,
        eligibleStudentIds: ["s1"],
        now: NOW,
      }),
    ).toEqual([]);
    expect(
      autoCollectMissingStudents({
        summary: queued([]),
        runAt: "not a date",
        eligibleStudentIds: ["s1"],
        now: NOW,
      }),
    ).toEqual([]);
  });

  it("tolerates a summary without items", () => {
    expect(
      autoCollectMissingStudents({
        summary: { status: "queued", input: {} },
        runAt: RUN_AT,
        eligibleStudentIds: ["s1"],
        now: NOW,
      }),
    ).toEqual(["s1"]);
  });
});
