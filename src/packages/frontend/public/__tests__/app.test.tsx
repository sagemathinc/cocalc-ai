/** @jest-environment jsdom */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import { setStoredControlPlaneOrigin } from "@cocalc/frontend/control-plane-origin";
import type { NewsItem } from "@cocalc/util/types/news";
import PublicApp from "../app";
import type { PublicAboutRoute } from "../about/routes";
import { getAboutRouteFromPath } from "../about/routes";
import type { PublicNewsRoute } from "../news/routes";
import { getNewsRouteFromPath } from "../news/routes";
import type { PublicPoliciesRoute } from "../policies/routes";
import { getPoliciesRouteFromPath } from "../policies/routes";
import { getPublicRouteFromPath, isPublicTarget, publicPath } from "../routes";
import type { PublicProductsRoute } from "../products/routes";
import { getProductsRouteFromPath } from "../products/routes";
import {
  combineLeak,
  INTERNAL_IMPLEMENTATION_TERMS,
  SECTION_H2_MAX,
  STALE_REPETITIVE_HOME_LINES,
  textLength,
} from "./test-helpers";

// Competitor names, invented compliance/proof claims, and stale home taglines
// must never leak onto the public products/pricing marketing surfaces. The
// STALE floor is shared with the home surface; the surface-unique bans here are
// the competitor set plus invented SOC2/GDPR/testimonial proof language. We do
// NOT fold in the full INTERNAL_IMPLEMENTATION_TERMS floor for this regex
// because some of those terms (e.g. "Kubernetes" on the Rocket page, "project
// hosts" on pricing) are legitimate public copy; the pure internal floor is
// asserted only on surfaces that are verified clean of it (the products
// overview).
const MARKETING_SURFACE_LEAK = combineLeak(
  STALE_REPETITIVE_HOME_LINES,
  /\bColab\b/,
  /\bDeepnote\b/,
  /\bOverleaf\b/,
  /\bRStudio\b/,
  /\bPosit\b/,
  /\bMathematica\b/,
  /\bMaple\b/,
  /\bMATLAB\b/,
  /\bSOC\s?2\b/,
  /\bGDPR\b/,
  /\btestimonial/,
);

function expectNoMarketingLeakage(scope: HTMLElement = document.body) {
  expect(scope.textContent ?? "").not.toMatch(MARKETING_SURFACE_LEAK);
}

// Pure internal/implementation-language floor. Only safe on surfaces that do
// not legitimately use any of these terms (products overview, home); detail
// product pages and pricing legitimately surface a couple of them.
function expectNoInternalFloor(scope: HTMLElement = document.body) {
  expect(scope.textContent ?? "").not.toMatch(INTERNAL_IMPLEMENTATION_TERMS);
  expect(scope.textContent ?? "").not.toMatch(STALE_REPETITIVE_HOME_LINES);
}

// The products path chooser renders five operating-model cards in a fixed
// order. We canary the count and the ordered product titles via a robust
// header-row selector (NOT a bare strong query) so card body copy can change
// without a test edit.
function expectProductPathChooserCards() {
  const cards = document.querySelectorAll(".cocalc-public-products-path-card");
  expect(cards).toHaveLength(5);
  const titles = Array.from(
    document.querySelectorAll(
      ".cocalc-public-products-path-card > div:first-child strong",
    ),
  ).map((el) => (el.textContent ?? "").trim());
  expect(titles).toEqual([
    "CoCalc.ai",
    "CoCalc Plus",
    "CoCalc Star",
    "CoCalc Launchpad",
    "CoCalc Rocket",
  ]);
}

// A product detail page has exactly one <h2> lead headline; assert its presence
// and an anti-sprawl length bound instead of pinning the marketing wording.
function expectSingleLeadHeadline() {
  const h2s = document.querySelectorAll("main h2");
  expect(h2s).toHaveLength(1);
  expect(textLength(h2s[0])).toBeLessThanOrEqual(SECTION_H2_MAX);
}

// A "Boundary: ..." detail card renders an explicit notes list; assert the
// item count (structure) plus one identity token for the surface.
function expectBoundaryNotes(
  name: string,
  count: number,
  identityToken: RegExp,
) {
  const card = screen.getByRole("region", { name });
  expect(within(card).getAllByRole("listitem")).toHaveLength(count);
  expect(within(card).getAllByText(identityToken).length).toBeGreaterThan(0);
}

const originalFetch = global.fetch;

beforeEach(() => {
  window.localStorage.clear();
  global.fetch = jest.fn(
    () => new Promise<Response>(() => undefined),
  ) as typeof fetch;
});

beforeEach(async () => {
  await Promise.all([
    import("../about/app"),
    import("../guides/app"),
    import("../news/app"),
    import("../policies/app"),
    import("../pricing/app"),
    import("../products/app"),
  ]);
});

afterEach(async () => {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  window.localStorage.clear();
  global.fetch = originalFetch;
});

const aboutRoute = (route: PublicAboutRoute) => ({
  route,
  section: "about" as const,
});
const newsRoute = (route: PublicNewsRoute) => ({
  route,
  section: "news" as const,
});
const policiesRoute = (route: PublicPoliciesRoute) => ({
  route,
  section: "policies" as const,
});
const productsRoute = (route: PublicProductsRoute) => ({
  route,
  section: "products" as const,
});
const pricingRoute = { section: "pricing" as const };

async function renderPublicApp(ui: React.ReactElement) {
  render(ui);
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function expectNoProductDetailStalePhrasing() {
  // Detail pages cannot use the full INTERNAL_IMPLEMENTATION_TERMS floor because
  // a few of its terms are legitimate public copy here (e.g. "Kubernetes" on the
  // Rocket page). So we keep the detail-safe internal bans explicitly, alongside
  // the product-detail-unique stale/invented phrasing.
  for (const phrase of [
    /serious technical/i,
    /multi-bay/i,
    /\bRootFS\b/i,
    /What CoCalc/i,
    /not HA/i,
    /production operations matter/i,
    /Production private cloud/i,
    /lower-level operator control plane/i,
    /local Lima/i,
    /agent sandbox/i,
    /^Next action$/i,
    /^Audience$/i,
    /^Deployment model$/i,
    /^Why choose it$/i,
    /setup-time/i,
    /restore-time/i,
    /deployment-time/i,
    /benchmark/i,
    /guaranteed support/i,
    /guaranteed response/i,
    /\bSLA\b/i,
    /managed private cloud/i,
    /sovereign cloud/i,
    /air-gapped/i,
    /basically an operating system/i,
    /all open format/i,
  ]) {
    expect(screen.queryByText(phrase)).toBeNull();
  }
  // Cross-surface competitor / invented-proof / stale-tagline floor.
  expectNoMarketingLeakage();
}

function expectSharedProjectContextNote() {
  // Identity + visual contract canary: the note region must exist with its
  // aria-label and its light, border-left, capped-width styling. The exact
  // sentences are intentionally NOT pinned — only presence/structure and an
  // anti-sprawl length bound, so copy can be reworded without a test edit.
  const note = screen.getByRole("note", {
    name: "Shared CoCalc project context",
  });
  const style = note.getAttribute("style") ?? "";
  expect(style).toContain("border-left");
  expect(style).toContain("max-width: 76ch");
  expect(style).not.toContain("background");
  expect(note.querySelector("strong")).not.toBeNull();
  expect(textLength(note)).toBeLessThanOrEqual(320);
}

describe("section route parsers", () => {
  it("supports deeper content routes under a base path", () => {
    expect(getAboutRouteFromPath("/about")).toEqual({ view: "about" });
    expect(getAboutRouteFromPath(publicPath("about/events"))).toEqual({
      view: "about-events",
    });
    expect(getAboutRouteFromPath(publicPath("about/team"))).toEqual({
      view: "about-team",
    });
    expect(
      getAboutRouteFromPath(publicPath("about/team/william-stein")),
    ).toEqual({
      teamSlug: "william-stein",
      view: "about-team-member",
    });
    expect(getPoliciesRouteFromPath(publicPath("policies/imprint"))).toEqual({
      view: "policies-imprint",
    });
    expect(getPoliciesRouteFromPath(publicPath("policies/policies"))).toEqual({
      view: "policies-custom",
    });
    expect(getPoliciesRouteFromPath(publicPath("policies/privacy"))).toEqual({
      policySlug: "privacy",
      view: "policies-detail",
    });
    expect(
      getNewsRouteFromPath(publicPath("news/launchpad-update-17")),
    ).toEqual({
      newsId: 17,
      view: "news-detail",
    });
    expect(
      getNewsRouteFromPath(publicPath("news/launchpad-update-17/1712345678")),
    ).toEqual({
      newsId: 17,
      timestamp: 1712345678,
      view: "news-history",
    });
    expect(getProductsRouteFromPath(publicPath("products"))).toEqual({
      view: "products",
    });
    expect(
      getProductsRouteFromPath(publicPath("products/cocalc-launchpad")),
    ).toEqual({ view: "products-cocalc-launchpad" });
    expect(
      getProductsRouteFromPath(publicPath("products/cocalc-plus")),
    ).toEqual({
      view: "products-cocalc-plus",
    });
    expect(
      getProductsRouteFromPath(publicPath("products/cocalc-rocket")),
    ).toEqual({
      view: "products-cocalc-rocket",
    });
    expect(
      getProductsRouteFromPath(publicPath("products/cocalc-star")),
    ).toEqual({
      view: "products-cocalc-star",
    });
    expect(getPublicRouteFromPath(publicPath("docs"))).toEqual({
      route: { view: "docs-index" },
      section: "docs",
    });
    expect(getPublicRouteFromPath(publicPath("guides"))).toEqual({
      section: "guides",
    });
    expect(
      getPublicRouteFromPath(publicPath("docs/projects/project-secrets")),
    ).toEqual({
      route: {
        slug: "projects/project-secrets",
        view: "docs-detail",
      },
      section: "docs",
    });
    expect(getPublicRouteFromPath(publicPath("support/status"))).toEqual({
      section: "not-found",
    });
  });

  it("recognizes product routes when booting from a static content entry", () => {
    expect(isPublicTarget("/")).toBe(true);
    expect(isPublicTarget("/products/cocalc-plus")).toBe(true);
    expect(isPublicTarget("/base/products/cocalc-plus")).toBe(true);
    expect(isPublicTarget("/software/cocalc-plus")).toBe(false);
    expect(isPublicTarget("/pricing")).toBe(true);
    expect(isPublicTarget("/features/jupyter-notebook")).toBe(true);
    expect(isPublicTarget("/guides")).toBe(true);
    expect(isPublicTarget("/docs/projects/project-secrets")).toBe(true);
    expect(isPublicTarget("/rootfs/minimal-jupyter")).toBe(true);
    expect(isPublicTarget("/invites/abc")).toBe(true);
  });

  it("uses an explicit not-found route for unknown public paths", () => {
    expect(getPublicRouteFromPath("/does-not-exist")).toEqual({
      section: "not-found",
    });
  });
});

describe("PublicApp", () => {
  it("fetches shared customize config when none is injected", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({
        configuration: {
          policy_pages: "sagemathinc",
          site_name: "Fetched Launchpad",
        },
      }),
    }) as typeof fetch;

    await renderPublicApp(
      <PublicApp initialRoute={aboutRoute({ view: "about" })} />,
    );

    expect(
      await screen.findByRole("heading", {
        name: "Meet the People Behind CoCalc",
      }),
    ).not.toBeNull();
  });

  it("renders a public not-found page for unknown routes", async () => {
    await renderPublicApp(
      <PublicApp
        config={{ site_name: "Launchpad" }}
        initialRoute={{ section: "not-found" }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Page not found" }),
    ).not.toBeNull();
    expect(
      screen.getByText(
        "The page you requested does not exist in the public site.",
      ),
    ).not.toBeNull();
    expect(screen.getByRole("link", { name: "Go to Home" })).not.toBeNull();
  });

  it("renders the about index", async () => {
    await renderPublicApp(
      <PublicApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={aboutRoute({ view: "about" })}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Meet the People Behind CoCalc" }),
    ).not.toBeNull();
    expect(screen.getByText("William Stein, Founder and CEO")).not.toBeNull();
    expect(screen.getByText(/Berkeley-trained mathematician/)).not.toBeNull();
    expect(screen.queryByText("Team")).toBeNull();
  });

  it("shows Projects and Settings in the shared nav when authenticated", async () => {
    await renderPublicApp(
      <PublicApp
        config={{ is_authenticated: true, site_name: "Launchpad" }}
        initialRoute={aboutRoute({ view: "about" })}
      />,
    );

    expect(screen.getByRole("link", { name: "Projects" })).not.toBeNull();
    expect(screen.getByRole("link", { name: "Settings" })).not.toBeNull();
  });

  it("renders the guides bridge page", async () => {
    await renderPublicApp(
      <PublicApp
        config={{ site_name: "Launchpad" }}
        initialRoute={{ section: "guides" }}
      />,
    );

    expect(screen.getByRole("heading", { name: "Guides" })).not.toBeNull();
    expect(
      screen.getByRole("heading", {
        name: "Find the guide by task",
      }),
    ).not.toBeNull();
    expect(screen.getByText("Codex agent chat")).not.toBeNull();
    expect(screen.getByText("Jupyter notebooks")).not.toBeNull();
    expect(screen.getByText("Terminal workflows")).not.toBeNull();
    expect(screen.getByText("From notebook to paper")).not.toBeNull();
    expect(screen.getByText("Installing software")).not.toBeNull();
    expect(screen.getByText("Reviewing agent commits")).not.toBeNull();
    expect(screen.getByText("Teaching with CoCalc")).not.toBeNull();
    expect(screen.getByText("Self-hosting CoCalc")).not.toBeNull();
    expect(screen.getByText("How CoCalc works")).not.toBeNull();
    expect(
      document.querySelectorAll(".cocalc-guide-link-featured"),
    ).toHaveLength(3);
    expect(
      document.querySelectorAll(".cocalc-guide-link-compact").length,
    ).toBeGreaterThan(8);
    expect(document.querySelectorAll(".ant-tag")).toHaveLength(0);
    expect(screen.queryByText("CoCalc-AI")).toBeNull();
    expect(
      screen.getByRole("link", { name: /Open all guides/i }),
    ).toHaveAttribute("href", "https://sagemathinc.github.io/cocalc-guides/");
    expect(
      screen.getByRole("link", { name: /From notebook to paper/i }),
    ).toHaveAttribute(
      "href",
      "https://sagemathinc.github.io/cocalc-guides/paper-polishing/",
    );
    expect(screen.getByRole("link", { name: "Browse docs" })).toHaveAttribute(
      "href",
      "/docs",
    );
  });

  it("uses the stored home-bay origin for public auth bootstrap", async () => {
    setStoredControlPlaneOrigin("https://bay-1-lite.example.com");
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: any) => {
      const url = `${input}`;
      if (url === "https://bay-1-lite.example.com/api/v2/auth/bootstrap") {
        expect(init?.credentials).toBe("include");
        return {
          json: async () => ({
            account_id: "36cf8f5c-0a76-4eda-80fa-db38ef282756",
            home_bay_id: "bay-1",
            signed_in: true,
          }),
        } as Response;
      }
      if (url === "/api/v2/news/list") {
        return { json: async () => [] } as Response;
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    await renderPublicApp(
      <PublicApp
        config={{ is_authenticated: false, site_name: "Launchpad" }}
        initialRoute={{ section: "home" }}
      />,
    );

    expect(
      (await screen.findAllByRole("link", { name: "Open projects" })).length,
    ).toBeGreaterThan(0);
  });

  it("falls back to same-origin auth bootstrap when stored home bay is stale", async () => {
    setStoredControlPlaneOrigin("https://bay-1-lite.example.com");
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: any) => {
      const url = `${input}`;
      if (url === "https://bay-1-lite.example.com/api/v2/auth/bootstrap") {
        expect(init?.credentials).toBe("include");
        return {
          json: async () => ({
            signed_in: false,
          }),
        } as Response;
      }
      if (url === "/api/v2/auth/bootstrap") {
        expect(init?.credentials).toBe("same-origin");
        return {
          json: async () => ({
            account_id: "36cf8f5c-0a76-4eda-80fa-db38ef282756",
            home_bay_id: "bay-0",
            signed_in: true,
          }),
        } as Response;
      }
      if (url === "/api/v2/news/list") {
        return { json: async () => [] } as Response;
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    await renderPublicApp(
      <PublicApp
        config={{ is_authenticated: false, site_name: "Launchpad" }}
        initialRoute={{ section: "home" }}
      />,
    );

    expect(
      (await screen.findAllByRole("link", { name: "Open projects" })).length,
    ).toBeGreaterThan(0);
  });

  it("renders the pricing page from live membership tier data", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({
        tiers: [
          {
            id: "free",
            label: "Free",
            ai_limits: { units_5h: 15, units_7d: 50 },
            features: {},
            price_monthly: 0,
            price_yearly: 0,
            priority: 10,
            project_defaults: {
              disk_quota: 1000,
              memory: 2000,
            },
            usage_limits: {
              shared_compute_priority: 1,
            },
            store_description: "Start exploring CoCalc.",
            store_visible: true,
          },
          {
            id: "member",
            label: "Member",
            ai_limits: { units_5h: 150, units_7d: 500 },
            features: { create_hosts: true },
            price_monthly: 25,
            price_yearly: 225,
            priority: 20,
            project_defaults: {
              disk_quota: 10000,
              memory: 8000,
              mintime: 3600,
            },
            usage_limits: {
              credit_spend_limit_7d_usd: 1000,
              max_sponsored_running_projects: 3,
              project_max_collaborators_and_pending_invites: 50,
              shared_compute_priority: 2,
              total_storage_hard_bytes: 125_000_000_000,
            },
            store_description: "A solid choice for everyday work.",
            store_highlights: [
              "Stronger shared resources",
              "Dedicated project host access",
            ],
            store_visible: true,
          },
          {
            id: "pro",
            label: "Pro",
            ai_limits: { units_5h: 1500, units_7d: 5000 },
            features: { create_hosts: true },
            price_monthly: 160,
            price_yearly: 1440,
            priority: 30,
            project_defaults: {
              disk_quota: 10000,
              memory: 16000,
            },
            usage_limits: {
              credit_spend_limit_7d_usd: 1000,
              shared_compute_priority: 8,
            },
            store_description: "For demanding projects.",
            store_visible: true,
          },
        ],
      }),
    }) as typeof fetch;
    await renderPublicApp(
      <PublicApp
        config={{
          is_authenticated: true,
          policy_pages: "sagemathinc",
          site_name: "Launchpad",
        }}
        initialRoute={pricingRoute}
      />,
    );

    expect(
      screen.getByRole("heading", {
        name: "CoCalc.ai Pricing and Licensing",
      }),
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", { name: "Hosted CoCalc.ai plans" }),
    ).not.toBeNull();
    expect(screen.getByText(/hosted and operated by CoCalc/i)).not.toBeNull();
    expect(screen.queryByText(/operated by us/i)).toBeNull();
    expect(screen.getAllByText("Member").length).toBeGreaterThan(0);
    expect(
      screen.getByText("A solid choice for everyday work."),
    ).not.toBeNull();
    expect(screen.getByText("Dedicated project host access")).not.toBeNull();
    expect(screen.getByText("$18.75")).not.toBeNull();
    expect(screen.getByText("/ mo")).not.toBeNull();
    expect(screen.getAllByText("Billed annually, saving 25%").length).toBe(2);
    expect(
      screen.getByRole("table", { name: "Hosted CoCalc.ai plan comparison" }),
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", { name: "Compare hosted plans" }),
    ).not.toBeNull();
    expect(screen.getByText("Project Limits")).not.toBeNull();
    expect(screen.getByText("Global Limits")).not.toBeNull();
    expect(screen.getByText("Functionality")).not.toBeNull();
    expect(screen.getByText("Postpaid dedicated-host billing")).not.toBeNull();
    expect(screen.getByText("CPU priority")).not.toBeNull();
    expect(screen.getByText("Low")).not.toBeNull();
    expect(screen.getByText("Medium")).not.toBeNull();
    expect(screen.getByText("Highest")).not.toBeNull();
    expect(screen.getByText("8 GB")).not.toBeNull();
    expect(screen.getAllByText("10 GB").length).toBe(2);
    expect(screen.getByText("125 GB")).not.toBeNull();
    expect(screen.queryByText("Collaborators")).toBeNull();
    expect(screen.queryByText("Included AI usage")).toBeNull();
    expect(screen.queryByText("Launchpad license")).toBeNull();
    expect(screen.getByRole("link", { name: /Member/ })).toHaveAttribute(
      "href",
      "/settings/membership",
    );
    fireEvent.click(screen.getByText("Monthly"));
    expect(screen.getByText("$25")).not.toBeNull();
    expect(screen.getAllByText("/ month").length).toBe(2);
    expect(screen.getAllByText("Save 25% with annual billing").length).toBe(2);
    expect(
      screen.getByRole("heading", {
        name: "Buying paths for groups and deployments",
      }),
    ).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "Review trust materials" }),
    ).toHaveAttribute("href", "/policies/trust");
    expect(
      screen.getByRole("link", { name: "Review privacy policy" }),
    ).toHaveAttribute("href", "/policies/privacy");
    expect(screen.getByRole("heading", { name: "Team seats" })).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "Compare operating models" }),
    ).toHaveAttribute("href", "/products");
    expect(
      screen.getAllByRole("link", {
        name: "Talk with CoCalc about site licensing",
      }).length,
    ).toBeGreaterThan(0);
    const siteLicenseLink = screen.getAllByRole("link", {
      name: "Talk with CoCalc about site licensing",
    })[0];
    expect(siteLicenseLink.getAttribute("href")).toContain("/support/new?");
    expect(siteLicenseLink.getAttribute("href")).toContain(
      "context=pricing-site-license",
    );
    expect(siteLicenseLink.getAttribute("href")).toContain(
      "data-location%2C+privacy%2C+or+security+questions",
    );
    expect(
      screen.getByRole("heading", { name: "Site licensing" }),
    ).not.toBeNull();
    expect(
      screen.getByText(/support expectations, rollout, data-location/i),
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", { name: "Dedicated project hosts" }),
    ).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "Manage project hosts" }),
    ).toHaveAttribute("href", "/hosts");
    expect(
      screen.getByRole("link", { name: "Manage team seats" }),
    ).toHaveAttribute("href", "/settings/team-licenses");
    expect(
      screen.getByRole("heading", {
        name: "Quotes and customized invoices",
      }),
    ).not.toBeNull();
    expectNoMarketingLeakage();
  });

  it("keeps pricing useful when hosted plans are unavailable", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({ tiers: [] }),
    }) as typeof fetch;

    await renderPublicApp(
      <PublicApp
        config={{ site_name: "Launchpad" }}
        initialRoute={pricingRoute}
      />,
    );

    expect(
      screen.getByRole("heading", {
        name: "CoCalc.ai Pricing and Licensing",
      }),
    ).not.toBeNull();
    // Structural fallback contract: an informational alert is shown (copy free).
    const fallbackAlert = document.querySelector(".ant-alert");
    expect(fallbackAlert).not.toBeNull();
    expect(fallbackAlert?.className).toContain("ant-alert-info");
    expect(
      screen
        .getAllByRole("link", { name: "Compare operating models" })
        .every((link) => link.getAttribute("href") === "/products"),
    ).toBe(true);
    const hostedPlansLink = screen.getByRole("link", {
      name: "Talk with CoCalc about hosted plans",
    });
    expect(hostedPlansLink.getAttribute("href")).toContain("/support/new?");
    expect(hostedPlansLink.getAttribute("href")).toContain(
      "subject=Hosted+CoCalc.ai+plans",
    );
    expect(hostedPlansLink.getAttribute("href")).toContain(
      "context=pricing-hosted-plans",
    );
    expect(hostedPlansLink.getAttribute("href")).toContain(
      "title=Ask+CoCalc+about+hosted+plans",
    );
    expect(
      screen.getByRole("heading", {
        name: "Buying paths for groups and deployments",
      }),
    ).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "Sign up for team seats" }),
    ).toHaveAttribute("href", "/auth/sign-up");
    expect(
      screen.getByRole("link", { name: "Read project host docs" }),
    ).toHaveAttribute("href", "/docs/hosts/project-hosts");
    expect(
      screen.queryByText(/No public hosted plans are currently configured/i),
    ).toBeNull();
    expect(
      screen.queryByText(/membership tiers are currently configured/i),
    ).toBeNull();
    expectNoMarketingLeakage();
  });

  it("hides the shared Policies nav item when public policies are disabled", async () => {
    await renderPublicApp(
      <PublicApp
        config={
          {
            policy_pages: "none",
            show_policies: true,
            site_name: "Launchpad",
          } as any
        }
        initialRoute={aboutRoute({ view: "about" })}
      />,
    );

    expect(screen.queryByRole("link", { name: "Policies" })).toBeNull();
  });

  it("renders configured policy cards", async () => {
    await renderPublicApp(
      <PublicApp
        config={{
          imprint: "enabled",
          policies: "enabled",
          policy_pages: "custom",
          site_name: "Hub",
        }}
        initialRoute={policiesRoute({ view: "policies" })}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Hub Policies" }),
    ).not.toBeNull();
    expect(screen.getByText("Imprint")).not.toBeNull();
    expect(screen.queryByText("Terms of Service")).toBeNull();
    expect(
      screen.getByRole("link", {
        name: /Policies Site-specific policy information configured by admins\./i,
      }),
    ).not.toBeNull();
  });

  it("shows built-in policy pages even without custom policy settings", async () => {
    await renderPublicApp(
      <PublicApp
        config={{ policy_pages: "sagemathinc", site_name: "Launchpad" }}
        initialRoute={policiesRoute({ view: "policies" })}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Policy and trust resources" }),
    ).not.toBeNull();
    expect(screen.getByText("Continue the evaluation")).not.toBeNull();
    expect(
      screen.getByText("Ask about policy review").closest("a"),
    ).toHaveAttribute(
      "href",
      expect.stringContaining("context=policy-evidence-review"),
    );
    expect(screen.getByText("Terms of Service")).not.toBeNull();
    expect(screen.getByText("Privacy Policy")).not.toBeNull();
    expect(screen.getByText("Trust and Compliance")).not.toBeNull();
    expect(screen.queryByText("Open page")).toBeNull();
    expect(
      screen.getByRole("link", { name: /Terms of Service/i }),
    ).not.toBeNull();
  });

  it("shows built-in policy pages by default for CoCalc public branding", async () => {
    await renderPublicApp(
      <PublicApp
        config={{ site_name: "CoCalc" }}
        initialRoute={policiesRoute({ view: "policies" })}
      />,
    );

    expect(screen.getByText("Terms of Service")).not.toBeNull();
    expect(screen.getByText("Privacy Policy")).not.toBeNull();
    expect(screen.getByText("Trust and Compliance")).not.toBeNull();
  });

  it("shows built-in policy pages for the default Launchpad public marketing config", async () => {
    await renderPublicApp(
      <PublicApp
        config={{
          cocalc_product: "launchpad",
          is_launchpad: true,
          policy_pages: "none",
          site_name: "CoCalc Launchpad",
        }}
        initialRoute={policiesRoute({
          policySlug: "trust",
          view: "policies-detail",
        })}
      />,
    );

    expect(screen.getByText("Trust and Compliance")).not.toBeNull();
    expect(screen.getByRole("navigation", { name: "Policies" })).not.toBeNull();
    expect(
      screen.getByText("Where should a security or compliance review start?"),
    ).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "Open Trust Center" }),
    ).toHaveAttribute("href", "https://trust.cocalc.ai/");
    expect(
      Array.from(document.querySelectorAll("a")).some((anchor) =>
        anchor.href.includes("trust.cocalc.com"),
      ),
    ).toBe(false);
  });

  it("renders the team page", async () => {
    await renderPublicApp(
      <PublicApp
        config={{ site_name: "Launchpad" }}
        initialRoute={aboutRoute({ view: "about-team" })}
      />,
    );

    expect(screen.getByText("William Stein, Founder and CEO")).not.toBeNull();
    expect(screen.getByText("Harald Schilly, CTO")).not.toBeNull();
  });

  it("renders an individual team profile", async () => {
    await renderPublicApp(
      <PublicApp
        config={{ site_name: "Launchpad" }}
        initialRoute={aboutRoute({
          teamSlug: "william-stein",
          view: "about-team-member",
        })}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "William Stein, Founder and CEO" }),
    ).not.toBeNull();
    expect(
      screen.getByText(
        /William is both the CEO and a lead software developer for both the front and back end of CoCalc/i,
      ),
    ).not.toBeNull();
    expect(screen.getByText("Previous Experience")).not.toBeNull();
    expect(screen.queryByText("Back to team")).toBeNull();
    expect(screen.queryByText("TEAM")).toBeNull();
    expect(screen.queryByText("Personal notes")).toBeNull();
    expect(
      screen.getByRole("link", { name: "wstein@sagemath.com" }),
    ).not.toBeNull();
    expect(screen.getByRole("link", { name: "GitHub" })).not.toBeNull();
    expect(screen.getByText("Personal website")).not.toBeNull();
  });

  it("renders the built-in privacy policy page", async () => {
    await renderPublicApp(
      <PublicApp
        config={{ policy_pages: "sagemathinc", site_name: "Launchpad" }}
        initialRoute={policiesRoute({
          policySlug: "privacy",
          view: "policies-detail",
        })}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Privacy Policy" }),
    ).not.toBeNull();
    expect(
      Array.from(document.querySelectorAll("style")).some((style) =>
        style.textContent?.includes("overflow-wrap: anywhere"),
      ),
    ).toBe(true);
    // Keep the mandatory site_name prefix (doubles as a site_name-injection
    // canary) and the freshness structure, but free the date literal so a
    // routine "Last Updated" bump needs no test edit.
    expect(screen.getByText(/^Launchpad · Last Updated:/)).not.toBeNull();
    expect(
      screen.getByText(
        "How does SageMath, Inc. describe privacy practices for CoCalc?",
      ),
    ).not.toBeNull();
    expect(
      screen.getByRole("group", { name: "Policy next steps" }),
    ).not.toBeNull();
    expect(
      screen.getByText("Ask about this policy").closest("a"),
    ).toHaveAttribute(
      "href",
      expect.stringContaining("context=policy-privacy"),
    );
    expect(
      screen.getByText(/Protecting your privacy is really important to us/i),
    ).not.toBeNull();
    expect(screen.queryByText("PUBLIC CONTENT")).toBeNull();
    expect(screen.queryByText("Back to policies")).toBeNull();
    expect(screen.queryByRole("menu", { name: "Policy pages" })).toBeNull();
    const policyNavigation = screen.getByRole("complementary", {
      name: "Policy navigation",
    });
    expect(
      within(policyNavigation)
        .getAllByRole("navigation")
        .map((nav) => nav.getAttribute("aria-label")),
    ).toEqual(["Policies", "On this page"]);
    const policyToc = screen.getByRole("navigation", { name: "On this page" });
    expect(
      within(policyToc).getByRole("link", {
        name: "Revisions to this Privacy Policy",
      }),
    ).toHaveAttribute("href", "#revisions-to-this-privacy-policy");
    expect(
      within(policyToc).getByRole("link", { name: "1 Purpose" }),
    ).toHaveAttribute("href", "#purpose");
    const scrollIntoView = jest.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      fireEvent.click(
        within(policyToc).getByRole("link", { name: "1 Purpose" }),
      );
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
    expect(
      within(policyToc).queryByRole("link", {
        name: "3.1 Types of Personal Information We Collect",
      }),
    ).toBeNull();
    const policyPages = screen.getByRole("navigation", { name: "Policies" });
    expect(
      within(policyPages).getByRole("link", { name: "Privacy" }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("renders the built-in data processing addendum page", async () => {
    await renderPublicApp(
      <PublicApp
        config={{ policy_pages: "sagemathinc", site_name: "Launchpad" }}
        initialRoute={policiesRoute({
          policySlug: "dpa",
          view: "policies-detail",
        })}
      />,
    );

    expect(
      await screen.findByRole("heading", {
        name: "Data Processing Addendum",
      }),
    ).not.toBeNull();
    expect(screen.getByText(/^Launchpad · Last Updated:/)).not.toBeNull();
    expect(
      screen.getByText(
        "What data-processing terms apply when SageMath, Inc. processes personal data on a user's behalf?",
      ),
    ).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "Open Trust Center" }),
    ).toHaveAttribute("href", "https://trust.cocalc.ai/");
    expect(
      screen.getByText(/The Controller \(User\) provides/i),
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", { name: "2. Sub-processors" }),
    ).not.toBeNull();
    const policyToc = screen.getByRole("navigation", { name: "On this page" });
    expect(
      within(policyToc).getByRole("link", { name: "2. Sub-processors" }),
    ).toHaveAttribute("href", "#section-2-sub-processors");
    const policyPages = screen.getByRole("navigation", { name: "Policies" });
    expect(
      within(policyPages)
        .getAllByRole("link")
        .map((item) => item.textContent),
    ).toEqual([
      "Terms",
      "Privacy",
      "DPA",
      "Trust",
      "Accessibility",
      "Copyright",
      "FERPA",
    ]);
    expect(
      within(policyPages).getByRole("link", { name: "DPA" }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("renders the built-in terms page", async () => {
    await renderPublicApp(
      <PublicApp
        config={{ policy_pages: "sagemathinc", site_name: "Launchpad" }}
        initialRoute={policiesRoute({
          policySlug: "terms",
          view: "policies-detail",
        })}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Terms of Service" }),
    ).not.toBeNull();
    expect(
      screen.getByText(/Once you POST TO THE GENERAL PUBLIC/i),
    ).not.toBeNull();
  });

  it("renders custom policy markdown without extra policy chrome", async () => {
    render(
      <PublicApp
        config={{
          policies: "# Local Policies\n\nDeployment specific terms.",
          policy_pages: "custom",
          site_name: "Launchpad",
        }}
        initialRoute={policiesRoute({ view: "policies-custom" })}
      />,
    );

    expect(await screen.findByText("Local Policies")).not.toBeNull();
    expect(screen.getByText("Deployment specific terms.")).not.toBeNull();
    expect(screen.queryByText("PUBLIC CONTENT")).toBeNull();
    expect(screen.queryByText("Back to policies")).toBeNull();
    expect(screen.queryByRole("menu", { name: "Policy pages" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Policies" })).toBeNull();
  });

  it("shows a generic title for unknown policy routes", async () => {
    await renderPublicApp(
      <PublicApp
        config={{ policy_pages: "sagemathinc", site_name: "Launchpad" }}
        initialRoute={policiesRoute({
          policySlug: "unknown-policy",
          view: "policies-detail",
        })}
      />,
    );

    expect(document.title).toBe("Policies - Launchpad");
    expect(screen.getByText("This policy page was not found.")).not.toBeNull();
  });

  it("hides policy pages when public policies are disabled", async () => {
    await renderPublicApp(
      <PublicApp
        config={
          {
            policy_pages: "none",
            show_policies: true,
            site_name: "Launchpad",
          } as any
        }
        initialRoute={policiesRoute({ view: "policies" })}
      />,
    );

    expect(
      screen.getByText("Public policy pages are not configured"),
    ).not.toBeNull();
    // Live non-leak guard: the built-in policy card title is cased
    // "Terms of Service"; the previous lowercase literal never matched and was
    // a no-op.
    expect(screen.queryByText("Terms of Service")).toBeNull();
  });

  it("shows an external policy link instead of built-in policy pages", async () => {
    await renderPublicApp(
      <PublicApp
        config={{
          policy_pages: "none",
          site_name: "Launchpad",
          terms_of_service_url: "https://example.com/policies",
        }}
        initialRoute={policiesRoute({ view: "policies" })}
      />,
    );

    expect(screen.getByText("Public policy information")).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "Open policy page" }),
    ).not.toBeNull();
    // Live non-leak guard (cased to match the built-in card title).
    expect(screen.queryByText("Terms of Service")).toBeNull();
  });

  it("uses the external policy link for direct policy routes as well", async () => {
    await renderPublicApp(
      <PublicApp
        config={{
          policy_pages: "none",
          site_name: "Launchpad",
          terms_of_service_url: "https://example.com/policies",
        }}
        initialRoute={policiesRoute({
          policySlug: "privacy",
          view: "policies-detail",
        })}
      />,
    );

    expect(screen.getByText("Public policy information")).not.toBeNull();
    expect(screen.queryByText("CoCalc - Privacy Policy")).toBeNull();
  });

  it("renders the public news list from section-local fetch data", async () => {
    const initialNews: NewsItem[] = [
      {
        channel: "feature",
        date: 1710000000,
        id: "1",
        tags: ["launchpad"],
        text: "A long markdown body about **Launchpad**.",
        title: "Launchpad update",
      },
    ];
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => initialNews,
    }) as typeof fetch;
    await renderPublicApp(
      <PublicApp
        config={{ site_name: "Launchpad" }}
        initialRoute={newsRoute({ view: "news" })}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Launchpad News" }),
    ).not.toBeNull();
    expect(await screen.findByText("Launchpad update")).not.toBeNull();
    expect(screen.getByText("#launchpad")).not.toBeNull();
  });

  it("renders rich markdown in public news cards", async () => {
    const initialNews: NewsItem[] = [
      {
        channel: "feature",
        date: 1710000000,
        id: "1",
        text: [
          "This is a test.",
          "",
          "- foo",
          "- bar",
          "",
          "![Image](/blobs/example.png?uuid=test-uuid)",
        ].join("\n"),
        title: "Markdown update",
      },
    ];
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => initialNews,
    }) as typeof fetch;

    await renderPublicApp(
      <PublicApp
        config={{ site_name: "Launchpad" }}
        initialRoute={newsRoute({ view: "news" })}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("img", { name: "Image" })).not.toBeNull(),
    );
    expect(screen.getByText("foo")).not.toBeNull();
    expect(screen.getByText("bar")).not.toBeNull();
  });

  it("shows admin news actions on the public news page for admins", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => [
        {
          channel: "feature",
          date: 1710000000,
          id: "1",
          text: "Body",
          title: "Launchpad update",
        },
      ],
    }) as typeof fetch;
    await renderPublicApp(
      <PublicApp
        config={{ is_admin: true, site_name: "Launchpad" }}
        initialRoute={newsRoute({ view: "news" })}
      />,
    );

    expect(
      await screen.findByRole("link", { name: "Manage news" }),
    ).not.toBeNull();
    expect(screen.getByRole("link", { name: "Create post" })).not.toBeNull();
    expect(screen.getByRole("link", { name: "Create event" })).not.toBeNull();
  });

  it("refreshes the public news list from its own fetch", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      json: async () => [
        {
          channel: "feature",
          date: 1710001000,
          id: "2",
          tags: ["fresh"],
          text: "Fresh body",
          title: "Fresh update",
        },
      ],
    });
    const originalFetch = global.fetch;
    global.fetch = fetchMock as typeof fetch;

    try {
      await renderPublicApp(
        <PublicApp
          config={{ site_name: "Launchpad" }}
          initialRoute={newsRoute({ view: "news" })}
        />,
      );

      await waitFor(() =>
        expect(screen.getByText("Fresh update")).not.toBeNull(),
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("renders the cocalc plus page", async () => {
    await renderPublicApp(
      <PublicApp
        config={{ site_name: "Launchpad" }}
        initialRoute={productsRoute({ view: "products-cocalc-plus" })}
      />,
    );

    expectSingleLeadHeadline();
    expectSharedProjectContextNote();
    const positioning = screen.getByRole("group", {
      name: "CoCalc Plus positioning",
    });
    for (const heading of ["Who it fits", "How it runs", "When to choose it"]) {
      expect(
        within(positioning).getByRole("heading", { name: heading }),
      ).not.toBeNull();
    }
    expect(
      screen.getByRole("heading", { name: "Install CoCalc Plus locally" }),
    ).not.toBeNull();
    // Boundary card: structure (li count) + one Plus identity token, not prose.
    expectBoundaryNotes(
      "Boundary: local, one-user runtime",
      4,
      /self-serve local software|user operates the runtime|one-user/i,
    );
    expect(screen.getAllByText(/operated by CoCalc/i).length).toBeGreaterThan(
      0,
    );
    expect(screen.queryByText(/operated by us/i)).toBeNull();
    expect(
      screen
        .getAllByRole("link", { name: "Review hosted plans" })
        .every((link) => link.getAttribute("href") === "/pricing"),
    ).toBe(true);
    expect(
      screen.queryByRole("link", { name: "Use hosted CoCalc.ai" }),
    ).toBeNull();
    expect(
      screen.queryByRole("link", { name: "Jupyter notebooks" }),
    ).toBeNull();
    expect(screen.queryByRole("link", { name: "Linux workflow" })).toBeNull();
    expectNoProductDetailStalePhrasing();
  });

  it("renders the software overview page", async () => {
    await renderPublicApp(
      <PublicApp
        config={{ site_name: "Launchpad" }}
        initialRoute={productsRoute({ view: "products" })}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Ways to Run CoCalc" }),
    ).not.toBeNull();
    expect(screen.getAllByText("CoCalc.ai").length).toBeGreaterThan(0);
    expect(
      screen.getByText(
        /Files, notebooks, terminals, chats, and agent context stay with the project/i,
      ),
    ).not.toBeNull();
    expect(screen.getByText(/Use this as a decision guide/i)).not.toBeNull();
    expect(screen.queryByText(/buyer map/i)).toBeNull();
    const pathChooser = screen.getByRole("group", {
      name: "CoCalc product path chooser",
    });
    expect(pathChooser).not.toBeNull();
    expect(within(pathChooser).getAllByText("Where it runs")).toHaveLength(5);
    expect(within(pathChooser).getAllByText("Best fit")).toHaveLength(5);
    // Structure + ordered identity instead of pinning each card's body copy.
    expectProductPathChooserCards();
    // Cheap cross-surface canary: the products overview is verified clean of the
    // pure internal floor, so assert it directly here too.
    expectNoInternalFloor();
    expectNoMarketingLeakage();
    expect(screen.queryByText(/local Lima/i)).toBeNull();
    expect(screen.queryByText(/quick team starts/i)).toBeNull();
    expect(screen.queryByText(/Production private cloud/i)).toBeNull();
    expect(screen.queryByText(/multi-bay operations/i)).toBeNull();
    for (const phrase of [
      /setup-time/i,
      /restore-time/i,
      /deployment-time/i,
      /benchmark/i,
      /guaranteed support/i,
      /\bSLA\b/i,
      /managed private cloud/i,
      /air-gapped/i,
    ]) {
      expect(screen.queryByText(phrase)).toBeNull();
    }
    expect(
      screen.getByRole("link", { name: "View CoCalc Rocket" }),
    ).toHaveAttribute("href", "/products/cocalc-rocket");
    expect(
      screen.getByRole("link", { name: "Review hosted plans" }),
    ).toHaveAttribute("href", "/pricing");
    expect(screen.queryByRole("link", { name: "View CoCalc.ai" })).toBeNull();
    expect(
      screen.getByText("Site licensing wraps the product path."),
    ).not.toBeNull();
    expect(screen.getByText(/commercial and support wrapper/i)).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "Talk with CoCalc" }),
    ).toHaveAttribute("href", expect.stringContaining("/support/new?"));
    expect(
      screen.getByRole("link", { name: "Talk with CoCalc" }),
    ).toHaveAttribute(
      "href",
      expect.stringContaining("context=products-site-licensing"),
    );
    expect(
      screen.getByRole("link", { name: "Talk with CoCalc" }),
    ).toHaveAttribute(
      "href",
      expect.stringContaining("subject=Operating+model+and+site+licensing"),
    );
    expect(
      screen.getByRole("link", { name: "Talk with CoCalc" }),
    ).toHaveAttribute(
      "href",
      expect.stringContaining(
        "data-location%2C+privacy%2C+or+security+questions",
      ),
    );
  });

  it("surfaces product-path trust materials only when built-in policies are public", async () => {
    await renderPublicApp(
      <PublicApp
        config={{ policy_pages: "sagemathinc", site_name: "Launchpad" }}
        initialRoute={productsRoute({ view: "products" })}
      />,
    );

    expect(
      screen.getByRole("group", { name: "Product trust materials" }),
    ).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "Review trust materials" }),
    ).toHaveAttribute("href", "/policies/trust");
    expect(
      screen.getByRole("link", { name: "Review privacy policy" }),
    ).toHaveAttribute("href", "/policies/privacy");
    expect(
      screen.queryByText(/setup-time|restore-time|customer proof/i),
    ).toBeNull();
  });

  it("uses CoCalc marketing branding on public product pages for default Launchpad installs", async () => {
    await renderPublicApp(
      <PublicApp
        config={{
          cocalc_product: "launchpad",
          is_launchpad: true,
          site_name: "CoCalc Launchpad",
        }}
        initialRoute={productsRoute({ view: "products" })}
      />,
    );

    expect(
      within(screen.getByRole("banner")).getByRole("link", {
        name: "CoCalc home",
      }),
    ).not.toBeNull();
    expect(
      screen.getByText("Choose how CoCalc should run for your team."),
    ).not.toBeNull();
    expect(screen.getByText("Which path fits?")).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "Compare CoCalc fit" }),
    ).toHaveAttribute("href", "/features/compare");
    expect(
      screen.getByRole("link", { name: "Review trust materials" }),
    ).toHaveAttribute("href", "/policies/trust");
    expect(
      screen.getByRole("link", { name: "Review privacy policy" }),
    ).toHaveAttribute("href", "/policies/privacy");
    expect(
      screen.queryByRole("link", { name: "Compare workspace model" }),
    ).toBeNull();
  });

  it("renders the cocalc launchpad page", async () => {
    await renderPublicApp(
      <PublicApp
        config={{ site_name: "Launchpad" }}
        initialRoute={productsRoute({ view: "products-cocalc-launchpad" })}
      />,
    );

    expectSingleLeadHeadline();
    expectSharedProjectContextNote();
    const positioning = screen.getByRole("group", {
      name: "CoCalc Launchpad positioning",
    });
    for (const heading of ["Who it fits", "How it runs", "When to choose it"]) {
      expect(
        within(positioning).getByRole("heading", { name: heading }),
      ).not.toBeNull();
    }
    expect(
      screen.getByRole("heading", { name: "Install CoCalc Launchpad" }),
    ).not.toBeNull();
    expect(
      screen.getByText(/customer-operated CoCalc environment/),
    ).not.toBeNull();
    // Boundary card: structure (li count) + a Launchpad identity token.
    expectBoundaryNotes(
      "Boundary: bounded private deployment",
      4,
      /customer or administrator owns infrastructure|customer-operated/i,
    );
    expect(
      screen.queryByText(/Support can cover install guidance/i),
    ).toBeNull();
    expect(
      screen
        .getAllByRole("link", { name: "Pricing and licensing" })
        .every((link) => link.getAttribute("href") === "/pricing"),
    ).toBe(true);
    expect(
      screen.getByRole("link", { name: "Talk with CoCalc about Launchpad" }),
    ).toHaveAttribute("href", expect.stringContaining("/support/new?"));
    expect(
      screen.getByRole("link", { name: "Talk with CoCalc about Launchpad" }),
    ).toHaveAttribute(
      "href",
      expect.stringContaining("context=product-cocalc-launchpad"),
    );
    expect(
      screen.getByRole("link", { name: "Talk with CoCalc about Launchpad" }),
    ).toHaveAttribute(
      "href",
      expect.stringContaining(
        "data-location%2C+privacy%2C+or+security+questions",
      ),
    );
    expect(
      screen.getByRole("link", { name: "Talk with CoCalc about Launchpad" }),
    ).toHaveAttribute("href", expect.stringContaining("ongoing+operations"));
    expect(
      screen.queryByRole("link", { name: "Compare with CoCalc Plus" }),
    ).toBeNull();
    expectNoProductDetailStalePhrasing();
  });

  it("renders the cocalc star page", async () => {
    await renderPublicApp(
      <PublicApp
        config={{ site_name: "Launchpad" }}
        initialRoute={productsRoute({ view: "products-cocalc-star" })}
      />,
    );

    expectSingleLeadHeadline();
    expectSharedProjectContextNote();
    const positioning = screen.getByRole("group", {
      name: "CoCalc Star positioning",
    });
    for (const heading of ["Who it fits", "How it runs", "When to choose it"]) {
      expect(
        within(positioning).getByRole("heading", { name: heading }),
      ).not.toBeNull();
    }
    expect(
      screen.getByRole("heading", { name: "Install CoCalc Star" }),
    ).not.toBeNull();
    // Star identity token kept at page level; boundary asserted structurally.
    expect(screen.getAllByText(/public Ubuntu VM/).length).toBeGreaterThan(0);
    expectBoundaryNotes(
      "Boundary: one public VM",
      3,
      /not a high-availability or scale-out|one public VM/i,
    );
    expect(
      screen.getByRole("link", { name: "Read Star setup guide" }),
    ).toHaveAttribute("href", "/docs/self-hosting/cocalc-star");
    expect(screen.getByText(/setup guide covers the firewall/i)).not.toBeNull();
    expectNoProductDetailStalePhrasing();
  });

  it("renders the cocalc rocket page", async () => {
    await renderPublicApp(
      <PublicApp
        config={{ site_name: "Launchpad" }}
        initialRoute={productsRoute({ view: "products-cocalc-rocket" })}
      />,
    );

    expectSingleLeadHeadline();
    expectSharedProjectContextNote();
    const positioning = screen.getByRole("group", {
      name: "CoCalc Rocket positioning",
    });
    for (const heading of ["Who it fits", "How it runs", "When to choose it"]) {
      expect(
        within(positioning).getByRole("heading", { name: heading }),
      ).not.toBeNull();
    }
    expect(
      screen.getAllByText(/customer-operated private-cloud path/i).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/governance, support/i).length).toBeGreaterThan(
      0,
    );
    expect(
      screen.getByText(/deployment-planning expectations/i),
    ).not.toBeNull();
    expect(screen.queryByText(/level of deployment help/i)).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Plan Rocket with CoCalc" }),
    ).not.toBeNull();
    // Boundary card: structure (li count) + a Rocket identity token.
    expectBoundaryNotes(
      "Boundary: planned private cloud",
      3,
      /customer-operated private-cloud|clear ownership of ongoing operations/i,
    );
    expect(
      screen.getAllByRole("link", {
        name: "Talk with CoCalc about Rocket",
      })[0],
    ).toHaveAttribute("href", expect.stringContaining("/support/new?"));
    expect(
      screen.getAllByRole("link", {
        name: "Talk with CoCalc about Rocket",
      })[0],
    ).toHaveAttribute(
      "href",
      expect.stringContaining("context=product-cocalc-rocket"),
    );
    expect(
      screen.getAllByRole("link", {
        name: "Talk with CoCalc about Rocket",
      })[0],
    ).toHaveAttribute("href", expect.stringContaining("operator+boundary"));
    expect(
      screen.getAllByRole("link", {
        name: "Talk with CoCalc about Rocket",
      })[0],
    ).toHaveAttribute("href", expect.stringContaining("ongoing+operations"));
    expect(
      screen.getAllByRole("link", {
        name: "Talk with CoCalc about Rocket",
      })[0],
    ).toHaveAttribute(
      "href",
      expect.stringContaining(
        "security%2C+privacy%2C+or+data-ownership+questions",
      ),
    );
    expectNoProductDetailStalePhrasing();
  });
});
