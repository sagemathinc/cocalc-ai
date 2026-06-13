/** @jest-environment jsdom */

import { render, screen, waitFor, within } from "@testing-library/react";

import PublicHomeApp from "../app";

const originalFetch = global.fetch;
const BLOCKED_HOMEPAGE_CLAIM_PATTERNS = [
  /CoCalc Star/i,
  /Install CoCalc Star/i,
  /Review Star/i,
  /Run CoCalc Star/i,
  /Single-VM appliance/i,
  /Public VM/i,
  /Run by VM owner/i,
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
  /research-demo/i,
  /Live CoCalc project preview/i,
  /Live context/i,
  /without setting up/i,
  /Consistent lab setup/i,
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
        .getByRole("link", { name: "Compare deployment options" })
        .getAttribute("href"),
    ).toBe("/products");
    expect(
      within(hero).queryByRole("link", { name: "Install CoCalc Plus" }),
    ).toBeNull();
    expect(
      within(hero).queryByRole("link", { name: "Discuss site licensing" }),
    ).toBeNull();
    expect(
      within(hero).queryByRole("group", {
        name: "CoCalc.ai operating modes",
      }),
    ).toBeNull();
    const projectOutcomes = screen.getByRole("group", {
      name: "CoCalc.ai project outcomes",
    });
    expect(
      within(projectOutcomes).getByText("One place to work"),
    ).not.toBeNull();
    expect(within(projectOutcomes).getByText("Real compute")).not.toBeNull();
    expect(
      within(projectOutcomes).getByText("A lasting record"),
    ).not.toBeNull();
    const contextCues = within(hero).getByRole("group", {
      name: "CoCalc.ai workspace context cues",
    });
    expect(
      within(contextCues).getByText("Project context kept together"),
    ).not.toBeNull();
    expect(within(contextCues).getByText("Files")).not.toBeNull();
    expect(
      within(contextCues).getByText("Shells, packages, services"),
    ).not.toBeNull();
    expect(
      within(contextCues).getByText("Agent prompts and patches"),
    ).not.toBeNull();
    expect(within(contextCues).getByText("Review")).not.toBeNull();
    expect(
      within(hero).queryByRole("group", {
        name: "CoCalc project context preview",
      }),
    ).toBeNull();
    const workspacePreview = screen.getByRole("region", {
      name: "CoCalc.ai workspace preview",
    });
    expect(
      within(workspacePreview).getByRole("heading", {
        name: "The project is the unit of work.",
      }),
    ).not.toBeNull();
    const projectPreview = within(workspacePreview).getByRole("group", {
      name: "CoCalc project context preview",
    });
    expect(
      within(projectPreview).getByText("research-workspace"),
    ).not.toBeNull();
    expect(within(projectPreview).getByText("Codex thread")).not.toBeNull();
    expect(
      within(projectPreview).getByText("Project workspace"),
    ).not.toBeNull();
    expect(within(projectPreview).getByText("Project files")).not.toBeNull();
    expect(
      within(projectPreview).getByText("Shared project state"),
    ).not.toBeNull();
    const activeWork = within(projectPreview).getByRole("group", {
      name: "CoCalc.ai active project work",
    });
    expect(within(activeWork).getByText("Active project work")).not.toBeNull();
    expect(within(activeWork).getByText("Durable context")).not.toBeNull();
    expect(within(activeWork).getByText("Notebook run")).not.toBeNull();
    expect(within(activeWork).getByText("Shell session")).not.toBeNull();
    expect(within(activeWork).getByText("Codex turn")).not.toBeNull();
    expect(within(activeWork).getByText("Review trail")).not.toBeNull();
    expect(
      within(activeWork).getByText(
        "Output and notes remain next to the notebook.",
      ),
    ).not.toBeNull();
    expect(
      within(activeWork).getByText(
        "Package installs and service output stay with the project.",
      ),
    ).not.toBeNull();
    expect(
      within(activeWork).getByText(
        "Prompt, patch, and review notes stay attached.",
      ),
    ).not.toBeNull();
    expect(
      within(activeWork).getByText(
        "Snapshots and TimeTravel keep earlier states nearby.",
      ),
    ).not.toBeNull();
    expect(within(projectPreview).queryByText("Handoff queue")).toBeNull();
    expect(within(projectPreview).queryByText("Project record")).toBeNull();
    expect(
      within(projectPreview)
        .getByRole("link", { name: /Start a project/i })
        .getAttribute("href"),
    ).toBe("/auth/sign-up");
    const projectSurfaceLinks = within(projectPreview).getByRole("group", {
      name: "CoCalc.ai project surface links",
    });
    expect(
      within(projectSurfaceLinks)
        .getByRole("link", { name: "Open files" })
        .getAttribute("href"),
    ).toBe("/features/compare");
    expect(
      within(projectSurfaceLinks)
        .getByRole("link", { name: "Run terminal" })
        .getAttribute("href"),
    ).toBe("/features/terminal");
    expect(
      within(projectSurfaceLinks)
        .getByRole("link", { name: "Ask Codex" })
        .getAttribute("href"),
    ).toBe("/features/ai");
    expect(
      within(projectSurfaceLinks)
        .getByRole("link", { name: "Review history" })
        .getAttribute("href"),
    ).toBe("/features/compare");
    expect(
      within(projectSurfaceLinks).getByText("One context, multiple surfaces"),
    ).not.toBeNull();
    expect(
      within(projectSurfaceLinks).getByText("Source, notebooks, data"),
    ).not.toBeNull();
    expect(
      within(projectSurfaceLinks).getByText("Shells and services"),
    ).not.toBeNull();
    expect(
      within(projectSurfaceLinks).getByText("Agent work thread"),
    ).not.toBeNull();
    expect(
      within(projectSurfaceLinks).getByText("Snapshots and TimeTravel"),
    ).not.toBeNull();
    const removedDuplicateRegions = [
      "CoCalc.ai project handoff path",
      "CoCalc.ai intent router",
      "CoCalc.ai first workspace choice",
      "CoCalc.ai project intake checklist",
      "CoCalc.ai review handoff checklist",
      "CoCalc.ai workspace breadth",
      "CoCalc.ai project state map",
      "Common CoCalc.ai starting points",
      "CoCalc.ai starter project recipes",
      "CoCalc.ai workflow path routing",
      "CoCalc.ai first-step routes",
      "Homepage boundary and detail routes",
      "Why CoCalc keeps work in projects",
    ];
    for (const name of removedDuplicateRegions) {
      expect(screen.queryByRole("region", { name })).toBeNull();
    }
    expect(
      screen.queryByRole("group", {
        name: "CoCalc.ai artifact route shortcuts",
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("group", { name: "CoCalc.ai starting signal routes" }),
    ).toBeNull();
    expect(
      screen.queryByRole("group", { name: "CoCalc.ai handoff checklist" }),
    ).toBeNull();
    expect(
      screen.queryByRole("group", { name: "CoCalc.ai route handoff summary" }),
    ).toBeNull();
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
      within(coreWorkflows).queryByRole("link", { name: /LaTeX Editor/i }),
    ).toBeNull();
    expect(
      within(coreWorkflows).queryByRole("link", { name: /Whiteboard/i }),
    ).toBeNull();
    expect(
      screen.queryByRole("heading", {
        name: "Not another isolated notebook, IDE, or agent console.",
      }),
    ).toBeNull();
    expect(
      screen.getByRole("heading", {
        name: "Route by the work your group does.",
      }),
    ).not.toBeNull();
    expect(
      screen.getByRole("link", { name: /See AI workflows/i }),
    ).not.toBeNull();
    expect(
      screen.getByRole("link", { name: /Open notebooks/i }),
    ).not.toBeNull();
    expect(
      screen.getByRole("link", { name: /Explore teaching/i }),
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
    ).toEqual(["https://software.cocalc.ai/software/cocalc-plus/index.html"]);
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
    expect(container.querySelector('a[href*="cocalc-star"]')).toBeNull();
    expectHomepageSectionsLabeled(container);
    expect(
      screen
        .getAllByRole("link", { name: "Explore shared features" })[0]
        .getAttribute("href"),
    ).toBe("/features");
    const exploreAllFeaturesLinks = screen.getAllByRole("link", {
      name: "Explore all features",
    });
    expect(exploreAllFeaturesLinks.length).toBeGreaterThan(0);
    expect(
      exploreAllFeaturesLinks.every(
        (link) => link.getAttribute("href") === "/features",
      ),
    ).toBe(true);
    expect(screen.queryByText("Open page")).toBeNull();
    expect(screen.queryByText("Split tools")).toBeNull();
    expect(screen.queryByText("CoCalc project context")).toBeNull();
    expect(
      screen.queryByText(
        /The point is not that every workflow uses every tool/i,
      ),
    ).toBeNull();
    expect(
      within(coreWorkflows)
        .getByRole("link", { name: /Jupyter Notebooks/i })
        .getAttribute("href"),
    ).toBe("/features/jupyter-notebook");
    const audiencePaths = screen.getByRole("region", {
      name: "CoCalc.ai audience paths",
    });
    expect(
      within(audiencePaths)
        .getByRole("link", { name: /Engineering teams/i })
        .getAttribute("href"),
    ).toBe("/features/ai");
    expect(
      within(audiencePaths)
        .getByRole("link", { name: /Research labs/i })
        .getAttribute("href"),
    ).toBe("/features/jupyter-notebook");
    expect(
      within(audiencePaths)
        .getByRole("link", { name: /Technical courses/i })
        .getAttribute("href"),
    ).toBe("/features/teaching");
    const engineeringCues = within(audiencePaths).getByRole("group", {
      name: "Engineering teams project context cues",
    });
    expect(within(engineeringCues).getByText("Source")).not.toBeNull();
    expect(
      within(engineeringCues).getByText("Services and tests"),
    ).not.toBeNull();
    expect(
      within(engineeringCues).getByText("Patches and review"),
    ).not.toBeNull();
    const researchCues = within(audiencePaths).getByRole("group", {
      name: "Research labs project context cues",
    });
    expect(within(researchCues).getByText("Notebooks")).not.toBeNull();
    expect(within(researchCues).getByText("Data")).not.toBeNull();
    expect(within(researchCues).getByText("Snapshots")).not.toBeNull();
    const courseCues = within(audiencePaths).getByRole("group", {
      name: "Technical courses project context cues",
    });
    expect(within(courseCues).getByText("Coursework")).not.toBeNull();
    expect(within(courseCues).getByText("Student projects")).not.toBeNull();
    expect(within(courseCues).getByText("Notebook grading")).not.toBeNull();
    expect(screen.getByText("Operating path chooser")).not.toBeNull();
    expect(screen.getByText("Choose who runs the workspace")).not.toBeNull();
    const operatingBoundaryShortcuts = screen.getByRole("group", {
      name: "CoCalc.ai operating boundary shortcuts",
    });
    expect(
      within(operatingBoundaryShortcuts)
        .getByRole("link", { name: /Managed CoCalc\.ai/i })
        .getAttribute("href"),
    ).toBe("/");
    expect(
      within(operatingBoundaryShortcuts)
        .getByRole("link", { name: /One-user local/i })
        .getAttribute("href"),
    ).toBe("/products/cocalc-plus");
    expect(
      within(operatingBoundaryShortcuts)
        .getByRole("link", { name: /Customer-operated/i })
        .getAttribute("href"),
    ).toBe("/products");
    expect(
      within(operatingBoundaryShortcuts).getByText(
        "Compare Launchpad and Rocket for customer-operated paths.",
      ),
    ).not.toBeNull();
    const productOptions = screen.getByRole("region", {
      name: "CoCalc.ai product options",
    });
    expect(
      within(productOptions)
        .getByRole("link", { name: /CoCalc\.ai: Hosted service/i })
        .getAttribute("href"),
    ).toBe("/");
    expect(
      within(productOptions)
        .getByRole("link", { name: /CoCalc Plus: Local runtime/i })
        .getAttribute("href"),
    ).toBe("/products/cocalc-plus");
    expect(
      within(productOptions)
        .getByRole("link", {
          name: /CoCalc Launchpad: Private deployment/i,
        })
        .getAttribute("href"),
    ).toBe("/products/cocalc-launchpad");
    expect(
      within(productOptions)
        .getByRole("link", { name: /CoCalc Rocket: Private cloud/i })
        .getAttribute("href"),
    ).toBe("/products/cocalc-rocket");
    expect(screen.getByText("Deployment path")).not.toBeNull();
    expect(screen.getAllByText("Next step").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Operator").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Best fit").length).toBeGreaterThan(0);
    expect(screen.getByText("Run by CoCalc")).not.toBeNull();
    expect(screen.getByText("Run by you")).not.toBeNull();
    expect(screen.getByText("Run by your team")).not.toBeNull();
    expect(screen.getByText("Run with CoCalc")).not.toBeNull();
    for (const productCue of [
      "Managed service",
      "Hosted projects",
      "One-user local",
      "Browser workspace",
      "Private team",
      "Customer operated",
      "Infrastructure plan",
      "CoCalc guidance",
    ]) {
      expect(screen.getAllByText(productCue).length).toBeGreaterThan(0);
    }
    expect(
      screen.getByText("Managed accounts, hosted projects, and team access"),
    ).not.toBeNull();
    expect(
      screen.getByText(
        "Private cloud planning with customer-operated infrastructure boundaries",
      ),
    ).not.toBeNull();
    expect(screen.getByText("Start hosted")).not.toBeNull();
    expect(screen.getByText("Review Launchpad")).not.toBeNull();
    expect(
      screen.getByText("Site licensing wraps the path you choose."),
    ).not.toBeNull();
    expect(
      screen.getByRole("region", { name: "CoCalc.ai final calls to action" }),
    ).not.toBeNull();
    expect(screen.getByText("Start where your team is.")).not.toBeNull();
    expect(screen.getByText("Local runtime for one user.")).not.toBeNull();
    expect(
      screen.getByText("Compare customer-operated private deployment paths."),
    ).not.toBeNull();
    expect(
      screen.getByText("Discuss procurement, governance, and rollout."),
    ).not.toBeNull();
    expect(
      screen
        .getByRole("link", { name: /CoCalc Launchpad/i })
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
      within(
        screen.getByRole("group", { name: "CoCalc project context preview" }),
      )
        .getByRole("link", { name: "Open projects" })
        .getAttribute("href"),
    ).toBe("/projects");
    expect(
      screen.queryByRole("region", { name: "CoCalc.ai first-step routes" }),
    ).toBeNull();
    expect(
      screen.getAllByRole("link", { name: "Support" }).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: "Create account" })).toBeNull();
  });
});
