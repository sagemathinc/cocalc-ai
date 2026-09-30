/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  membershipPriceDisplay,
  membershipStoreDescription,
  membershipStoreHighlights,
  membershipTiersIncludeAi,
  membershipTrialLabel,
  publicStoreMembershipTiers,
} from "./public-pricing";

describe("store-visible membership tiers", () => {
  it("keeps only enabled store tiers, in display order", () => {
    const tiers = publicStoreMembershipTiers([
      { id: "pro", label: "Pro", priority: 30, store_visible: true },
      { id: "course", label: "Course", priority: 5, store_visible: false },
      { id: "team", label: "Team", priority: 6 },
      {
        disabled: true,
        id: "retired",
        label: "Retired",
        priority: 1,
        store_visible: true,
      },
      { id: "free", label: "Free", priority: 0, store_visible: true },
      {
        disabled: false,
        id: "basic",
        label: "Basic",
        priority: 10,
        store_visible: true,
      },
    ]);

    expect(tiers.map(({ id }) => id)).toEqual(["free", "basic", "pro"]);
  });

  it("detects included AI only on tiers with a positive allowance", () => {
    expect(
      membershipTiersIncludeAi([
        { ai_limits: { units_5h: 0, units_7d: 0 }, id: "a" },
        { id: "b" },
      ]),
    ).toBe(false);
    expect(
      membershipTiersIncludeAi([{ ai_limits: { units_7d: 100 }, id: "a" }]),
    ).toBe(true);
  });
});

describe("membership price display", () => {
  it("shows the monthly-equivalent price and annual savings", () => {
    // Database numeric columns arrive as strings.
    const tier = { price_monthly: "25.0000", price_yearly: "225.0000" };

    expect(membershipPriceDisplay(tier, "year")).toEqual({
      amount: "$18.75",
      billingLine: "Billed annually, saving 25%",
      suffix: "/ mo",
    });
    expect(membershipPriceDisplay(tier, "month")).toEqual({
      amount: "$25",
      billingLine: "Save 25% with annual billing",
      suffix: "/ month",
    });
  });

  it("omits savings that do not exist", () => {
    const tier = { price_monthly: 10, price_yearly: 120 };

    expect(membershipPriceDisplay(tier, "year")).toEqual({
      amount: "$10",
      billingLine: "Billed annually",
      suffix: "/ month",
    });
    expect(membershipPriceDisplay(tier, "month")?.billingLine).toBeUndefined();
  });

  it("shows no price for a free tier", () => {
    const tier = { price_monthly: "0.00", price_yearly: 0 };

    expect(membershipPriceDisplay(tier, "year")).toBeUndefined();
    expect(membershipPriceDisplay(tier, "month")).toBeUndefined();
  });
});

describe("membership store text", () => {
  it("uses the configured description, then the tagline", () => {
    expect(
      membershipStoreDescription({
        presentation: { tagline: "Tagline." },
        store_description: "  Store text.  ",
      }),
    ).toBe("Store text.");
    expect(
      membershipStoreDescription({
        presentation: { tagline: "Tagline." },
        store_description: " ",
      }),
    ).toBe("Tagline.");
  });

  it("drops blank highlights", () => {
    expect(
      membershipStoreHighlights({ store_highlights: ["One", " ", "", "Two"] }),
    ).toEqual(["One", "Two"]);
    expect(membershipStoreHighlights({})).toEqual([]);
  });

  it("labels positive trials only", () => {
    expect(membershipTrialLabel({ trial_days: 7.5 })).toBe("7-day free trial");
    expect(membershipTrialLabel({ trial_days: 0 })).toBeUndefined();
    expect(membershipTrialLabel({ trial_days: "7" })).toBeUndefined();
  });
});
