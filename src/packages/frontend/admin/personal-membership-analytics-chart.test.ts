/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  buildMembershipAnalyticsHoverModel,
  buildMembershipAnalyticsSeriesVisuals,
  nearestMembershipAnalyticsHoverPointIndex,
} from "./personal-membership-analytics-chart";
import type { MembershipAnalyticsSeries } from "./personal-membership-analytics-view";

function series(
  key: string,
  tierId: string,
  variant: MembershipAnalyticsSeries["variant"],
): MembershipAnalyticsSeries {
  return {
    key,
    label: key,
    tierId,
    variant,
    priority: tierId === "pro" ? 30 : 20,
    order: 0,
    current: [],
    comparison: [],
  };
}

describe("personal membership analytics chart", () => {
  it("selects the line nearest the pointer in x-axis hover mode", () => {
    const points = [
      {
        y: 10,
        data: { meta: { seriesKey: "student", comparison: false } },
      },
      {
        y: 55,
        data: { meta: { seriesKey: "standard", comparison: true } },
      },
      {
        y: 90,
        data: { meta: { seriesKey: "pro", comparison: false } },
      },
    ];

    expect(nearestMembershipAnalyticsHoverPointIndex(points, 60)).toBe(1);
    expect(nearestMembershipAnalyticsHoverPointIndex(points, 88)).toBe(2);
  });

  it("uses one tier hue with distinct opaque lifecycle fills", () => {
    const visuals = buildMembershipAnalyticsSeriesVisuals({
      series: [
        series("pro-new", "pro", "first_paid"),
        series("pro-renewal", "pro", "renewal"),
        series("standard-new", "standard", "first_paid"),
      ],
      tiers: [
        { id: "standard", priority: 20 },
        { id: "pro", priority: 30 },
      ],
      breakdown: "tier-lifecycle",
    });

    expect(visuals[0].color).toBe(visuals[1].color);
    expect(visuals[0].fillColor).toBe(visuals[0].color);
    expect(visuals[1].fillColor).not.toBe(visuals[1].color);
    expect(visuals[0].fillColor).not.toBe(visuals[1].fillColor);
    expect(visuals[0].lineDash).toBe("solid");
    expect(visuals[1].lineDash).toBe("dash");
    expect(visuals[0].opacity).toBe(1);
    expect(visuals[1].opacity).toBe(1);
    expect(visuals[2].color).not.toBe(visuals[0].color);
  });

  it("uses line patterns rather than opacity for sub-tier variants", () => {
    const visuals = buildMembershipAnalyticsSeriesVisuals({
      series: [
        series("first", "pro", "first_paid"),
        series("change", "pro", "plan_change"),
        series("renewal", "pro", "renewal"),
        series("trial", "pro", "trial"),
      ],
      tiers: [{ id: "pro", priority: 30 }],
      breakdown: "tier-lifecycle",
    });

    expect(visuals.map(({ lineDash }) => lineDash)).toEqual([
      "solid",
      "dot",
      "dash",
      "dashdot",
    ]);
    expect(visuals.every(({ opacity }) => opacity === 1)).toBe(true);
  });

  it("uses the base tier color as the simple stacked fill", () => {
    const visuals = buildMembershipAnalyticsSeriesVisuals({
      series: [series("pro", "pro", undefined)],
      tiers: [{ id: "pro", priority: 30 }],
      breakdown: "tier",
    });

    expect(visuals[0].fillColor).toBe(visuals[0].color);
  });

  it("keeps single-dimension breakdowns solid", () => {
    const visuals = buildMembershipAnalyticsSeriesVisuals({
      series: [
        series("first", "first", "first_paid"),
        series("renewal", "renewal", "renewal"),
        series("trial", "trial", "trial"),
      ],
      tiers: [],
      breakdown: "lifecycle",
    });

    expect(visuals.every(({ lineDash }) => lineDash === "solid")).toBe(true);
  });

  it("aligns current and comparison values for a custom hover overlay", () => {
    const visuals = buildMembershipAnalyticsSeriesVisuals({
      series: [
        {
          ...series("Pro", "pro", "renewal"),
          current: [
            {
              displayDay: "2026-06-17",
              actualDay: "2026-06-17",
              activeMemberships: 8,
              revenueCents: 97800,
            },
          ],
          comparison: [
            {
              displayDay: "2026-06-17",
              actualDay: "2025-06-18",
              activeMemberships: 5,
              revenueCents: 53000,
            },
          ],
        },
      ],
      tiers: [{ id: "pro", priority: 30 }],
      breakdown: "tier",
    });

    expect(
      buildMembershipAnalyticsHoverModel({
        day: "2026-06-17",
        visuals,
        metric: "revenue",
        includeComparison: true,
      }),
    ).toMatchObject({
      currentDay: "2026-06-17",
      comparisonDay: "2025-06-18",
      currentTotal: 978,
      comparisonTotal: 530,
      rows: [
        {
          label: "Pro",
          current: 978,
          comparison: 530,
        },
      ],
    });
  });
});
