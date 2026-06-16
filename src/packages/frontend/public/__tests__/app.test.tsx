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
  for (const phrase of [
    /serious technical/i,
    /What CoCalc/i,
    /not HA/i,
    /multi-bay/i,
    /production operations matter/i,
    /Production private cloud/i,
    /lower-level operator control plane/i,
  ]) {
    expect(screen.queryByText(phrase)).toBeNull();
  }
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
    expect(
      screen.getByText(/Get to know the math prodigy behind CoCalc/),
    ).not.toBeNull();
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
    expect(screen.getByText("Jupyter workflows")).not.toBeNull();
    expect(
      screen.getByRole("link", { name: /Open all guides/i }),
    ).toHaveAttribute("href", "https://sagemathinc.github.io/cocalc-guides/");
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
            usage_limits: {},
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
            },
            store_description: "For demanding projects.",
            store_visible: true,
          },
        ],
      }),
    }) as typeof fetch;
    await renderPublicApp(
      <PublicApp
        config={{ is_authenticated: true, site_name: "Launchpad" }}
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
    expect(screen.getByText("8 GB")).not.toBeNull();
    expect(screen.getAllByText("10 GB").length).toBe(2);
    expect(screen.getByText("125 GB")).not.toBeNull();
    expect(screen.getByText("Included AI usage")).not.toBeNull();
    expect(screen.getByText("Minimal")).not.toBeNull();
    expect(screen.getByText("Standard")).not.toBeNull();
    expect(screen.getByText("Expanded")).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "Manage Member hosted plan" }),
    ).toHaveAttribute("href", "/settings/membership");
    fireEvent.click(screen.getByText("Monthly"));
    expect(screen.getByText("$25")).not.toBeNull();
    expect(screen.getAllByText("/ month").length).toBe(2);
    expect(screen.getAllByText("Save 25% with annual billing").length).toBe(2);
    expect(
      screen.getByRole("heading", {
        name: "Buying paths for groups and deployments",
      }),
    ).not.toBeNull();
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
    expect(
      screen.getByRole("heading", { name: "Site licensing" }),
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
    expect(
      screen.getByText("Hosted plan prices are not published here yet."),
    ).not.toBeNull();
    expect(
      screen.getByText(/^Hosted memberships are the managed CoCalc\.ai/),
    ).not.toBeNull();
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

    expect(screen.getByText("Terms of Service")).not.toBeNull();
    expect(screen.getByText("Privacy Policy")).not.toBeNull();
    expect(screen.getByText("Trust and Compliance")).not.toBeNull();
    expect(screen.queryByText("Open page")).toBeNull();
    expect(
      screen.getByRole("link", { name: /Terms of Service/i }),
    ).not.toBeNull();
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
      screen.getByText("Launchpad · Last Updated: June 9, 2026"),
    ).not.toBeNull();
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
    expect(
      screen.getByText("Launchpad · Last Updated: June 9, 2026"),
    ).not.toBeNull();
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
    expect(screen.queryByText("Terms of service")).toBeNull();
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
    expect(screen.queryByText("Terms of service")).toBeNull();
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

    expect(
      screen.getByRole("heading", {
        name: "Local CoCalc for evaluation and individual work",
      }),
    ).not.toBeNull();
    const positioning = screen.getByRole("group", {
      name: "CoCalc Plus positioning",
    });
    for (const heading of ["Audience", "Deployment model", "Why choose it"]) {
      expect(
        within(positioning).getByRole("heading", { name: heading }),
      ).not.toBeNull();
    }
    expect(
      screen.getByRole("heading", { name: "Install CoCalc Plus locally" }),
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", { name: "Operational boundary" }),
    ).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "Use hosted CoCalc.ai" }),
    ).toHaveAttribute("href", "/");
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
    expect(screen.getByText("Start with who operates CoCalc")).not.toBeNull();
    expect(
      screen.getByText(
        "Most groups can narrow the decision quickly by separating managed hosted use, self-operated use, and customer-operated private deployment.",
      ),
    ).not.toBeNull();
    expect(screen.getByText(/Use this as a decision guide/i)).not.toBeNull();
    expect(screen.queryByText(/buyer map/i)).toBeNull();
    const routeFamilies = screen.getByRole("group", {
      name: "CoCalc product route families",
    });
    for (const label of [
      "Hosted by CoCalc",
      "Run it yourself",
      "Private deployment",
      "CoCalc Plus or Star",
      "CoCalc Launchpad or Rocket",
    ]) {
      expect(within(routeFamilies).getByText(label)).not.toBeNull();
    }
    const pathChooser = screen.getByRole("group", {
      name: "CoCalc product path chooser",
    });
    expect(pathChooser).not.toBeNull();
    expect(within(pathChooser).getAllByText("Where it runs")).toHaveLength(5);
    expect(within(pathChooser).getAllByText("Best fit")).toHaveLength(5);
    expect(
      screen.getByText("Hosted service operated by CoCalc"),
    ).not.toBeNull();
    expect(
      screen.getByText(
        "Individuals and teams that want managed hosted projects without running infrastructure.",
      ),
    ).not.toBeNull();
    expect(
      screen.getByText("Single-VM appliance operated by the user or customer"),
    ).not.toBeNull();
    expect(screen.queryByText(/quick team starts/i)).toBeNull();
    expect(screen.queryByText(/Production private cloud/i)).toBeNull();
    expect(screen.queryByText(/multi-bay operations/i)).toBeNull();
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

    expect(
      screen.getByRole("heading", {
        name: "Lightweight private deployment for teams that operate CoCalc",
      }),
    ).not.toBeNull();
    const positioning = screen.getByRole("group", {
      name: "CoCalc Launchpad positioning",
    });
    for (const heading of ["Audience", "Deployment model", "Why choose it"]) {
      expect(
        within(positioning).getByRole("heading", { name: heading }),
      ).not.toBeNull();
    }
    expect(
      screen.getByRole("heading", { name: "Install CoCalc Launchpad" }),
    ).not.toBeNull();
    expect(
      screen.getByText(/customer-operated private environment/),
    ).not.toBeNull();
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
      screen.getByRole("link", { name: "Compare with Rocket" }),
    ).toHaveAttribute("href", "/products/cocalc-rocket");
    expectNoProductDetailStalePhrasing();
  });

  it("renders the cocalc star page", async () => {
    await renderPublicApp(
      <PublicApp
        config={{ site_name: "Launchpad" }}
        initialRoute={productsRoute({ view: "products-cocalc-star" })}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Shared CoCalc on a single VM" }),
    ).not.toBeNull();
    const positioning = screen.getByRole("group", {
      name: "CoCalc Star positioning",
    });
    for (const heading of ["Audience", "Deployment model", "Why choose it"]) {
      expect(
        within(positioning).getByRole("heading", { name: heading }),
      ).not.toBeNull();
    }
    expect(
      screen.getByRole("heading", { name: "Install CoCalc Star" }),
    ).not.toBeNull();
    expect(screen.getAllByText(/public Ubuntu VM/).length).toBeGreaterThan(0);
    expect(
      screen.getByText(/not a high-availability or scale-out/),
    ).not.toBeNull();
    expectNoProductDetailStalePhrasing();
  });

  it("renders the cocalc rocket page", async () => {
    await renderPublicApp(
      <PublicApp
        config={{ site_name: "Launchpad" }}
        initialRoute={productsRoute({ view: "products-cocalc-rocket" })}
      />,
    );

    expect(
      screen.getByRole("heading", {
        name: "Private-cloud path for institutional deployment",
      }),
    ).not.toBeNull();
    const positioning = screen.getByRole("group", {
      name: "CoCalc Rocket positioning",
    });
    for (const heading of ["Audience", "Deployment model", "Why choose it"]) {
      expect(
        within(positioning).getByRole("heading", { name: heading }),
      ).not.toBeNull();
    }
    expect(
      screen.getAllByText(/customer-operated private-cloud path/i).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(/governance, support/i)).not.toBeNull();
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
    expectNoProductDetailStalePhrasing();
  });
});
