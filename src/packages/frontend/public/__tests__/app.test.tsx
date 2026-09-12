/** @jest-environment jsdom */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import { setStoredControlPlaneOrigin } from "@cocalc/frontend/control-plane-origin";
import * as authApi from "@cocalc/frontend/auth/api";
import type { NewsItem } from "@cocalc/util/types/news";
import PublicApp from "../app";
import type { PublicAboutRoute } from "../about/routes";
import { getAboutRouteFromPath } from "../about/routes";
import type { PublicNewsRoute } from "../news/routes";
import { getNewsRouteFromPath } from "../news/routes";
import type { PublicPoliciesRoute } from "../policies/routes";
import { getPoliciesRouteFromPath } from "../policies/routes";
import {
  getPublicRouteFromPath,
  isPublicTarget,
  preservePublicTargetFragment,
  publicPath,
} from "../routes";
import type { PublicProductsRoute } from "../products/routes";
import { getProductsRouteFromPath } from "../products/routes";

const originalFetch = global.fetch;

beforeEach(() => {
  window.localStorage.clear();
  document.head
    .querySelectorAll("[data-cocalc-public-route-meta]")
    .forEach((element) => element.remove());
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

function headMeta(selector: string): string | null {
  return document.head.querySelector(selector)?.getAttribute("content") ?? null;
}

function canonicalHref(): string | null {
  return (
    document.head
      .querySelector('link[data-cocalc-public-route-meta="canonical"]')
      ?.getAttribute("href") ?? null
  );
}

async function renderPublicApp(ui: React.ReactElement) {
  render(ui);
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
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
      newsSlug: "launchpad-update-17",
      view: "news-detail",
    });
    expect(
      getNewsRouteFromPath(publicPath("news/launchpad-update-17/1712345678")),
    ).toEqual({
      newsId: 17,
      newsSlug: "launchpad-update-17",
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
      getPublicRouteFromPath(publicPath("guides/rstudio-project")),
    ).toEqual({
      section: "not-found",
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
    expect(getPublicRouteFromPath(publicPath("guides/unknown"))).toEqual({
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
    expect(isPublicTarget("/guides/rstudio-project")).toBe(false);
    expect(isPublicTarget("/docs/projects/project-secrets")).toBe(true);
    expect(isPublicTarget("/rootfs/minimal-jupyter")).toBe(true);
    expect(isPublicTarget("/invites/abc")).toBe(true);
    expect(isPublicTarget("/auth/sign-in")).toBe(true);
    expect(isPublicTarget("/base/auth/sign-up")).toBe(true);
    expect(isPublicTarget("/auth/google")).toBe(false);
    expect(isPublicTarget("/base/auth/google")).toBe(false);
  });

  it("preserves email-link fragments while restoring clean public routes", () => {
    expect(
      preservePublicTargetFragment(
        "/auth/email/continue/challenge-id",
        "#token=secret",
      ),
    ).toBe("/auth/email/continue/challenge-id#token=secret");
    expect(
      preservePublicTargetFragment("/docs/page#section", "#token=secret"),
    ).toBe("/docs/page#section");
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
      ok: true,
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
        name: "About CoCalc",
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
      screen.getByRole("heading", { name: "About CoCalc" }),
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", {
        name: /Make serious computational work easy to share/i,
      }),
    ).not.toBeNull();
    expect(
      screen.getByText("SageMath, Inc. · The company behind CoCalc"),
    ).not.toBeNull();
    expect(screen.getByText("Incorporated 2016")).not.toBeNull();
    expect(screen.getByText("SOC 2")).not.toBeNull();
    expect(
      screen.getByRole("heading", { name: "Leadership and team" }),
    ).not.toBeNull();
    expect(screen.queryByText("Upcoming events")).toBeNull();
  });

  it("renders and updates managed public-route head metadata", async () => {
    const { rerender } = render(
      <PublicApp
        config={{ site_name: "CoCalc" }}
        initialRoute={productsRoute({ view: "products-cocalc-star" })}
      />,
    );

    await waitFor(() =>
      expect(canonicalHref()).toBe("https://cocalc.ai/products/cocalc-star"),
    );
    expect(headMeta('meta[name="description"]')).toContain(
      "single-VM appliance",
    );

    rerender(
      <PublicApp
        config={{ site_name: "CoCalc" }}
        initialRoute={aboutRoute({ view: "about" })}
      />,
    );

    await waitFor(() =>
      expect(canonicalHref()).toBe("https://cocalc.ai/about"),
    );
    expect(headMeta('meta[name="description"]')).toContain(
      "mission, history, people, and operating principles behind CoCalc",
    );
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
    expect(screen.getByText("Jupyter notebooks")).not.toBeNull();
    expect(
      screen
        .getAllByRole("link", { name: /Open all guides/i })
        .some(
          (link) =>
            link.getAttribute("href") ===
            "https://sagemathinc.github.io/cocalc-guides/",
        ),
    ).toBe(true);
    expect(
      screen.getAllByRole("link", { name: "Browse docs" }).length,
    ).toBeGreaterThan(0);
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
              cpu_5h_seconds: 3_600,
              egress_5h_bytes: 1_000_000_000,
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
              cpu_5h_seconds: 18_000,
              egress_5h_bytes: 12_000_000_000,
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
              cpu_5h_seconds: 252_000,
              egress_5h_bytes: 125_000_000_000,
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
        config={{ is_authenticated: true, site_name: "Launchpad" }}
        initialRoute={pricingRoute}
      />,
    );

    expect(
      screen.getByRole("heading", {
        name: "Choose Your Launchpad Membership",
      }),
    ).not.toBeNull();
    expect(
      screen.getByText(
        "Codex with Luna Medium is included for everyone at no cost, with higher limits on paid plans. Connect your ChatGPT plan or API key to use additional models.",
      ),
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
      screen.getByRole("table", { name: "Membership comparison" }),
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", { name: "Compare Memberships" }),
    ).not.toBeNull();
    expect(screen.getByText("Limits Per Project")).not.toBeNull();
    expect(
      screen.getByText("Global Limits Across All Projects"),
    ).not.toBeNull();
    expect(screen.getByText("Functionality")).not.toBeNull();
    expect(
      screen.getByText(
        "Pay at the end of the month for dedicated project host",
      ),
    ).not.toBeNull();
    expect(screen.getByText("CPU priority")).not.toBeNull();
    expect(screen.getByText("Low")).not.toBeNull();
    expect(screen.getByText("Medium")).not.toBeNull();
    expect(screen.getByText("Highest")).not.toBeNull();
    expect(screen.getByText("8 GB")).not.toBeNull();
    expect(screen.getAllByText("10 GB").length).toBe(2);
    expect(screen.getByText("125 GB")).not.toBeNull();
    expect(screen.queryByText("Managed CPU, rolling 5 hours")).toBeNull();

    fireEvent.click(screen.getByText("Compare exact limits and features"));

    expect(
      await screen.findByText("Managed CPU, rolling 5 hours"),
    ).not.toBeNull();
    expect(screen.getByText("Compute and projects")).not.toBeNull();
    expect(screen.getByText("Network transfer")).not.toBeNull();
    expect(screen.getByText("Storage and backups")).not.toBeNull();
    expect(screen.getByText("AI and Codex automation")).not.toBeNull();
    expect(screen.getByText("Collaboration and courses")).not.toBeNull();
    expect(screen.getByText("5 CPU-hours")).not.toBeNull();
    expect(screen.getByText("12 GB")).not.toBeNull();
    expect(
      screen.getByText("Project collaborators and pending invitations"),
    ).not.toBeNull();
    expect(
      screen.getByText("Included AI usage, rolling 5 hours"),
    ).not.toBeNull();
    expect(screen.getByText("Rent dedicated project hosts")).not.toBeNull();
    expect(
      screen.getByText(/These are the current membership parameters/),
    ).not.toBeNull();
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
      screen.getByRole("heading", { name: "For Teams and Organizations" }),
    ).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Team seats" })).not.toBeNull();
    expect(
      screen.getByRole("heading", { name: "Organization licenses" }),
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", { name: "Dedicated project hosts" }),
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", {
        name: "Quotes and customized invoices",
      }),
    ).not.toBeNull();
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
        /William is both the CEO and a lead software developer across the front and back end of CoCalc/i,
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
      screen.getByText("Launchpad · Last Updated: June 30, 2026"),
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

  it("links the accessibility statement to the standalone HTML report", async () => {
    await renderPublicApp(
      <PublicApp
        config={{ policy_pages: "sagemathinc", site_name: "Launchpad" }}
        initialRoute={policiesRoute({
          policySlug: "accessibility",
          view: "policies-detail",
        })}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Accessibility Statement" }),
    ).not.toBeNull();
    const reportLink = screen.getByRole("link", {
      name: "Accessibility Conformance Report (based on VPAT® Version 2.5Rev)",
    });
    expect(reportLink).toHaveAttribute(
      "href",
      "/public/documents/SageMathInc_ACR_VPAT2.5Rev_WCAG_August2026.html",
    );
    expect(reportLink).toHaveAttribute("target", "_blank");
    expect(reportLink).toHaveAttribute("rel", "noopener");
  });

  it("provides a responsive semantic HTML conformance report", () => {
    const reportHtml = readFileSync(
      join(
        __dirname,
        "../../../assets/public/documents/SageMathInc_ACR_VPAT2.5Rev_WCAG_August2026.html",
      ),
      "utf8",
    );
    const reportDocument = new DOMParser().parseFromString(
      reportHtml,
      "text/html",
    );
    const reportContainer = document.createElement("div");
    reportContainer.innerHTML = reportDocument.body.innerHTML;

    expect(reportDocument.documentElement.getAttribute("lang")).toBe("en");
    const report = within(reportContainer);
    expect(
      report.getByRole("heading", {
        name: "SageMath, Inc. Accessibility Conformance Report",
      }),
    ).not.toBeNull();
    expect(
      report.getByText("CoCalc.ai web application (continuously delivered)"),
    ).not.toBeNull();
    expect(report.getByText("August 11, 2026")).not.toBeNull();
    expect(report.getByText(/excludes user-authored content;/)).not.toBeNull();
    expect(
      report.getByText(/Manual production testing covered/),
    ).not.toBeNull();
    expect(
      report.getByText(
        /No screen-reader or other assistive-technology testing/,
      ),
    ).not.toBeNull();

    const tables = report.getAllByRole("table");
    expect(tables).toHaveLength(3);
    expect(within(tables[0]).getAllByRole("row")).toHaveLength(4);
    expect(within(tables[1]).getAllByRole("row")).toHaveLength(33);
    expect(within(tables[2]).getAllByRole("row")).toHaveLength(25);
    expect(within(tables[0]).getAllByText(/Level AAA \(No\)/)).toHaveLength(3);
    const videoOnlyRow = within(tables[1])
      .getByRole("rowheader", {
        name: /1\.2\.1 Audio-only and Video-only \(Prerecorded\)/,
      })
      .closest("tr");
    expect(videoOnlyRow).not.toBeNull();
    expect(
      within(videoOnlyRow!).getByText("Partially supports"),
    ).not.toBeNull();
    expect(
      within(videoOnlyRow!).getByText(/supplemental previews/),
    ).not.toBeNull();
    const infoRelationshipsRow = within(tables[1])
      .getByRole("rowheader", {
        name: /1\.3\.1 Info and Relationships/,
      })
      .closest("tr");
    expect(infoRelationshipsRow).not.toBeNull();
    expect(
      within(infoRelationshipsRow!).getByText("Partially supports"),
    ).not.toBeNull();
    expect(
      within(infoRelationshipsRow!).getByText(
        /visible labels are rendered separately from their controls/,
      ),
    ).not.toBeNull();
    const useOfColorRow = within(tables[1])
      .getByRole("rowheader", {
        name: /1\.4\.1 Use of Color/,
      })
      .closest("tr");
    expect(useOfColorRow).not.toBeNull();
    expect(
      within(useOfColorRow!).getByText("Partially supports"),
    ).not.toBeNull();
    expect(
      within(useOfColorRow!).getByText(/removes text decoration/),
    ).not.toBeNull();
    expect(
      within(useOfColorRow!).getByText(/distinguished.*primarily by color/),
    ).not.toBeNull();
    const meaningfulSequenceRow = within(tables[1])
      .getByRole("rowheader", {
        name: /1\.3\.2 Meaningful Sequence/,
      })
      .closest("tr");
    expect(meaningfulSequenceRow).not.toBeNull();
    expect(within(meaningfulSequenceRow!).getByText("Supports")).not.toBeNull();
    expect(
      within(meaningfulSequenceRow!).getByText(
        /no layout reordering that changed the meaning/,
      ),
    ).not.toBeNull();
    const sensoryCharacteristicsRow = within(tables[1])
      .getByRole("rowheader", {
        name: /1\.3\.3 Sensory Characteristics/,
      })
      .closest("tr");
    expect(sensoryCharacteristicsRow).not.toBeNull();
    expect(
      within(sensoryCharacteristicsRow!).getByText("Partially supports"),
    ).not.toBeNull();
    expect(
      within(sensoryCharacteristicsRow!).getByText(/rely on visual position/),
    ).not.toBeNull();
    expect(
      within(sensoryCharacteristicsRow!).getByText(/Fix the error above/),
    ).not.toBeNull();
    const pauseStopHideRow = within(tables[1])
      .getByRole("rowheader", {
        name: /2\.2\.2 Pause, Stop, Hide/,
      })
      .closest("tr");
    expect(pauseStopHideRow).not.toBeNull();
    expect(
      within(pauseStopHideRow!).getByText("Partially supports"),
    ).not.toBeNull();
    expect(
      within(pauseStopHideRow!).getByText(/repeat on ten-second cycles/),
    ).not.toBeNull();
    expect(
      within(pauseStopHideRow!).getByText("prefers-reduced-motion"),
    ).not.toBeNull();
    const threeFlashesRow = within(tables[1])
      .getByRole("rowheader", {
        name: /2\.3\.1 Three Flashes or Below Threshold/,
      })
      .closest("tr");
    expect(threeFlashesRow).not.toBeNull();
    expect(within(threeFlashesRow!).getByText("Supports")).not.toBeNull();
    expect(
      within(threeFlashesRow!).getByText(
        /cycle no faster than once per second/,
      ),
    ).not.toBeNull();
    expect(
      within(threeFlashesRow!).getByText(/frame-by-frame flash analysis/),
    ).not.toBeNull();
    const keyboardRow = within(tables[1])
      .getByRole("rowheader", {
        name: /2\.1\.1 Keyboard/,
      })
      .closest("tr");
    expect(keyboardRow).not.toBeNull();
    expect(within(keyboardRow!).getByText("Partially supports")).not.toBeNull();
    expect(
      within(keyboardRow!).getByText(/can be navigated using Tab/),
    ).not.toBeNull();
    expect(
      within(keyboardRow!).getByText(/mouse-only controls elsewhere/),
    ).not.toBeNull();
    const keyboardTrapRow = within(tables[1])
      .getByRole("rowheader", {
        name: /2\.1\.2 No Keyboard Trap/,
      })
      .closest("tr");
    expect(keyboardTrapRow).not.toBeNull();
    expect(
      within(keyboardTrapRow!).getByText("Partially supports"),
    ).not.toBeNull();
    expect(
      within(keyboardTrapRow!).getByText(
        /did not move focus out of the chat editor/,
      ),
    ).not.toBeNull();
    const characterKeyShortcutsRow = within(tables[1])
      .getByRole("rowheader", {
        name: /2\.1\.4 Character Key Shortcuts/,
      })
      .closest("tr");
    expect(characterKeyShortcutsRow).not.toBeNull();
    expect(
      within(characterKeyShortcutsRow!).getByText("Supports"),
    ).not.toBeNull();
    expect(
      within(characterKeyShortcutsRow!).getByText(
        /did not activate commands on the Files or Profile pages/,
      ),
    ).not.toBeNull();
    expect(
      within(characterKeyShortcutsRow!).getByText(
        /active only while focus is within the notebook editor/,
      ),
    ).not.toBeNull();
    const focusOrderRow = within(tables[1])
      .getByRole("rowheader", {
        name: /2\.4\.3 Focus Order/,
      })
      .closest("tr");
    expect(focusOrderRow).not.toBeNull();
    expect(within(focusOrderRow!).getByText("Supports")).not.toBeNull();
    expect(
      within(focusOrderRow!).getByText(/left to right, then top to bottom/),
    ).not.toBeNull();
    const linkPurposeRow = within(tables[1])
      .getByRole("rowheader", {
        name: /2\.4\.4 Link Purpose \(In Context\)/,
      })
      .closest("tr");
    expect(linkPurposeRow).not.toBeNull();
    expect(within(linkPurposeRow!).getByText("Supports")).not.toBeNull();
    expect(
      within(linkPurposeRow!).getByText(
        /surrounding text that describes the destination or action/,
      ),
    ).not.toBeNull();
    expect(
      within(linkPurposeRow!).getByText(/use explanatory tooltips/),
    ).not.toBeNull();
    const onFocusRow = within(tables[1])
      .getByRole("rowheader", {
        name: /3\.2\.1 On Focus/,
      })
      .closest("tr");
    expect(onFocusRow).not.toBeNull();
    expect(within(onFocusRow!).getByText("Supports")).not.toBeNull();
    expect(
      within(onFocusRow!).getByText(/No change of context on focus/),
    ).not.toBeNull();
    const onInputRow = within(tables[1])
      .getByRole("rowheader", {
        name: /3\.2\.2 On Input/,
      })
      .closest("tr");
    expect(onInputRow).not.toBeNull();
    expect(within(onInputRow!).getByText("Supports")).not.toBeNull();
    expect(
      within(onInputRow!).getByText(/long-term use have not identified/),
    ).not.toBeNull();
    expect(
      within(onInputRow!).getByText(/submit an unrelated action/),
    ).not.toBeNull();
    const consistentHelpRow = within(tables[1])
      .getByRole("rowheader", {
        name: /3\.2\.6 Consistent Help/,
      })
      .closest("tr");
    expect(consistentHelpRow).not.toBeNull();
    expect(within(consistentHelpRow!).getByText("Supports")).not.toBeNull();
    expect(
      within(consistentHelpRow!).getByText(
        /Support and Docs icons remain in the top-right area/,
      ),
    ).not.toBeNull();
    expect(
      within(consistentHelpRow!).getByText(
        /without changing those global help mechanisms/,
      ),
    ).not.toBeNull();
    const pointerGesturesRow = within(tables[1])
      .getByRole("rowheader", {
        name: /2\.5\.1 Pointer Gestures/,
      })
      .closest("tr");
    expect(pointerGesturesRow).not.toBeNull();
    expect(within(pointerGesturesRow!).getByText("Supports")).not.toBeNull();
    expect(
      within(pointerGesturesRow!).getByText(/support pinch-to-zoom/),
    ).not.toBeNull();
    expect(
      within(pointerGesturesRow!).getByText(/single-pointer controls/),
    ).not.toBeNull();
    const pointerCancellationRow = within(tables[1])
      .getByRole("rowheader", {
        name: /2\.5\.2 Pointer Cancellation/,
      })
      .closest("tr");
    expect(pointerCancellationRow).not.toBeNull();
    expect(
      within(pointerCancellationRow!).getByText("Supports"),
    ).not.toBeNull();
    expect(
      within(pointerCancellationRow!).getByText(
        /No destructive or otherwise irreversible action/,
      ),
    ).not.toBeNull();
    const labelInNameRow = within(tables[1])
      .getByRole("rowheader", {
        name: /2\.5\.3 Label in Name/,
      })
      .closest("tr");
    expect(labelInNameRow).not.toBeNull();
    expect(
      within(labelInNameRow!).getByText("Partially supports"),
    ).not.toBeNull();
    expect(
      within(labelInNameRow!).getByText(
        /accessible name is absent or derived from placeholder text/,
      ),
    ).not.toBeNull();
    const identifyInputPurposeRow = within(tables[2])
      .getByRole("rowheader", {
        name: /1\.3\.5 Identify Input Purpose/,
      })
      .closest("tr");
    expect(identifyInputPurposeRow).not.toBeNull();
    expect(
      within(identifyInputPurposeRow!).getByText("Partially supports"),
    ).not.toBeNull();
    expect(
      within(identifyInputPurposeRow!).getByText("one-time-code"),
    ).not.toBeNull();
    expect(
      within(identifyInputPurposeRow!).getByText(
        /Profile display-name field disables autocomplete/,
      ),
    ).not.toBeNull();
    const contrastRow = within(tables[2])
      .getByRole("rowheader", {
        name: /1\.4\.3 Contrast \(Minimum\)/,
      })
      .closest("tr");
    expect(contrastRow).not.toBeNull();
    expect(within(contrastRow!).getByText("Partially supports")).not.toBeNull();
    expect(within(contrastRow!).getByText("#c0c0c0")).not.toBeNull();
    expect(
      within(contrastRow!).getByText(/approximately 1\.82:1/),
    ).not.toBeNull();
    const imagesOfTextRow = within(tables[2])
      .getByRole("rowheader", {
        name: /1\.4\.5 Images of Text/,
      })
      .closest("tr");
    expect(imagesOfTextRow).not.toBeNull();
    expect(within(imagesOfTextRow!).getByText("Supports")).not.toBeNull();
    expect(
      within(imagesOfTextRow!).getByText(/substantial visual content/),
    ).not.toBeNull();
    const languageOfPartsRow = within(tables[2])
      .getByRole("rowheader", {
        name: /3\.1\.2 Language of Parts/,
      })
      .closest("tr");
    expect(languageOfPartsRow).not.toBeNull();
    expect(
      within(languageOfPartsRow!).getByText("Partially supports"),
    ).not.toBeNull();
    expect(
      within(languageOfPartsRow!).getByText(/no systematic use of/),
    ).not.toBeNull();
    const nonTextContrastRow = within(tables[2])
      .getByRole("rowheader", {
        name: /1\.4\.11 Non-text Contrast/,
      })
      .closest("tr");
    expect(nonTextContrastRow).not.toBeNull();
    expect(
      within(nonTextContrastRow!).getByText("Partially supports"),
    ).not.toBeNull();
    expect(within(nonTextContrastRow!).getByText("#c0c0c0")).not.toBeNull();
    expect(
      within(nonTextContrastRow!).getByText(/required 3:1/),
    ).not.toBeNull();
    const textSpacingRow = within(tables[2])
      .getByRole("rowheader", {
        name: /1\.4\.12 Text Spacing/,
      })
      .closest("tr");
    expect(textSpacingRow).not.toBeNull();
    expect(
      within(textSpacingRow!).getByText("Partially supports"),
    ).not.toBeNull();
    expect(
      within(textSpacingRow!).getByText(
        /wrapping disabled and overflow hidden/,
      ),
    ).not.toBeNull();
    const hoverContentRow = within(tables[2])
      .getByRole("rowheader", {
        name: /1\.4\.13 Content on Hover or Focus/,
      })
      .closest("tr");
    expect(hoverContentRow).not.toBeNull();
    expect(
      within(hoverContentRow!).getByText("Partially supports"),
    ).not.toBeNull();
    expect(
      within(hoverContentRow!).getByText(/without adding Escape-key dismissal/),
    ).not.toBeNull();
    const errorIdentificationRow = within(tables[1])
      .getByRole("rowheader", {
        name: /3\.3\.1 Error Identification/,
      })
      .closest("tr");
    expect(errorIdentificationRow).not.toBeNull();
    expect(
      within(errorIdentificationRow!).getByText("Partially supports"),
    ).not.toBeNull();
    expect(
      within(errorIdentificationRow!).getByText(
        /remained disabled for blank and clearly malformed input/,
      ),
    ).not.toBeNull();
    expect(
      within(errorIdentificationRow!).getByText(
        /Error: Unable to start email sign-in/,
      ),
    ).not.toBeNull();
    const redundantEntryRow = within(tables[1])
      .getByRole("rowheader", {
        name: /3\.3\.7 Redundant Entry/,
      })
      .closest("tr");
    expect(redundantEntryRow).not.toBeNull();
    expect(within(redundantEntryRow!).getByText("Supports")).not.toBeNull();
    expect(
      within(redundantEntryRow!).getByText(
        /did not identify a first-party multi-step process/,
      ),
    ).not.toBeNull();
    expect(
      within(redundantEntryRow!).getByText(/rather than to collect duplicate/),
    ).not.toBeNull();
    const nameRoleValueRow = within(tables[1])
      .getByRole("rowheader", {
        name: /4\.1\.2 Name, Role, Value/,
      })
      .closest("tr");
    expect(nameRoleValueRow).not.toBeNull();
    expect(
      within(nameRoleValueRow!).getByText("Partially supports"),
    ).not.toBeNull();
    expect(
      within(nameRoleValueRow!).getByText(
        /compact menu destinations without accessible names/,
      ),
    ).not.toBeNull();
    expect(
      report.queryByRole("heading", {
        name: "Table 3: Success Criteria, Level AAA",
      }),
    ).toBeNull();
    const orientationRow = within(tables[2])
      .getByRole("rowheader", { name: /1\.3\.4 Orientation/ })
      .closest("tr");
    expect(orientationRow).not.toBeNull();
    expect(
      within(orientationRow!).getByText("Partially supports"),
    ).not.toBeNull();
    expect(
      within(orientationRow!).getByText(/390 CSS-pixel portrait viewport/),
    ).not.toBeNull();
    const resizeTextRow = within(tables[2])
      .getByRole("rowheader", { name: /1\.4\.4 Resize text/ })
      .closest("tr");
    expect(resizeTextRow).not.toBeNull();
    expect(within(resizeTextRow!).getByText("Supports")).not.toBeNull();
    expect(
      within(resizeTextRow!).getByText(/remained usable at 200% browser zoom/),
    ).not.toBeNull();
    const reflowRow = within(tables[2])
      .getByRole("rowheader", { name: /1\.4\.10 Reflow/ })
      .closest("tr");
    expect(reflowRow).not.toBeNull();
    expect(within(reflowRow!).getByText("Partially supports")).not.toBeNull();
    expect(
      within(reflowRow!).getByText(/settings required horizontal scrolling/),
    ).not.toBeNull();
    const multipleWaysRow = within(tables[2])
      .getByRole("rowheader", { name: /2\.4\.5 Multiple Ways/ })
      .closest("tr");
    expect(multipleWaysRow).not.toBeNull();
    expect(within(multipleWaysRow!).getByText("Supports")).not.toBeNull();
    expect(
      within(multipleWaysRow!).getByText(
        /same destinations as the persistent Settings navigation/,
      ),
    ).not.toBeNull();
    const headingsAndLabelsRow = within(tables[2])
      .getByRole("rowheader", { name: /2\.4\.6 Headings and Labels/ })
      .closest("tr");
    expect(headingsAndLabelsRow).not.toBeNull();
    expect(
      within(headingsAndLabelsRow!).getByText("Partially supports"),
    ).not.toBeNull();
    expect(
      within(headingsAndLabelsRow!).getByText(
        /Billing and Purchases share one card icon/,
      ),
    ).not.toBeNull();
    expect(
      within(headingsAndLabelsRow!).getByText(
        /cannot be distinguished from their displayed icons alone/,
      ),
    ).not.toBeNull();
    const focusVisibleRow = within(tables[2])
      .getByRole("rowheader", { name: /2\.4\.7 Focus Visible/ })
      .closest("tr");
    expect(focusVisibleRow).not.toBeNull();
    expect(
      within(focusVisibleRow!).getByText("Partially supports"),
    ).not.toBeNull();
    expect(
      within(focusVisibleRow!).getByText(
        /star control received keyboard focus/,
      ),
    ).not.toBeNull();
    const focusNotObscuredRow = within(tables[2])
      .getByRole("rowheader", {
        name: /2\.4\.11 Focus Not Obscured \(Minimum\)/,
      })
      .closest("tr");
    expect(focusNotObscuredRow).not.toBeNull();
    expect(within(focusNotObscuredRow!).getByText("Supports")).not.toBeNull();
    expect(
      within(focusNotObscuredRow!).getByText(
        /did not identify focused controls completely obscured/,
      ),
    ).not.toBeNull();
    expect(
      within(focusNotObscuredRow!).getByText(
        /focus remains within the active dialog/,
      ),
    ).not.toBeNull();
    const draggingRow = within(tables[2])
      .getByRole("rowheader", { name: /2\.5\.7 Dragging Movements/ })
      .closest("tr");
    expect(draggingRow).not.toBeNull();
    expect(within(draggingRow!).getByText("Partially supports")).not.toBeNull();
    expect(
      within(draggingRow!).getByText(/reordering starred projects/),
    ).not.toBeNull();
    const consistentNavigationRow = within(tables[2])
      .getByRole("rowheader", { name: /3\.2\.3 Consistent Navigation/ })
      .closest("tr");
    expect(consistentNavigationRow).not.toBeNull();
    expect(
      within(consistentNavigationRow!).getByText("Supports"),
    ).not.toBeNull();
    expect(
      within(consistentNavigationRow!).getByText(
        /remain in stable relative locations and order/,
      ),
    ).not.toBeNull();
    const consistentIdentificationRow = within(tables[2])
      .getByRole("rowheader", { name: /3\.2\.4 Consistent Identification/ })
      .closest("tr");
    expect(consistentIdentificationRow).not.toBeNull();
    expect(
      within(consistentIdentificationRow!).getByText("Supports"),
    ).not.toBeNull();
    expect(
      within(consistentIdentificationRow!).getByText(
        /repeated functions such as close, search, and add/,
      ),
    ).not.toBeNull();
    expect(
      within(consistentIdentificationRow!).getByText(
        /different functions reuse a card icon/,
      ),
    ).not.toBeNull();
    const errorSuggestionRow = within(tables[2])
      .getByRole("rowheader", { name: /3\.3\.3 Error Suggestion/ })
      .closest("tr");
    expect(errorSuggestionRow).not.toBeNull();
    expect(
      within(errorSuggestionRow!).getByText("Partially supports"),
    ).not.toBeNull();
    expect(
      within(errorSuggestionRow!).getByText(
        /disabled without known correction guidance/,
      ),
    ).not.toBeNull();
    expect(
      within(errorSuggestionRow!).getByText(/without a suggested next step/),
    ).not.toBeNull();
    const errorPreventionRow = within(tables[2])
      .getByRole("rowheader", {
        name: /3\.3\.4 Error Prevention \(Legal, Financial, Data\)/,
      })
      .closest("tr");
    expect(errorPreventionRow).not.toBeNull();
    expect(within(errorPreventionRow!).getByText("Supports")).not.toBeNull();
    expect(
      within(errorPreventionRow!).getByText(/backups provide a recovery path/),
    ).not.toBeNull();
    expect(
      within(errorPreventionRow!).getByText(
        /purchase modal offers one-click purchase/,
      ),
    ).not.toBeNull();
    expect(
      within(errorPreventionRow!).getByText(/type a confirmation word/),
    ).not.toBeNull();
    const accessibleAuthenticationRow = within(tables[2])
      .getByRole("rowheader", {
        name: /3\.3\.8 Accessible Authentication \(Minimum\)/,
      })
      .closest("tr");
    expect(accessibleAuthenticationRow).not.toBeNull();
    expect(
      within(accessibleAuthenticationRow!).getByText("Supports"),
    ).not.toBeNull();
    expect(
      within(accessibleAuthenticationRow!).getByText(
        /passwordless email sign-in and SSO/,
      ),
    ).not.toBeNull();
    expect(
      within(accessibleAuthenticationRow!).getByText(
        /no deliberate restrictions on paste or password-manager use/,
      ),
    ).not.toBeNull();
    const statusMessagesRow = within(tables[2])
      .getByRole("rowheader", { name: /4\.1\.3 Status Messages/ })
      .closest("tr");
    expect(statusMessagesRow).not.toBeNull();
    expect(
      within(statusMessagesRow!).getByText("Partially supports"),
    ).not.toBeNull();
    expect(
      within(statusMessagesRow!).getByText(/main connection-status indicator/),
    ).not.toBeNull();
    expect(reportHtml).toContain("@media screen and (max-width: 50rem)");
    expect(reportHtml).not.toContain("overflow-x");
    expect(reportHtml).not.toContain("@page");
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

  it("renders plain-text excerpts in public news cards", async () => {
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

    expect(
      await screen.findByRole("heading", {
        name: "Markdown update",
        level: 2,
      }),
    ).not.toBeNull();
    expect(screen.getByText("This is a test. foo bar")).not.toBeNull();
    expect(screen.queryByRole("img", { name: "Image" })).toBeNull();
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
      expect(fetchMock).toHaveBeenCalledWith("/api/v2/news/list");
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

    expect(screen.getByText("Install CoCalc Plus")).not.toBeNull();
    expect(
      screen.getByText("Need local CoCalc before choosing a shared path?"),
    ).not.toBeNull();
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
    expect(screen.getByText("Which path fits?")).not.toBeNull();
    const productChooser = screen.getByRole("list", {
      name: "CoCalc product path chooser",
    });
    expect(
      within(productChooser).getByRole("link", {
        name: /CoCalc Launchpad.*customer-operated private environment/,
      }),
    ).toHaveAttribute("href", "/products/cocalc-launchpad");
  });

  it("renders the cocalc launchpad page", async () => {
    await renderPublicApp(
      <PublicApp
        config={{ site_name: "Launchpad" }}
        initialRoute={productsRoute({ view: "products-cocalc-launchpad" })}
      />,
    );

    expect(screen.getByText("Install CoCalc Launchpad")).not.toBeNull();
    expect(
      screen.getByText("Need a bounded private CoCalc deployment?"),
    ).not.toBeNull();
  });

  it("renders the cocalc star page", async () => {
    await renderPublicApp(
      <PublicApp
        config={{ site_name: "Launchpad" }}
        initialRoute={productsRoute({ view: "products-cocalc-star" })}
      />,
    );

    expect(screen.getAllByText("Install CoCalc Star")).toHaveLength(2);
    expect(
      screen.getByText("Run a shared CoCalc site on one Ubuntu VM."),
    ).not.toBeNull();
  });

  it("renders the cocalc rocket page", async () => {
    await renderPublicApp(
      <PublicApp
        config={{ site_name: "Launchpad" }}
        initialRoute={productsRoute({ view: "products-cocalc-rocket" })}
      />,
    );

    expect(
      screen.getByText("Planning an institutional private CoCalc deployment?"),
    ).not.toBeNull();
    expect(screen.getByText("Talk with CoCalc about Rocket")).not.toBeNull();
  });
});

describe("feature configuration loading", () => {
  const researchRoute = {
    section: "features" as const,
    route: { view: "detail" as const, slug: "research-compute" },
  };
  let authBootstrap: jest.SpiedFunction<
    typeof authApi.getControlPlaneAuthBootstrap
  >;

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((next) => {
      resolve = next;
    });
    return { promise, resolve };
  }

  function customizeResponse(product?: string): Response {
    return {
      ok: true,
      json: async () => ({
        configuration: { cocalc_product: product, site_name: "CoCalc" },
      }),
    } as Response;
  }

  function seedServerHead() {
    document.title = "Server compute title";
    const canonical = document.createElement("link");
    canonical.setAttribute("data-cocalc-public-route-meta", "canonical");
    canonical.rel = "canonical";
    canonical.href = "https://example.test/features/research-compute";
    document.head.appendChild(canonical);
    const description = document.createElement("meta");
    description.setAttribute("data-cocalc-public-route-meta", "description");
    description.name = "description";
    description.content = "Server compute description";
    document.head.appendChild(description);
  }

  function expectServerHead() {
    expect(document.title).toBe("Server compute title");
    expect(canonicalHref()).toBe(
      "https://example.test/features/research-compute",
    );
    expect(headMeta('[data-cocalc-public-route-meta="description"]')).toBe(
      "Server compute description",
    );
  }

  function expectNoCompute() {
    expect(
      document.querySelector('a[href="/features/research-compute"]'),
    ).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Research Compute", level: 1 }),
    ).toBeNull();
    expect(
      screen.queryByRole("link", { name: "Understand project hosts" }),
    ).toBeNull();
  }

  beforeEach(async () => {
    await import("../features/app");
    authBootstrap = jest.spyOn(authApi, "getControlPlaneAuthBootstrap");
    authBootstrap.mockReturnValue(new Promise(() => {}));
    seedServerHead();
  });

  afterEach(() => {
    authBootstrap.mockRestore();
  });

  it("waits for Plus customize even if auth bootstrap resolves first", async () => {
    const customize = deferred<Response>();
    global.fetch = jest.fn(() => customize.promise) as typeof fetch;
    authBootstrap.mockResolvedValue({ signed_in: true } as Awaited<
      ReturnType<typeof authApi.getControlPlaneAuthBootstrap>
    >);
    render(<PublicApp initialRoute={researchRoute} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(authBootstrap).toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledWith("/customize");
    expectNoCompute();
    expect(screen.queryByText("Feature page not found")).toBeNull();
    expectServerHead();

    await act(async () => {
      customize.resolve(customizeResponse("plus"));
    });
    expect(await screen.findByText("Feature page not found")).not.toBeNull();
    expectNoCompute();
    expect(document.title).not.toContain("CPU, RAM, and GPU");
  });

  it.each([true, false])(
    "preserves early auth bootstrap (signed in: %s) after customize resolves",
    async (signedIn) => {
      const customize = deferred<Response>();
      global.fetch = jest.fn(() => customize.promise) as typeof fetch;
      authBootstrap.mockResolvedValue({ signed_in: signedIn } as Awaited<
        ReturnType<typeof authApi.getControlPlaneAuthBootstrap>
      >);
      render(<PublicApp initialRoute={researchRoute} />);
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByRole("status")).toHaveTextContent("Loading features");
      expectServerHead();
      await act(async () => {
        customize.resolve({
          ok: true,
          json: async () => ({
            configuration: {
              cocalc_product: "launchpad",
              is_authenticated: !signedIn,
            },
          }),
        } as Response);
      });
      await screen.findByRole("heading", {
        name: "Research Compute",
        level: 1,
      });
      expect(screen.queryByRole("status")).toBeNull();
      if (signedIn) {
        expect(screen.getByRole("link", { name: "Projects" })).not.toBeNull();
        expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
      } else {
        expect(screen.getByRole("link", { name: "Sign in" })).not.toBeNull();
        expect(screen.queryByRole("link", { name: "Projects" })).toBeNull();
      }
    },
  );

  it("preserves the initial head until a full product becomes available", async () => {
    const customize = deferred<Response>();
    global.fetch = jest.fn(() => customize.promise) as typeof fetch;
    render(<PublicApp initialRoute={researchRoute} />);
    await act(async () => {
      await Promise.resolve();
    });
    expectNoCompute();
    expectServerHead();

    await act(async () => {
      customize.resolve(customizeResponse("launchpad"));
    });
    expect(
      await screen.findByRole("heading", {
        name: "Research Compute",
        level: 1,
      }),
    ).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "Understand project hosts" }),
    ).toHaveAttribute("href", "/docs/hosts/project-hosts");
    expect(document.title).toContain("CPU, RAM, and GPU");
    expect(canonicalHref()).toContain("/features/research-compute");
  });

  it.each([
    "network",
    "http",
    "json",
    "missing-config",
    "invalid-config",
    "missing-product",
  ])(
    "keeps unknown availability hidden after a %s failure",
    async (failure) => {
      global.fetch = jest.fn(async () => {
        if (failure === "network") throw new Error("synthetic network failure");
        if (failure === "http") {
          // An unsuccessful response must not enable the feature, even if a
          // configuration-shaped payload happens to accompany it.
          return { ...customizeResponse("launchpad"), ok: false };
        }
        if (failure === "json") {
          return {
            ok: true,
            json: async () => {
              throw new Error("synthetic invalid JSON");
            },
          };
        }
        if (failure === "missing-config")
          return { ok: true, json: async () => ({}) };
        if (failure === "invalid-config")
          return { ok: true, json: async () => ({ configuration: [] }) };
        return customizeResponse();
      }) as typeof fetch;
      const { rerender } = render(<PublicApp initialRoute={researchRoute} />);
      expect(
        await screen.findByText(/Feature availability could not be checked/),
      ).not.toBeNull();
      expect(screen.queryByText("Feature page not found")).toBeNull();
      expectNoCompute();
      expectServerHead();
      expect(
        screen.getByRole("link", { name: "Back to features" }),
      ).toHaveAttribute("href", "/features");

      // The failed request does not make the rest of the feature catalog
      // unusable or expose Compute through its index/subnav.
      rerender(
        <PublicApp
          initialRoute={{ section: "features", route: { view: "index" } }}
        />,
      );
      expect(await screen.findByText("Runtime")).not.toBeNull();
      expect(
        document.querySelector('a[href="/features/terminal"]'),
      ).not.toBeNull();
      expectNoCompute();
    },
  );

  it.each(["plus", "launchpad", "rocket"])(
    "uses an injected %s product without waiting for customize",
    async (product) => {
      render(
        <PublicApp
          config={{ cocalc_product: product }}
          initialRoute={researchRoute}
        />,
      );
      if (product === "plus") {
        expect(
          await screen.findByText("Feature page not found"),
        ).not.toBeNull();
        expectNoCompute();
      } else {
        expect(
          await screen.findByRole("heading", {
            name: "Research Compute",
            level: 1,
          }),
        ).not.toBeNull();
      }
      expect(global.fetch).not.toHaveBeenCalledWith("/customize");
    },
  );

  it("discards an old customize result after props change and another request starts", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    global.fetch = jest
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise) as typeof fetch;
    const { rerender } = render(<PublicApp initialRoute={researchRoute} />);
    await act(async () => {
      await Promise.resolve();
    });
    rerender(
      <PublicApp
        config={{ cocalc_product: "plus" }}
        initialRoute={researchRoute}
      />,
    );
    expect(await screen.findByText("Feature page not found")).not.toBeNull();
    rerender(<PublicApp initialRoute={researchRoute} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Feature page not found")).toBeNull();

    await act(async () => {
      first.resolve(customizeResponse("launchpad"));
    });
    expectNoCompute();
    expect(screen.queryByText("Feature page not found")).toBeNull();
    await act(async () => {
      second.resolve(customizeResponse("rocket"));
    });
    expect(
      await screen.findByRole("heading", {
        name: "Research Compute",
        level: 1,
      }),
    ).not.toBeNull();
  });

  it.each([
    [
      { view: "index" as const },
      "One persistent computer for people, tools, and agents.",
    ],
    [{ view: "detail" as const, slug: "terminal" }, "Linux Terminal"],
  ])(
    "keeps independent feature route %j usable while customize is pending",
    async (route, title) => {
      global.fetch = jest.fn(() => new Promise(() => {})) as typeof fetch;
      render(<PublicApp initialRoute={{ section: "features", route }} />);
      expect(
        await screen.findByRole("heading", { name: title, level: 1 }),
      ).not.toBeNull();
      expect(screen.queryByRole("status")).toBeNull();
      expectNoCompute();
    },
  );

  it("still renders other public sections while customize is pending", async () => {
    const customize = deferred<Response>();
    global.fetch = jest.fn(() => customize.promise) as typeof fetch;
    render(<PublicApp initialRoute={aboutRoute({ view: "about" })} />);
    expect(
      await screen.findByRole("heading", { name: "About CoCalc" }),
    ).not.toBeNull();
    expectNoCompute();
  });
});
