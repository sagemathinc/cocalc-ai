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
            id: "member",
            label: "Member",
            ai_limits: { units_5h: 150, units_7d: 500 },
            price_monthly: 25,
            price_yearly: 225,
            priority: 20,
            project_defaults: {
              disk_quota: 10000,
              memory: 8000,
              mintime: 3600,
            },
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
      screen.getByRole("heading", { name: "Launchpad Pricing" }),
    ).not.toBeNull();
    expect(screen.getByText("Membership-first pricing")).not.toBeNull();
    expect(screen.getByText("Member")).not.toBeNull();
    expect(screen.getAllByRole("link", { name: "Open Store" }).length).toBe(2);
    expect(
      screen.getByText(/the one planned pay-as-you-go exception/i),
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
      screen.getByText("Launchpad · Last Updated: May 13, 2026"),
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
      screen.getByText("Launchpad · Last Updated: April 15, 2026"),
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

    expect(screen.getByText("Install CoCalc Plus")).not.toBeNull();
    expect(screen.getByText("What CoCalc Plus is")).not.toBeNull();
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
    expect(screen.getByText("Hosted CoCalc")).not.toBeNull();
  });

  it("renders the cocalc launchpad page", async () => {
    await renderPublicApp(
      <PublicApp
        config={{ site_name: "Launchpad" }}
        initialRoute={productsRoute({ view: "products-cocalc-launchpad" })}
      />,
    );

    expect(screen.getByText("Install CoCalc Launchpad")).not.toBeNull();
    expect(screen.getByText("What the installer does")).not.toBeNull();
  });

  it("renders the cocalc rocket page", async () => {
    await renderPublicApp(
      <PublicApp
        config={{ site_name: "Launchpad" }}
        initialRoute={productsRoute({ view: "products-cocalc-rocket" })}
      />,
    );

    expect(screen.getByText("What CoCalc Rocket is")).not.toBeNull();
    expect(screen.getByText("Talk with us")).not.toBeNull();
  });
});
