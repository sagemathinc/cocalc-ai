/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { __test__ } from "./queries";

describe("growth analytics query boundaries", () => {
  it("defaults to the canonical project engagement signal", () => {
    const range = __test__.normalizeRange({
      start: "2026-08-01T00:00:00.000Z",
      end: "2026-08-09T00:00:00.000Z",
    });
    expect(range.activity_signal).toBe("project_engaged_v1");
  });

  it("rejects unbounded dashboard ranges", () => {
    expect(() =>
      __test__.normalizeRange({
        start: "2020-01-01T00:00:00.000Z",
        end: "2026-08-09T00:00:00.000Z",
      }),
    ).toThrow("limited to 730 days");
  });

  it("uses null for undefined conversion rates", () => {
    expect(__test__.percent(0, 0)).toBeNull();
    expect(__test__.percent(1, 3)).toBe(33.3);
  });

  it("describes recorded work without claiming user activation or value", () => {
    expect(__test__.metricLabel("activated_24h")).toBe(
      "First recorded work within 24h",
    );
    expect(__test__.metricLabel("first_meaningful_work")).toBe(
      "Recorded first work",
    );
    expect(__test__.metricLabel("project_work_v1")).toBe(
      "Recorded work active users",
    );
  });

  it("changes funnel copy without changing recorded counts", () => {
    const funnel = __test__.buildFunnelFromSeries({
      range: {
        start: new Date("2026-08-01T00:00:00.000Z"),
        end: new Date("2026-08-02T00:00:00.000Z"),
        activity_signal: "project_work_v1",
      },
      series: [
        {
          metric_name: "eligible_signups",
          metric_version: "test",
          label: "Eligible signups",
          points: [{ period_start: "2026-08-01", value: 10, partial: false }],
        },
        {
          metric_name: "first_meaningful_work",
          metric_version: "test",
          label: "Recorded first work",
          points: [{ period_start: "2026-08-01", value: 4, partial: false }],
        },
      ],
    });

    expect(
      funnel.steps.find(
        ({ milestone }) => milestone === "first_meaningful_work",
      ),
    ).toMatchObject({
      label: "Recorded first work",
      accounts: 4,
      conversion_from_created_pct: 40,
    });
  });
});
