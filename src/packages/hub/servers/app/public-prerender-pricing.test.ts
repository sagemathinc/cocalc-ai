/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  PUBLIC_PRICING_CUSTOMER_OPERATED,
  PUBLIC_PRICING_INCLUDED_AI_ALERT,
  PUBLIC_PRICING_NO_TIERS,
  PUBLIC_PRICING_ORGANIZATION_LICENSING,
  PUBLIC_PRICING_PRODUCT_QUOTES,
  PUBLIC_PRICING_PROJECT_HOSTS,
  PUBLIC_PRICING_TEAM_SEATS,
  PUBLIC_PRICING_TEAMS_TITLE,
  type PublicPricingTier,
} from "@cocalc/util/public-pricing";
import { renderPublicRoutePrerender } from "./public-prerender";

// Shaped like rows of the membership_tiers table: numeric prices arrive as
// strings, and the table also holds tiers that are not sold in the store.
const TIERS: PublicPricingTier[] = [
  {
    ai_limits: { units_5h: 150, units_7d: 500 },
    id: "member",
    label: "Member",
    presentation: { tagline: "Unused, the store description wins." },
    price_monthly: "25.0000000000",
    price_yearly: "225.0000000000",
    priority: 20,
    store_description: "A solid choice for everyday work.",
    store_highlights: ["Stronger shared resources", " ", "Network <access>"],
    store_visible: true,
    trial_days: 7,
  },
  {
    ai_limits: { units_5h: 50, units_7d: 100 },
    id: "free",
    label: "Free",
    presentation: { tagline: "A light entry point." },
    price_monthly: "0.0000000000",
    price_yearly: "0.0000000000",
    priority: 10,
    store_highlights: [],
    store_visible: true,
    trial_days: 0,
  },
  {
    id: "student-university-term",
    label: "University Student Term",
    price_monthly: "8.0000000000",
    price_yearly: "72.0000000000",
    priority: 5,
    store_visible: false,
  },
  {
    disabled: true,
    id: "retired",
    label: "Retired Plan",
    price_monthly: "13.0000000000",
    price_yearly: "130.0000000000",
    priority: 15,
    store_visible: true,
  },
];

function renderPricing(
  pricingTiers?: readonly PublicPricingTier[],
  cocalc_product = "launchpad",
  basePath = "/",
): string {
  return renderPublicRoutePrerender(
    { section: "pricing" },
    basePath,
    { cocalc_product },
    { pricingTiers },
  );
}

function listItems(html: string, section: string): string[] {
  const start = html.indexOf(`<h2>${section}</h2>`);
  expect(start).toBeGreaterThanOrEqual(0);
  const body = html.slice(start, html.indexOf("</section>", start));
  return Array.from(body.matchAll(/<h3>([\s\S]*?)<\/h3>/g), ([, title]) =>
    title.replace(/<[^>]*>/g, ""),
  );
}

describe("pricing initial HTML from membership tier data", () => {
  it("lists the store-visible tiers with prices from the tier data", () => {
    const html = renderPricing(TIERS);

    expect(listItems(html, "Hosted memberships")).toEqual(["Free", "Member"]);
    expect(html).toContain(
      "<li><h3>Member</h3><p>7-day free trial</p><p>Annual: $18.75 / mo · Billed annually, saving 25%</p><p>Monthly: $25 / month · Save 25% with annual billing</p><p>A solid choice for everyday work.</p><ul><li>Stronger shared resources</li><li>Network &lt;access&gt;</li></ul></li>",
    );
    // A free tier shows no price, as on the React tier card.
    expect(html).toContain("<li><h3>Free</h3><p>A light entry point.</p></li>");
    expect(html).not.toContain("University Student Term");
    expect(html).not.toContain("Retired Plan");
    expect(html).not.toContain("$8");
    expect(html).not.toContain("$13");
    expect(html).not.toContain("appear on this page when it loads");
    expect(html).toContain(`<p>${PUBLIC_PRICING_INCLUDED_AI_ALERT}</p>`);
  });

  it("shows the AI alert only when a listed tier includes AI usage", () => {
    const withoutAi = TIERS.map((tier) => ({ ...tier, ai_limits: undefined }));
    expect(renderPricing(withoutAi)).not.toContain(
      PUBLIC_PRICING_INCLUDED_AI_ALERT,
    );
    // AI on a tier that is not in the store does not count.
    expect(
      renderPricing([
        ...withoutAi,
        {
          ai_limits: { units_5h: 100 },
          id: "hidden",
          price_monthly: 1,
          price_yearly: 10,
          store_visible: false,
        },
      ]),
    ).not.toContain(PUBLIC_PRICING_INCLUDED_AI_ALERT);
  });

  it("keeps today's text when no tier data was loaded", () => {
    const html = renderPricing(undefined);

    expect(html).toContain(
      "Use CoCalc.ai without operating CoCalc yourself. Current membership tiers, limits, and billing choices appear on this page when it loads.",
    );
    expect(html).not.toContain(PUBLIC_PRICING_INCLUDED_AI_ALERT);
    expect(html).not.toContain(PUBLIC_PRICING_NO_TIERS);
  });

  it("says so when the store has no tiers", () => {
    const html = renderPricing(TIERS.filter(({ id }) => id === "retired"));

    expect(html).toContain(`<p>${PUBLIC_PRICING_NO_TIERS}</p>`);
    expect(html).not.toContain("<h3>Retired Plan</h3>");
  });

  it("does not list membership tiers for CoCalc Plus", () => {
    const html = renderPricing(TIERS, "plus");

    expect(html).not.toContain("Hosted memberships");
    expect(html).not.toContain("<h3>Member</h3>");
    expect(html).not.toContain(PUBLIC_PRICING_INCLUDED_AI_ALERT);
    expect(listItems(html, "Licensing and Deployment")).toEqual([
      PUBLIC_PRICING_CUSTOMER_OPERATED.title,
      PUBLIC_PRICING_PRODUCT_QUOTES.title,
    ]);
  });

  it.each([
    ["plus", undefined],
    ["plus", TIERS],
    ["launchpad", undefined],
    ["rocket", undefined],
  ])(
    "prints no dollar amount that is not in the tier data (%s)",
    (product, tiers) => {
      expect(renderPricing(tiers, product)).not.toMatch(/\$\s*\d/);
    },
  );
});

describe("pricing initial HTML team options", () => {
  it.each([
    ["launchpad", true],
    ["rocket", true],
    ["invalid", false],
  ])(
    "renders the pricing page's team options for %s",
    (product, researchCompute) => {
      const html = renderPricing(undefined, product, "/prefix");

      expect(listItems(html, PUBLIC_PRICING_TEAMS_TITLE)).toEqual([
        PUBLIC_PRICING_TEAM_SEATS.title,
        PUBLIC_PRICING_ORGANIZATION_LICENSING.title,
        ...(researchCompute ? [PUBLIC_PRICING_PROJECT_HOSTS.title] : []),
        PUBLIC_PRICING_CUSTOMER_OPERATED.title,
      ]);
      for (const option of [
        PUBLIC_PRICING_TEAM_SEATS,
        PUBLIC_PRICING_ORGANIZATION_LICENSING,
        PUBLIC_PRICING_CUSTOMER_OPERATED,
      ]) {
        expect(html).toContain(`<p>${option.body}</p>`);
      }
      expect(html).toContain(
        '<a href="/prefix/auth/sign-up">Create account for team seats</a>',
      );
      expect(html).toContain(
        '<a href="/prefix/products">Compare customer-operated options</a>',
      );
      expect(html.includes("/prefix/features/research-compute")).toBe(
        researchCompute,
      );
    },
  );
});
