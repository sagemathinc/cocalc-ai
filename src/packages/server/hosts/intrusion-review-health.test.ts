/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { HostIntrusionReviewReport } from "@cocalc/conat/hub/api/system";

import { classifyHostIntrusionReviewHealth } from "./intrusion-review-health";

function report(
  overrides: Partial<HostIntrusionReviewReport> = {},
): HostIntrusionReviewReport {
  return {
    reviewer: {
      last_error_at: null,
      last_success_at: new Date().toISOString(),
      last_success_age_ms: 1000,
      backlog: 0,
    },
    notifications: { failed: 0 },
    collector_coverage: {
      expected_interval_ms: 4 * 60 * 60 * 1000,
      max_observation_age_ms: 5 * 60 * 60 * 1000,
      active_hosts: 1,
      observed_hosts: 1,
      overdue_hosts: 0,
      overdue: [],
    },
    retention: {
      latest_observation_at: new Date().toISOString(),
      latest_observation_age_ms: 1000,
    },
    ...overrides,
  } as HostIntrusionReviewReport;
}

describe("host intrusion review health", () => {
  it("reports unknown coverage when an active host has no observations", () => {
    expect(
      classifyHostIntrusionReviewHealth(
        report({
          collector_coverage: {
            active_hosts: 1,
            observed_hosts: 0,
            overdue_hosts: 0,
          } as HostIntrusionReviewReport["collector_coverage"],
        }),
      ),
    ).toBe("unknown");
  });

  it("does not warn inside the default collector cadence", () => {
    expect(
      classifyHostIntrusionReviewHealth(
        report({
          retention: {
            latest_observation_at: new Date(
              Date.now() - 2 * 60 * 60 * 1000,
            ).toISOString(),
            latest_observation_age_ms: 2 * 60 * 60 * 1000,
          } as HostIntrusionReviewReport["retention"],
        }),
      ),
    ).toBe("healthy");
  });

  it("warns when any active host is overdue", () => {
    expect(
      classifyHostIntrusionReviewHealth(
        report({
          collector_coverage: {
            active_hosts: 2,
            observed_hosts: 2,
            overdue_hosts: 1,
          } as HostIntrusionReviewReport["collector_coverage"],
        }),
      ),
    ).toBe("warning");
  });
});
