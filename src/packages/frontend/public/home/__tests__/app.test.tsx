/** @jest-environment jsdom */

import { render, screen, waitFor, within } from "@testing-library/react";

import PublicHomeApp from "../app";

const originalFetch = global.fetch;
const BLOCKED_HOMEPAGE_CLAIM_PATTERNS = [
  /CoCalc Star/i,
  /Install CoCalc Star/i,
  /fast team starts/i,
  /quickest start/i,
  /Free local runtime/i,
  /self-service team starts/i,
  /Pricing and licensing/i,
  /Operational proof/i,
  /production private cloud/i,
  /production-ready/i,
  /production readiness/i,
  /multi-bay/i,
  /setup time/i,
  /setup-time/i,
  /restore time/i,
  /restore-time/i,
  /zero outbound/i,
  /zero telemetry/i,
  /offline-only/i,
  /offline only/i,
  /air-gapped/i,
  /air gapped/i,
  /\bSLA\b/i,
  /sovereignty/i,
  /automatic project transfer/i,
  /automatic migration/i,
  /grandfathered hosted prices/i,
  /credit-card/i,
  /credit card/i,
  /card payment/i,
  /Stripe/i,
  /validated demo/i,
  /benchmark/i,
] as const;
const BLOCKED_HOMEPAGE_CLAIM_ATTRIBUTES = [
  "alt",
  "aria-label",
  "title",
] as const;

function getHomepageClaimCorpus(container: HTMLElement): string {
  const corpus = [container.textContent ?? ""];

  for (const element of Array.from(container.querySelectorAll("*"))) {
    for (const attribute of BLOCKED_HOMEPAGE_CLAIM_ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      if (value) {
        corpus.push(value);
      }
    }
  }

  return corpus.join("\n");
}

function expectBlockedHomepageClaimsAbsent(container: HTMLElement) {
  const corpus = getHomepageClaimCorpus(container);
  for (const pattern of BLOCKED_HOMEPAGE_CLAIM_PATTERNS) {
    expect(corpus).not.toMatch(pattern);
  }
}

function expectHomepageSectionsLabeled(container: HTMLElement) {
  const sections = Array.from(container.querySelectorAll("section"));
  expect(sections.length).toBeGreaterThan(0);

  for (const section of sections) {
    expect(section.getAttribute("aria-label")?.trim()).toBeTruthy();
  }
}

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: jest.fn(),
      addListener: jest.fn(),
      dispatchEvent: jest.fn(),
      removeEventListener: jest.fn(),
      removeListener: jest.fn(),
    }),
  });
});

describe("PublicHomeApp", () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("renders the top nav and major landing sections", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => [
        {
          channel: "blog",
          date: 1700000000,
          id: 1,
          tags: ["launch"],
          text: "This is a **news** item.",
          title: "Launch update",
        },
      ],
    }) as typeof fetch;
    const { container } = render(
      <PublicHomeApp
        config={{ site_name: "Launchpad", site_description: "Hello world" }}
      />,
    );

    expect(
      within(screen.getByRole("banner")).getByRole("link", {
        name: "Launchpad home",
      }),
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "CoCalc.ai",
      }),
    ).not.toBeNull();
    const hero = screen.getByRole("region", {
      name: "CoCalc.ai technical workspace",
    });
    expect(
      within(hero).getByText("AI-native technical workspace"),
    ).not.toBeNull();
    expect(
      within(hero)
        .getByRole("link", { name: "Start on CoCalc.ai" })
        .getAttribute("href"),
    ).toBe("/auth/sign-up");
    expect(
      within(hero)
        .getByRole("link", { name: "Install CoCalc Plus" })
        .getAttribute("href"),
    ).toBe("/products/cocalc-plus");
    expect(
      within(hero)
        .getByRole("link", { name: "Compare deployment options" })
        .getAttribute("href"),
    ).toBe("/products");
    const heroSiteLicenseHref = within(hero)
      .getByRole("link", { name: "Discuss site licensing" })
      .getAttribute("href");
    expect(heroSiteLicenseHref).toMatch(/^\/support\/new\?/);
    expect(heroSiteLicenseHref).toContain("subject=Site+license");
    const projectOutcomes = screen.getByRole("group", {
      name: "CoCalc.ai project outcomes",
    });
    expect(within(projectOutcomes).getByText("Shared context")).not.toBeNull();
    expect(
      within(projectOutcomes).getByText("Visible validation"),
    ).not.toBeNull();
    expect(
      within(projectOutcomes).getByText("Recoverable state"),
    ).not.toBeNull();
    const projectPreview = screen.getByRole("group", {
      name: "Live CoCalc project preview",
    });
    expect(within(projectPreview).getByText("research-demo")).not.toBeNull();
    expect(within(projectPreview).getByText("Codex thread")).not.toBeNull();
    expect(within(projectPreview).getByText("Live context")).not.toBeNull();
    expect(within(projectPreview).getByText("Current trail")).not.toBeNull();
    expect(
      within(projectPreview).getByText("pytest passed in run.term"),
    ).not.toBeNull();
    expect(
      within(projectPreview)
        .getByRole("link", { name: /Start a project/i })
        .getAttribute("href"),
    ).toBe("/auth/sign-up");
    expect(
      within(projectPreview)
        .getByRole("link", { name: /Run Linux terminal/i })
        .getAttribute("href"),
    ).toBe("/features/terminal");
    expect(
      within(projectPreview)
        .getByRole("link", { name: /Ask Agent turn/i })
        .getAttribute("href"),
    ).toBe("/features/ai");
    expect(
      within(projectPreview)
        .getByRole("link", { name: /Review History trail/i })
        .getAttribute("href"),
    ).toBe("/features/compare");
    const handoffPath = screen.getByRole("region", {
      name: "CoCalc.ai project handoff path",
    });
    expect(
      within(handoffPath).getByRole("heading", {
        name: "Move from context to agent work without leaving the project.",
      }),
    ).not.toBeNull();
    expect(
      within(handoffPath)
        .getByRole("link", { name: /Start hosted project/i })
        .getAttribute("href"),
    ).toBe("/auth/sign-up");
    expect(
      within(handoffPath)
        .getByRole("link", { name: /Review local runtime/i })
        .getAttribute("href"),
    ).toBe("/products/cocalc-plus");
    expect(
      within(handoffPath)
        .getByRole("link", { name: /Compare deployment paths/i })
        .getAttribute("href"),
    ).toBe("/products");
    expect(
      within(handoffPath)
        .getByRole("link", { name: /Gather the work/i })
        .getAttribute("href"),
    ).toBe("/features/jupyter-notebook");
    expect(
      within(handoffPath)
        .getByRole("link", { name: /Ask for the change/i })
        .getAttribute("href"),
    ).toBe("/features/ai");
    expect(
      within(handoffPath)
        .getByRole("link", { name: /Keep the trail/i })
        .getAttribute("href"),
    ).toBe("/features/compare");
    const workspaceBreadth = screen.getByRole("region", {
      name: "CoCalc.ai workspace breadth",
    });
    expect(
      within(workspaceBreadth).getByRole("heading", {
        name: "One project context for the work that technical teams pass around.",
      }),
    ).not.toBeNull();
    expect(
      within(workspaceBreadth)
        .getByRole("link", { name: /Code and scripts/i })
        .getAttribute("href"),
    ).toBe("/features/compare");
    expect(
      within(workspaceBreadth)
        .getByRole("link", { name: /Notebooks/i })
        .getAttribute("href"),
    ).toBe("/features/jupyter-notebook");
    expect(
      within(workspaceBreadth)
        .getByRole("link", { name: /Documents/i })
        .getAttribute("href"),
    ).toBe("/features/latex-editor");
    expect(
      within(workspaceBreadth)
        .getByRole("link", { name: /Linux compute/i })
        .getAttribute("href"),
    ).toBe("/features/terminal");
    expect(
      within(workspaceBreadth)
        .getByRole("link", { name: /AI agents/i })
        .getAttribute("href"),
    ).toBe("/features/ai");
    expect(
      within(workspaceBreadth)
        .getByRole("link", { name: /Review history/i })
        .getAttribute("href"),
    ).toBe("/features/compare");
    const stateMap = screen.getByRole("region", {
      name: "CoCalc.ai project state map",
    });
    expect(
      within(stateMap).getByRole("heading", {
        name: "Show what a teammate or agent can inspect.",
      }),
    ).not.toBeNull();
    expect(
      within(stateMap)
        .getByRole("link", { name: /Explore shared features/i })
        .getAttribute("href"),
    ).toBe("/features");
    expect(
      within(stateMap)
        .getByRole("link", { name: /See AI workflows/i })
        .getAttribute("href"),
    ).toBe("/features/ai");
    expect(
      within(stateMap)
        .getByRole("link", { name: /Project files/i })
        .getAttribute("href"),
    ).toBe("/features/compare");
    expect(
      within(stateMap)
        .getByRole("link", { name: /Execution record/i })
        .getAttribute("href"),
    ).toBe("/features/terminal");
    expect(
      within(stateMap)
        .getByRole("link", { name: /Codex trail/i })
        .getAttribute("href"),
    ).toBe("/features/ai");
    expect(
      within(stateMap)
        .getByRole("link", { name: /Prior state/i })
        .getAttribute("href"),
    ).toBe("/features/compare");
    expect(
      screen.getByRole("heading", {
        name: "Start with the work surface you need.",
      }),
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", {
        name: "Start where the work begins.",
      }),
    ).not.toBeNull();
    const coreWorkflows = screen.getByRole("region", {
      name: "CoCalc.ai core workflows",
    });
    expect(
      within(coreWorkflows)
        .getByRole("img", { name: "CoCalc project workflow map" })
        .getAttribute("src"),
    ).toBe("/public/landing/project-workflows.jpg");
    expect(
      within(coreWorkflows).getByText("Project-centered workflow map"),
    ).not.toBeNull();
    expect(
      within(coreWorkflows)
        .getByRole("link", { name: "Map project context" })
        .getAttribute("href"),
    ).toBe("/features/compare");
    expect(
      screen.getByRole("heading", {
        name: "Every project brings the workspace with it.",
      }),
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", {
        name: "Pick a starter recipe, then grow the project.",
      }),
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", {
        name: "Built for technical groups.",
      }),
    ).not.toBeNull();
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Recent News" }),
      ).not.toBeNull(),
    );
    expect(
      screen
        .getAllByRole("link", { name: "Install CoCalc Plus" })
        .map((link) => link.getAttribute("href")),
    ).toEqual([
      "/products/cocalc-plus",
      "https://software.cocalc.ai/software/cocalc-plus/index.html",
    ]);
    const deploymentLinks = screen.getAllByRole("link", {
      name: "Compare deployment options",
    });
    expect(deploymentLinks.length).toBeGreaterThan(0);
    expect(
      deploymentLinks.every(
        (link) => link.getAttribute("href") === "/products",
      ),
    ).toBe(true);
    const siteLicenseLinks = screen.getAllByRole("link", {
      name: "Discuss site licensing",
    });
    expect(siteLicenseLinks.length).toBeGreaterThan(0);
    expect(
      siteLicenseLinks.every((link) => {
        const href = link.getAttribute("href");
        return (
          href?.startsWith("/support/new?") &&
          href.includes("subject=Site+license")
        );
      }),
    ).toBe(true);
    expectBlockedHomepageClaimsAbsent(container);
    expectHomepageSectionsLabeled(container);
    expect(
      screen
        .getAllByRole("link", { name: "Explore shared features" })[0]
        .getAttribute("href"),
    ).toBe("/features");
    expect(
      screen
        .getByRole("link", { name: "Explore all features" })
        .getAttribute("href"),
    ).toBe("/features");
    expect(
      screen
        .getAllByRole("link", { name: "See AI workflows" })[0]
        .getAttribute("href"),
    ).toBe("/features/ai");
    expect(screen.queryByText("Open page")).toBeNull();
    const quickStart = screen.getByRole("region", {
      name: "Common CoCalc.ai starting points",
    });
    expect(
      within(quickStart)
        .getByRole("link", { name: /Notebook project/i })
        .getAttribute("href"),
    ).toBe("/features/jupyter-notebook");
    expect(
      within(quickStart)
        .getByRole("link", { name: /Terminal session/i })
        .getAttribute("href"),
    ).toBe("/features/terminal");
    expect(
      within(quickStart)
        .getByRole("link", { name: /Codex thread/i })
        .getAttribute("href"),
    ).toBe("/features/ai");
    expect(
      within(quickStart)
        .getByRole("link", { name: /Course workspace/i })
        .getAttribute("href"),
    ).toBe("/features/teaching");
    const starterRecipes = screen.getByRole("region", {
      name: "CoCalc.ai starter project recipes",
    });
    expect(
      within(starterRecipes)
        .getByRole("link", { name: "Start a project" })
        .getAttribute("href"),
    ).toBe("/auth/sign-up");
    expect(
      within(starterRecipes)
        .getByRole("link", { name: /Analyze data/i })
        .getAttribute("href"),
    ).toBe("/features/jupyter-notebook");
    expect(
      within(starterRecipes)
        .getByRole("link", { name: /Debug a service/i })
        .getAttribute("href"),
    ).toBe("/features/terminal");
    expect(
      within(starterRecipes)
        .getByRole("link", { name: /Ship a patch/i })
        .getAttribute("href"),
    ).toBe("/features/ai");
    expect(
      within(starterRecipes)
        .getByRole("link", { name: /Run a lab/i })
        .getAttribute("href"),
    ).toBe("/features/teaching");
    const projectPackage = screen.getByRole("region", {
      name: "What every CoCalc project includes",
    });
    expect(
      within(projectPackage)
        .getByRole("link", { name: /Files and tools/i })
        .getAttribute("href"),
    ).toBe("/features/compare");
    expect(
      within(projectPackage)
        .getByRole("link", { name: /Linux runtime/i })
        .getAttribute("href"),
    ).toBe("/features/terminal");
    expect(
      within(projectPackage)
        .getByRole("link", { name: /People and agents/i })
        .getAttribute("href"),
    ).toBe("/features/ai");
    expect(
      within(projectPackage)
        .getByRole("link", { name: /Recovery and operations/i })
        .getAttribute("href"),
    ).toBe("/features/compare");
    expect(
      within(projectPackage)
        .getByRole("link", { name: "Compare CoCalc" })
        .getAttribute("href"),
    ).toBe("/features/compare");
    expect(
      screen
        .getByRole("link", { name: /Jupyter Notebooks/i })
        .getAttribute("href"),
    ).toBe("/features/jupyter-notebook");
    expect(
      screen
        .getByRole("link", { name: /Engineering teams/i })
        .getAttribute("href"),
    ).toBe("/features/ai");
    expect(
      screen.getByRole("link", { name: /Research labs/i }).getAttribute("href"),
    ).toBe("/features/jupyter-notebook");
    expect(
      screen
        .getByRole("link", { name: /Technical courses/i })
        .getAttribute("href"),
    ).toBe("/features/teaching");
    expect(screen.getByText("Runtime path chooser")).not.toBeNull();
    expect(
      screen.getByText("Managed accounts, hosted projects, and team access"),
    ).not.toBeNull();
    expect(
      screen.getByText(
        "Enterprise private deployment planning with customer-operated infrastructure boundaries",
      ),
    ).not.toBeNull();
    expect(
      screen.getByText("Site licensing wraps the path you choose."),
    ).not.toBeNull();
    const boundaryRoutes = screen.getByRole("region", {
      name: "Homepage boundary and detail routes",
    });
    expect(
      within(boundaryRoutes).getByRole("heading", {
        name: "Keep the operating boundaries visible.",
      }),
    ).not.toBeNull();
    expect(
      within(boundaryRoutes)
        .getByRole("link", { name: /Trust policy/i })
        .getAttribute("href"),
    ).toBe("/policies/trust");
    expect(
      within(boundaryRoutes)
        .getByRole("link", { name: /CoCalc Plus details/i })
        .getAttribute("href"),
    ).toBe("/products/cocalc-plus");
    expect(
      within(boundaryRoutes)
        .getByRole("link", { name: /Support path/i })
        .getAttribute("href"),
    ).toBe("/support");
    expect(
      within(boundaryRoutes)
        .getByRole("link", { name: /Deployment comparison/i })
        .getAttribute("href"),
    ).toBe("/products");
    expect(
      within(boundaryRoutes)
        .getByRole("link", { name: /Hosted transition questions/i })
        .getAttribute("href"),
    ).toBe("/support");
    expect(screen.getByText(/direct self-service path/i)).not.toBeNull();
    expect(screen.getByText("Local runtime for one user.")).not.toBeNull();
    expect(
      screen
        .getByRole("link", { name: /CoCalc Launchpad Customer/i })
        .getAttribute("href"),
    ).toBe("/products/cocalc-launchpad");
    expect(screen.getByRole("link", { name: "All news" })).not.toBeNull();
    expect(
      screen.queryByRole("region", {
        name: "CoCalc.ai agent-ready project checklist",
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("region", {
        name: "Human and Codex handoff workflow",
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("region", {
        name: "CoCalc.ai agent turn evidence checklist",
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("region", {
        name: "Review trail for technical work",
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("region", {
        name: "Operational workspace signals for CoCalc.ai",
      }),
    ).toBeNull();
  });

  it("uses CoCalc marketing branding for the default hosted Launchpad preview", async () => {
    global.fetch = jest.fn(
      () => new Promise<Response>(() => undefined),
    ) as typeof fetch;
    render(
      <PublicHomeApp
        config={{
          cocalc_product: "launchpad",
          is_launchpad: true,
          site_name: "CoCalc Launchpad",
        }}
      />,
    );

    expect(document.title).toBe("CoCalc.ai");
    expect(
      within(screen.getByRole("banner")).getByRole("link", {
        name: "CoCalc home",
      }),
    ).not.toBeNull();
    expect(
      within(screen.getByRole("banner")).queryByRole("link", {
        name: "CoCalc Launchpad home",
      }),
    ).toBeNull();
  });

  it("shows direct app actions when authenticated", () => {
    global.fetch = jest.fn(
      () => new Promise<Response>(() => undefined),
    ) as typeof fetch;
    render(
      <PublicHomeApp
        config={{ is_authenticated: true, site_name: "Launchpad" }}
      />,
    );

    expect(
      screen.getAllByRole("link", { name: "Open projects" }).length,
    ).toBeGreaterThan(0);
    expect(
      within(screen.getByRole("group", { name: "Live CoCalc project preview" }))
        .getByRole("link", { name: "Open projects" })
        .getAttribute("href"),
    ).toBe("/projects");
    expect(
      within(
        screen.getByRole("region", {
          name: "CoCalc.ai starter project recipes",
        }),
      )
        .getByRole("link", { name: "Open projects" })
        .getAttribute("href"),
    ).toBe("/projects");
    expect(
      within(
        screen.getByRole("region", {
          name: "CoCalc.ai project handoff path",
        }),
      )
        .getByRole("link", { name: /Open hosted projects/i })
        .getAttribute("href"),
    ).toBe("/projects");
    expect(
      screen.getAllByRole("link", { name: "Support" }).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: "Create account" })).toBeNull();
  });
});
