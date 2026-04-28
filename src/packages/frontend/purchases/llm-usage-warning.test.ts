/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { LLMUsageStatus } from "@cocalc/conat/hub/api/purchases";
import {
  MANAGED_EGRESS_SEVERE_THRESHOLD,
  MANAGED_EGRESS_WARNING_THRESHOLD,
} from "./managed-egress-warning";
import { getLLMWindowWarnings } from "./llm-usage-warning";

function makeStatus({
  used5h = 0,
  limit5h = 0,
  used7d = 0,
  limit7d = 0,
}: {
  used5h?: number;
  limit5h?: number;
  used7d?: number;
  limit7d?: number;
}): LLMUsageStatus {
  return {
    units_per_dollar: 1000,
    windows: [
      {
        window: "5h",
        used: used5h,
        limit: limit5h,
      },
      {
        window: "7d",
        used: used7d,
        limit: limit7d,
      },
    ],
  };
}

describe("getLLMWindowWarnings", () => {
  it("returns no warnings below the threshold", () => {
    const status = makeStatus({
      used5h: Math.floor(1000 * (MANAGED_EGRESS_WARNING_THRESHOLD - 0.01)),
      limit5h: 1000,
    });
    expect(getLLMWindowWarnings(status)).toEqual([]);
  });

  it("returns warning and severe states", () => {
    const status = makeStatus({
      used5h: Math.ceil(1000 * MANAGED_EGRESS_WARNING_THRESHOLD),
      limit5h: 1000,
      used7d: Math.ceil(5000 * MANAGED_EGRESS_SEVERE_THRESHOLD),
      limit7d: 5000,
    });
    expect(getLLMWindowWarnings(status)).toEqual([
      expect.objectContaining({
        window: "7d",
        severity: "severe",
        percent: 90,
      }),
      expect.objectContaining({
        window: "5h",
        severity: "warning",
        percent: 75,
      }),
    ]);
  });

  it("prefers blocked windows first", () => {
    const status = makeStatus({
      used5h: 950,
      limit5h: 1000,
      used7d: 5100,
      limit7d: 5000,
    });
    const warnings = getLLMWindowWarnings(status);
    expect(warnings[0]).toEqual(
      expect.objectContaining({
        window: "7d",
        severity: "blocked",
      }),
    );
    expect(warnings[1]).toEqual(
      expect.objectContaining({
        window: "5h",
        severity: "severe",
      }),
    );
  });
});
