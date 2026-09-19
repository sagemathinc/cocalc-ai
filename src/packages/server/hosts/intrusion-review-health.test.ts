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
    retention: {
      latest_observation_at: new Date().toISOString(),
      latest_observation_age_ms: 1000,
    },
    ...overrides,
  } as HostIntrusionReviewReport;
}

describe("host intrusion review health", () => {
  it("reports unknown coverage when an empty reviewer pass has no observations", () => {
    expect(
      classifyHostIntrusionReviewHealth(
        report({
          retention: {
            latest_observation_at: null,
            latest_observation_age_ms: null,
          } as HostIntrusionReviewReport["retention"],
        }),
      ),
    ).toBe("unknown");
  });

  it("warns when the newest collector observation is stale", () => {
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
    ).toBe("warning");
  });
});
