/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { MembershipAllocationDailyRow } from "@cocalc/conat/hub/api/purchases";
import {
  buildMembershipAnalyticsView,
  totalMembershipAnalyticsPoints,
} from "./personal-membership-analytics-view";

const tiers = [
  { id: "standard", label: "Standard", priority: 20 },
  { id: "pro", label: "Pro", priority: 30 },
];

function row(
  day: string,
  overrides: Partial<MembershipAllocationDailyRow> = {},
): MembershipAllocationDailyRow {
  return {
    day,
    channel: "personal",
    membership_class: "standard",
    billing_interval: "month",
    lifecycle: "first_paid",
    previous_membership_class: null,
    previous_billing_interval: null,
    tier_change: "none",
    active_memberships: 1,
    purchased_capacity: 0,
    revenue_cents: 100,
    fact_count: 1,
    ...overrides,
  };
}

describe("personal membership analytics view", () => {
  it("aggregates default series by tier and compares aligned days", () => {
    const view = buildMembershipAnalyticsView({
      rows: [
        row("2026-08-01", { active_memberships: 2, revenue_cents: 100 }),
        row("2026-08-01", {
          billing_interval: "year",
          lifecycle: "renewal",
          active_memberships: 3,
          revenue_cents: 200,
        }),
        row("2026-08-01", {
          membership_class: "pro",
          active_memberships: 1,
          revenue_cents: 400,
        }),
        row("2026-08-08", { active_memberships: 7, revenue_cents: 500 }),
        row("2026-08-08", {
          membership_class: "pro",
          active_memberships: 2,
          revenue_cents: 800,
        }),
      ],
      tiers,
      breakdown: "tier",
      start: "2026-08-08",
      end: "2026-08-08",
      historyStart: "2026-08-01",
      comparisonDays: 7,
    });

    expect(view.comparisonAvailable).toBe(true);
    expect(view.series.map(({ label }) => label)).toEqual(["Pro", "Standard"]);
    expect(view.summary).toEqual([
      {
        key: "total",
        label: "Total",
        total: true,
        activeMemberships: 9,
        comparisonActiveMemberships: 6,
        revenueCents: 1300,
        comparisonRevenueCents: 700,
      },
      {
        key: "tier:pro",
        label: "Pro",
        activeMemberships: 2,
        comparisonActiveMemberships: 1,
        revenueCents: 800,
        comparisonRevenueCents: 400,
      },
      {
        key: "tier:standard",
        label: "Standard",
        activeMemberships: 7,
        comparisonActiveMemberships: 5,
        revenueCents: 500,
        comparisonRevenueCents: 300,
      },
    ]);
  });

  it("keeps tier grouping while exposing lifecycle detail", () => {
    const view = buildMembershipAnalyticsView({
      rows: [
        row("2026-08-08", {
          membership_class: "pro",
          lifecycle: "renewal",
          active_memberships: 4,
        }),
        row("2026-08-08", {
          membership_class: "pro",
          lifecycle: "first_paid",
          active_memberships: 1,
        }),
        row("2026-08-08", {
          billing_interval: "trial",
          lifecycle: "trial",
          active_memberships: 2,
          revenue_cents: 0,
        }),
      ],
      tiers,
      breakdown: "tier-lifecycle",
      start: "2026-08-08",
      end: "2026-08-08",
    });

    expect(
      view.series.map(
        ({ label, groupLabel, detailLabel, tierId, variant }) => ({
          label,
          groupLabel,
          detailLabel,
          tierId,
          variant,
        }),
      ),
    ).toEqual([
      {
        label: "Pro · First paid",
        groupLabel: "Pro",
        detailLabel: "First paid",
        tierId: "pro",
        variant: "first_paid",
      },
      {
        label: "Pro · Renewal",
        groupLabel: "Pro",
        detailLabel: "Renewal",
        tierId: "pro",
        variant: "renewal",
      },
      {
        label: "Standard · Trial",
        groupLabel: "Standard",
        detailLabel: "Trial",
        tierId: "standard",
        variant: "trial",
      },
    ]);
    expect(view.summary[0]).toMatchObject({
      activeMemberships: 7,
      revenueCents: 200,
    });
  });

  it("keeps equal-priority tiers together before ordering lifecycle", () => {
    const view = buildMembershipAnalyticsView({
      rows: [
        row("2026-08-08", {
          membership_class: "basic",
          lifecycle: "renewal",
        }),
        row("2026-08-08", {
          membership_class: "student",
          lifecycle: "first_paid",
        }),
        row("2026-08-08", {
          membership_class: "basic",
          lifecycle: "first_paid",
        }),
        row("2026-08-08", {
          membership_class: "student",
          lifecycle: "renewal",
        }),
      ],
      tiers: [
        { id: "student", label: "Student", priority: 10 },
        { id: "basic", label: "Basic", priority: 10 },
      ],
      breakdown: "tier-lifecycle",
      start: "2026-08-08",
      end: "2026-08-08",
    });

    expect(view.series.map(({ label }) => label)).toEqual([
      "Basic · First paid",
      "Basic · Renewal",
      "Student · First paid",
      "Student · Renewal",
    ]);
  });

  it("produces comparison totals on the current display dates", () => {
    const view = buildMembershipAnalyticsView({
      rows: [
        row("2026-08-01", { revenue_cents: 125 }),
        row("2026-08-08", { revenue_cents: 250 }),
      ],
      tiers,
      breakdown: "tier",
      start: "2026-08-08",
      end: "2026-08-08",
      historyStart: "2026-08-01",
      comparisonDays: 7,
    });
    expect(totalMembershipAnalyticsPoints(view.series, "comparison")).toEqual([
      {
        displayDay: "2026-08-08",
        actualDay: "2026-08-01",
        activeMemberships: 1,
        revenueCents: 125,
      },
    ]);
  });

  it("reports zero on the selected end day after allocations expire", () => {
    const view = buildMembershipAnalyticsView({
      rows: [row("2026-08-01")],
      tiers,
      breakdown: "tier",
      start: "2026-08-08",
      end: "2026-08-10",
      historyStart: "2026-08-01",
      comparisonDays: 7,
    });

    expect(view.latestDay).toBe("2026-08-10");
    expect(view.comparisonAvailable).toBe(true);
    expect(view.summary[0]).toMatchObject({
      activeMemberships: 0,
      comparisonActiveMemberships: 0,
      revenueCents: 0,
      comparisonRevenueCents: 0,
    });
  });

  it("does not compare against a day before the fetched history", () => {
    const view = buildMembershipAnalyticsView({
      rows: [row("2026-08-08")],
      tiers,
      breakdown: "tier",
      start: "2026-08-08",
      end: "2026-08-08",
      historyStart: "2026-08-05",
      comparisonDays: 7,
    });

    expect(view.comparisonAvailable).toBe(false);
  });
});
