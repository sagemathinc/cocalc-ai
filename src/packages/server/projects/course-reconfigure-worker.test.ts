/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { isTransientCourseReconfigureError } from "./course-reconfigure-worker";

describe("course reconfiguration transient errors", () => {
  it.each(["40P01", "40001"])("retries PostgreSQL error code %s", (code) => {
    expect(isTransientCourseReconfigureError({ code })).toBe(true);
  });

  it.each([
    "error: deadlock detected",
    "could not serialize access due to concurrent update",
  ])("retries routed errors containing %s", (message) => {
    expect(isTransientCourseReconfigureError(new Error(message))).toBe(true);
  });

  it("does not retry permanent failures", () => {
    expect(
      isTransientCourseReconfigureError(new Error("project not found")),
    ).toBe(false);
  });
});
