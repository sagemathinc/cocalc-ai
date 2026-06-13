/** @jest-environment jsdom */

import { render, screen, waitFor, within } from "@testing-library/react";

import PublicHomeApp from "../app";

const originalFetch = global.fetch;

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
    render(
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
    const agentReady = screen.getByRole("region", {
      name: "CoCalc.ai agent-ready project checklist",
    });
    expect(
      within(agentReady).getByRole("heading", {
        name: "Give Codex the evidence, not just the prompt.",
      }),
    ).not.toBeNull();
    expect(within(agentReady).getByText("Source context")).not.toBeNull();
    expect(within(agentReady).getByText("Execution evidence")).not.toBeNull();
    expect(within(agentReady).getByText("Agent trail")).not.toBeNull();
    expect(within(agentReady).getByText("Rollback points")).not.toBeNull();
    expect(
      within(agentReady)
        .getByRole("link", { name: "Codex in CoCalc" })
        .getAttribute("href"),
    ).toBe("/features/ai");
    expect(
      within(agentReady)
        .getByRole("link", { name: "Review workflow" })
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
        name: "See the work loop inside a project.",
      }),
    ).not.toBeNull();
    const agentHandoff = screen.getByRole("region", {
      name: "Human and Codex handoff workflow",
    });
    expect(
      within(agentHandoff).getByRole("heading", {
        name: "Handoff from human work to agent work.",
      }),
    ).not.toBeNull();
    expect(
      within(agentHandoff)
        .getByRole("link", { name: "See Codex workflows" })
        .getAttribute("href"),
    ).toBe("/features/ai");
    expect(
      within(agentHandoff)
        .getByRole("link", { name: "Compare workflow" })
        .getAttribute("href"),
    ).toBe("/features/compare");
    expect(within(agentHandoff).getByText("Notebook state")).not.toBeNull();
    expect(within(agentHandoff).getByText("Review notes")).not.toBeNull();
    const agentEvidence = screen.getByRole("region", {
      name: "CoCalc.ai agent turn evidence checklist",
    });
    expect(
      within(agentEvidence).getByRole("heading", {
        name: "Give Codex the artifacts a reviewer would ask for.",
      }),
    ).not.toBeNull();
    expect(
      within(agentEvidence)
        .getByRole("link", { name: "Open Codex workflows" })
        .getAttribute("href"),
    ).toBe("/features/ai");
    expect(
      within(agentEvidence)
        .getByRole("link", { name: "Terminal workflow" })
        .getAttribute("href"),
    ).toBe("/features/terminal");
    expect(
      within(agentEvidence)
        .getByRole("link", { name: /Project files/i })
        .getAttribute("href"),
    ).toBe("/features/compare");
    expect(
      within(agentEvidence)
        .getByRole("link", { name: /Execution record/i })
        .getAttribute("href"),
    ).toBe("/features/terminal");
    expect(
      within(agentEvidence)
        .getByRole("link", { name: /Notebook evidence/i })
        .getAttribute("href"),
    ).toBe("/features/jupyter-notebook");
    expect(
      within(agentEvidence)
        .getByRole("link", { name: /Codex review/i })
        .getAttribute("href"),
    ).toBe("/features/ai");
    const reviewTrail = screen.getByRole("region", {
      name: "Review trail for technical work",
    });
    expect(
      within(reviewTrail).getByRole("heading", {
        name: "Make technical work inspectable before it moves on.",
      }),
    ).not.toBeNull();
    expect(within(reviewTrail).getByText("Terminal output")).not.toBeNull();
    expect(within(reviewTrail).getByText("Agent changes")).not.toBeNull();
    expect(within(reviewTrail).getByText("Recovery points")).not.toBeNull();
    expect(
      within(reviewTrail)
        .getByRole("link", { name: "Review collaboration" })
        .getAttribute("href"),
    ).toBe("/features/compare");
    expect(
      within(reviewTrail)
        .getByRole("link", { name: "Agent workflow" })
        .getAttribute("href"),
    ).toBe("/features/ai");
    expect(
      screen.getByRole("heading", {
        name: "From first file to reviewed result.",
      }),
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", {
        name: "Built for technical groups.",
      }),
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", {
        name: "Keep the operating pieces in one workspace.",
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
    expect(screen.queryByText("CoCalc Star")).toBeNull();
    expect(screen.queryByText("Install CoCalc Star")).toBeNull();
    expect(
      screen
        .getByRole("link", { name: "Explore shared features" })
        .getAttribute("href"),
    ).toBe("/features");
    expect(
      screen
        .getByRole("link", { name: "Browse feature map" })
        .getAttribute("href"),
    ).toBe("/features");
    expect(
      screen
        .getByRole("link", { name: "See AI workflows" })
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
    expect(screen.queryByText(/self-service team starts/i)).toBeNull();
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
    expect(screen.queryByText(/fast team starts/i)).toBeNull();
    expect(screen.queryByText(/quickest start/i)).toBeNull();
    expect(screen.queryByText(/multi-bay deployments/i)).toBeNull();
    expect(screen.queryByText("Pricing and licensing")).toBeNull();
    expect(screen.getByText("Local runtime for one user.")).not.toBeNull();
    expect(screen.queryByText(/Free local runtime/i)).toBeNull();
    const signalPoints = screen.getByRole("region", {
      name: "Operational workspace signals for CoCalc.ai",
    });
    expect(within(signalPoints).getByText("Full Linux runtime")).not.toBeNull();
    expect(
      within(signalPoints).getByText("Project history nearby"),
    ).not.toBeNull();
    expect(
      within(signalPoints).getByText("People and agents share context"),
    ).not.toBeNull();
    expect(screen.queryByText("Operational proof")).toBeNull();
    expect(
      screen
        .getByRole("link", { name: /CoCalc Launchpad Customer/i })
        .getAttribute("href"),
    ).toBe("/products/cocalc-launchpad");
    expect(screen.getByRole("link", { name: "All news" })).not.toBeNull();
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
