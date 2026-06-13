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
    const projectPreview = screen.getByRole("group", {
      name: "Live CoCalc project preview",
    });
    expect(within(projectPreview).getByText("research-demo")).not.toBeNull();
    expect(within(projectPreview).getByText("Codex thread")).not.toBeNull();
    expect(within(projectPreview).getByText("Live context")).not.toBeNull();
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
        name: "The hard parts are already in the workspace.",
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
    expect(
      screen
        .getByRole("link", { name: "Install CoCalc Star" })
        .getAttribute("href"),
    ).toBe("/products/cocalc-star");
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
      screen.getByText("Site licensing wraps the path you choose."),
    ).not.toBeNull();
    const proofPoints = screen.getByRole("region", {
      name: "Operational proof points for CoCalc.ai",
    });
    expect(within(proofPoints).getByText("Full Linux runtime")).not.toBeNull();
    expect(
      within(proofPoints).getByText("Project history nearby"),
    ).not.toBeNull();
    expect(
      within(proofPoints).getByText("People and agents share context"),
    ).not.toBeNull();
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
      screen.getAllByRole("link", { name: "Support" }).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: "Create account" })).toBeNull();
  });
});
