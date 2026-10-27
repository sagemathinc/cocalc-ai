/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { projectMembershipAuditHealth } from "./membership-audit-health";

const ok = {
  state: "ok" as const,
  recent_failures: 0,
  last_error: null,
  last_failed_at: null,
};

describe("project membership audit health", () => {
  it("is healthy when the trigger is current and nothing failed", () => {
    expect(projectMembershipAuditHealth(ok).level).toBe("healthy");
  });

  it("warns about recent recording failures, with the last error", () => {
    const health = projectMembershipAuditHealth({
      ...ok,
      recent_failures: 3,
      last_error: 'relation "central_log" does not exist',
      last_failed_at: new Date("2026-10-27T00:00:00Z"),
    });
    expect(health.level).toBe("warning");
    expect(health.details[0]).toContain("3 membership change(s)");
    expect(health.details[0]).toContain("central_log");
  });

  it.each([
    ["missing", "critical"],
    ["disabled", "critical"],
    ["outdated", "warning"],
  ] as const)("reports a %s trigger as %s", (state, level) => {
    expect(projectMembershipAuditHealth({ ...ok, state }).level).toBe(level);
  });
});
