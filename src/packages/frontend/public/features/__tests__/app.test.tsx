/** @jest-environment jsdom */

import { render, screen, within } from "@testing-library/react";

import PublicFeaturesApp from "../app";
import { featurePath, getFeaturesRouteFromPath } from "../routes";

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      addEventListener: () => {},
      addListener: () => {},
      dispatchEvent: () => false,
      matches: false,
      media: query,
      onchange: null,
      removeEventListener: () => {},
      removeListener: () => {},
    }),
  });
});

describe("getFeaturesRouteFromPath", () => {
  it("supports the features index and detail routes", () => {
    expect(getFeaturesRouteFromPath(featurePath())).toEqual({ view: "index" });
    expect(getFeaturesRouteFromPath(featurePath("jupyter-notebook"))).toEqual({
      slug: "jupyter-notebook",
      view: "detail",
    });
  });
});

describe("PublicFeaturesApp", () => {
  it("renders the features index", () => {
    render(
      <PublicFeaturesApp
        config={{ site_name: "Launchpad" }}
        initialRoute={{ view: "index" }}
      />,
    );

    expect(
      screen.getByRole("heading", {
        name: "The CoCalc workspace model.",
      }),
    ).not.toBeNull();
    expect(
      screen.getByText(/^CoCalc features make the most sense/),
    ).not.toBeNull();
    expect(screen.queryByText(/Launchpad features make/)).toBeNull();
    expect(screen.getByText("Durable collaborative projects")).not.toBeNull();
    const startingPoints = screen.getByRole("region", {
      name: "CoCalc feature starting points",
    });
    expect(
      within(startingPoints).getByRole("heading", {
        name: "Choose the workflow you recognize.",
      }),
    ).not.toBeNull();
    expect(
      within(startingPoints)
        .getByRole("link", { name: /Terminals/i })
        .getAttribute("href"),
    ).toBe("/features/terminal");
    expect(
      within(startingPoints)
        .getByRole("link", { name: /AI agents/i })
        .getAttribute("href"),
    ).toBe("/features/ai");
    expect(
      within(startingPoints)
        .getByRole("link", { name: /Projects/i })
        .getAttribute("href"),
    ).toBe("/features/compare");
    expect(screen.getByText("Documents")).not.toBeNull();
    expect(screen.getByText("Compute")).not.toBeNull();
    expect(screen.getByText("AI and automation")).not.toBeNull();
    expect(screen.getAllByText("Jupyter Notebooks").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Linux Terminal").length).toBeGreaterThan(0);
    expect(screen.queryByText("Open page")).toBeNull();
    expect(
      screen
        .getByRole("link", { name: "Compare workspace model" })
        .getAttribute("href"),
    ).toBe("/features/compare");
    expect(
      screen
        .getByRole("link", { name: "Compare product paths" })
        .getAttribute("href"),
    ).toBe("/products");
    expect(
      screen
        .getByRole("link", { name: "Pricing and licensing" })
        .getAttribute("href"),
    ).toBe("/pricing");
    expect(
      screen
        .getAllByRole("link", { name: /Jupyter Notebooks/i })[0]
        .getAttribute("href"),
    ).toBe("/features/jupyter-notebook");
  });

  it("shows Projects and Settings in the shared nav when authenticated", () => {
    render(
      <PublicFeaturesApp
        config={{ is_authenticated: true, site_name: "Launchpad" }}
        initialRoute={{ view: "index" }}
      />,
    );

    expect(screen.getByRole("link", { name: "Projects" })).not.toBeNull();
    expect(screen.getByRole("link", { name: "Settings" })).not.toBeNull();
  });

  it("renders a detail page", () => {
    render(
      <PublicFeaturesApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ slug: "ai", view: "detail" }}
      />,
    );

    expect(
      screen.getByRole("heading", {
        name: "AI Agents in Project Chat",
        level: 1,
      }),
    ).not.toBeNull();
    expect(
      screen.getByText("Codex agent chat where the project already lives."),
    ).not.toBeNull();
    expect(screen.getByText("One AI path")).not.toBeNull();
    expect(screen.getByText("Create account")).not.toBeNull();
    const featureNav = screen.getByRole("region", {
      name: "Feature page navigation",
    });
    expect(within(featureNav).getByText("Feature detail")).not.toBeNull();
    expect(
      within(featureNav)
        .getByRole("link", { name: "All features" })
        .getAttribute("href"),
    ).toBe("/features");
    expect(
      within(featureNav)
        .getByRole("link", { name: "Next: Jupyter Notebooks" })
        .getAttribute("href"),
    ).toBe("/features/jupyter-notebook");
    expect(
      within(featureNav).queryByRole("link", { name: /Previous:/ }),
    ).toBeNull();
    expect(
      screen.getByText("Connect this feature to a product path."),
    ).not.toBeNull();
    expect(
      screen
        .getByRole("link", { name: "Compare product paths" })
        .getAttribute("href"),
    ).toBe("/products");
    expect(
      screen
        .getByRole("link", { name: "Pricing and licensing" })
        .getAttribute("href"),
    ).toBe("/pricing");
    expect(
      screen
        .getByRole("link", { name: "Compare workspace model" })
        .getAttribute("href"),
    ).toBe("/features/compare");
    expect(
      screen.getByRole("link", { name: "Feature map" }).getAttribute("href"),
    ).toBe("/features");
    expect(
      screen
        .getByRole("link", { name: "Next feature: Jupyter Notebooks" })
        .getAttribute("href"),
    ).toBe("/features/jupyter-notebook");
  });

  it("canonicalizes feature aliases before rendering detail navigation", () => {
    render(
      <PublicFeaturesApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ slug: "openai-chatgpt", view: "detail" }}
      />,
    );

    expect(
      screen.getByText("Codex agent chat where the project already lives."),
    ).not.toBeNull();
    const featureNav = screen.getByRole("region", {
      name: "Feature page navigation",
    });
    expect(
      within(featureNav)
        .getByRole("link", { name: "Next: Jupyter Notebooks" })
        .getAttribute("href"),
    ).toBe("/features/jupyter-notebook");
  });

  it("uses projects as the ai CTA for authenticated users", () => {
    render(
      <PublicFeaturesApp
        config={{
          help_email: "help@example.com",
          is_authenticated: true,
          site_name: "Launchpad",
        }}
        initialRoute={{ slug: "ai", view: "detail" }}
      />,
    );

    const projectLinks = screen.getAllByRole("link", { name: "Open projects" });
    expect(projectLinks.length).toBeGreaterThan(0);
    for (const link of projectLinks) {
      expect(link.getAttribute("href")).toBe("/projects");
    }
    expect(screen.queryByText("Create account")).toBeNull();
  });

  it("renders the richer jupyter feature page", () => {
    render(
      <PublicFeaturesApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ slug: "jupyter-notebook", view: "detail" }}
      />,
    );

    expect(screen.getByText("Durable execution")).not.toBeNull();
    expect(
      screen.getByText(
        "Let the agent work with the notebook you actually have open",
      ),
    ).not.toBeNull();
    expect(
      screen.getByText(
        "Put notebook cells on a whiteboard when the idea is a graph",
      ),
    ).not.toBeNull();
  });

  it("uses projects as the jupyter CTA for authenticated users", () => {
    render(
      <PublicFeaturesApp
        config={{
          help_email: "help@example.com",
          is_authenticated: true,
          site_name: "Launchpad",
        }}
        initialRoute={{ slug: "jupyter-notebook", view: "detail" }}
      />,
    );

    const projectLinks = screen.getAllByRole("link", { name: "Open projects" });
    expect(projectLinks.length).toBeGreaterThan(0);
    for (const link of projectLinks) {
      expect(link.getAttribute("href")).toBe("/projects");
    }
    expect(screen.queryByText("Start using Jupyter on CoCalc")).toBeNull();
  });

  it("renders the richer latex feature page", () => {
    render(
      <PublicFeaturesApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ slug: "latex-editor", view: "detail" }}
      />,
    );

    expect(
      screen.getByText(
        "Write the paper where the code, figures, and review live",
      ),
    ).not.toBeNull();
    expect(screen.getByText("When the paper becomes a project")).not.toBeNull();
    expect(
      screen.getByText(
        "Use Codex as an editor and build assistant, not an author",
      ),
    ).not.toBeNull();
  });

  it("uses projects as the latex CTA for authenticated users", () => {
    render(
      <PublicFeaturesApp
        config={{
          help_email: "help@example.com",
          is_authenticated: true,
          site_name: "Launchpad",
        }}
        initialRoute={{ slug: "latex-editor", view: "detail" }}
      />,
    );

    const projectLinks = screen.getAllByRole("link", { name: "Open projects" });
    expect(projectLinks.length).toBeGreaterThan(0);
    for (const link of projectLinks) {
      expect(link.getAttribute("href")).toBe("/projects");
    }
    expect(screen.queryByText("Start writing LaTeX on CoCalc")).toBeNull();
  });

  it("renders the richer teaching feature page", () => {
    const { container } = render(
      <PublicFeaturesApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ slug: "teaching", view: "detail" }}
      />,
    );

    expect(
      screen.getByText("Teach where students compute, write, and collaborate"),
    ).not.toBeNull();
    expect(screen.getByText("Technical course workspace")).not.toBeNull();
    expect(
      screen.getByText(/CoCalc complements the campus LMS/i),
    ).not.toBeNull();
    expect(
      screen.getByText(
        "Pair CoCalc with the systems your institution already uses",
      ),
    ).not.toBeNull();
    expect(screen.getByText("Assign, collect, grade, return")).not.toBeNull();
    expect(
      screen.getByText("Grade in the same workspace students used"),
    ).not.toBeNull();
    expect(screen.getByText("Reduce local setup friction")).not.toBeNull();
    expect(
      screen.getByText("Share a reusable course environment"),
    ).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "Environment guide" }),
    ).toHaveAttribute(
      "href",
      "https://sagemathinc.github.io/cocalc-guides/rootfs-management/",
    );
    expect(
      within(screen.getByText("Technical course workspace").closest("section")!)
        .getAllByRole("link", { name: /teaching guide|instructor manual/i })
        .map((link) => link.getAttribute("href")),
    ).toEqual([
      "https://sagemathinc.github.io/cocalc-guides/teaching/",
      "https://sagemathinc.github.io/cocalc-guides/teaching/",
    ]);
    const disallowedTeachingCopy = [
      "RootFS",
      "rootfs",
      "Live computational classroom",
      "teaching center",
      "first minute",
      "strongest",
      ["serious", "technical"].join(" "),
    ];
    expect(container.textContent ?? "").not.toMatch(
      new RegExp(disallowedTeachingCopy.join("|"), "i"),
    );
    expect(container.innerHTML).not.toContain("cocalc.com/testimonials");
    expect(
      screen.queryByText("Teach in the same environment where students work"),
    ).toBeNull();
  });

  it("uses projects as the teaching CTA for authenticated users", () => {
    render(
      <PublicFeaturesApp
        config={{
          help_email: "help@example.com",
          is_authenticated: true,
          site_name: "Launchpad",
        }}
        initialRoute={{ slug: "teaching", view: "detail" }}
      />,
    );

    const projectLinks = screen.getAllByRole("link", { name: "Open projects" });
    expect(projectLinks.length).toBeGreaterThan(0);
    for (const link of projectLinks) {
      expect(link.getAttribute("href")).toBe("/projects");
    }
    expect(screen.queryByText("Start teaching with CoCalc")).toBeNull();
  });

  it("renders the richer terminal feature page", () => {
    render(
      <PublicFeaturesApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ slug: "terminal", view: "detail" }}
      />,
    );

    expect(
      screen.getByText("A terminal is a live project document."),
    ).not.toBeNull();
    expect(
      screen.getAllByText("A .term file gives the shell an address").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByText("Collaborate in one terminal stream"),
    ).not.toBeNull();
  });

  it("uses projects as the terminal CTA for authenticated users", () => {
    render(
      <PublicFeaturesApp
        config={{
          help_email: "help@example.com",
          is_authenticated: true,
          site_name: "Launchpad",
        }}
        initialRoute={{ slug: "terminal", view: "detail" }}
      />,
    );

    const projectLinks = screen.getAllByRole("link", { name: "Open projects" });
    expect(projectLinks.length).toBeGreaterThan(0);
    for (const link of projectLinks) {
      expect(link.getAttribute("href")).toBe("/projects");
    }
    expect(screen.queryByText("Start using CoCalc terminals")).toBeNull();
  });

  it("renders the richer linux environment page", () => {
    render(
      <PublicFeaturesApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ slug: "linux", view: "detail" }}
      />,
    );

    expect(
      screen.getByText("A Linux workspace you can actually administer."),
    ).not.toBeNull();
    expect(
      screen.getByText("Learn and use Linux without risking your own machine"),
    ).not.toBeNull();
    expect(
      screen.getByText("RootFS images make setup reusable"),
    ).not.toBeNull();
  });

  it("uses projects as the linux CTA for authenticated users", () => {
    render(
      <PublicFeaturesApp
        config={{
          help_email: "help@example.com",
          is_authenticated: true,
          site_name: "Launchpad",
        }}
        initialRoute={{ slug: "linux", view: "detail" }}
      />,
    );

    const projectLinks = screen.getAllByRole("link", { name: "Open projects" });
    expect(projectLinks.length).toBeGreaterThan(0);
    for (const link of projectLinks) {
      expect(link.getAttribute("href")).toBe("/projects");
    }
    expect(screen.queryByText("Start using CoCalc Linux")).toBeNull();
  });

  it("renders the richer python feature page", () => {
    render(
      <PublicFeaturesApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ slug: "python", view: "detail" }}
      />,
    );

    expect(
      screen.getByText("Python that moves from notebook to script to paper."),
    ).not.toBeNull();
    expect(screen.getByText("From notebook to script to paper")).not.toBeNull();
    expect(screen.getByText("Real Python on real Linux")).not.toBeNull();
  });

  it("uses projects as the python CTA for authenticated users", () => {
    render(
      <PublicFeaturesApp
        config={{
          help_email: "help@example.com",
          is_authenticated: true,
          site_name: "Launchpad",
        }}
        initialRoute={{ slug: "python", view: "detail" }}
      />,
    );

    const projectLinks = screen.getAllByRole("link", { name: "Open projects" });
    expect(projectLinks.length).toBeGreaterThan(0);
    for (const link of projectLinks) {
      expect(link.getAttribute("href")).toBe("/projects");
    }
    expect(screen.queryByText("Start using Python on CoCalc")).toBeNull();
  });

  it("renders the richer whiteboard feature page", () => {
    render(
      <PublicFeaturesApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ slug: "whiteboard", view: "detail" }}
      />,
    );

    expect(
      screen.getByText(
        "A Miro-like whiteboard rebuilt for computational work.",
      ),
    ).not.toBeNull();
    expect(
      screen.getByText("Put Jupyter cells in a directed graph."),
    ).not.toBeNull();
    expect(screen.getByText("Transparent format")).not.toBeNull();
  });

  it.each([
    {
      slug: "sage",
      title: "Use SageMath where its history and future meet.",
      section: "Build, test, and develop Sage from source.",
    },
    {
      slug: "julia",
      title: "Use Julia in notebooks, terminals, Pluto, and source files.",
      section: "Julia works best in CoCalc when the project matters.",
    },
    {
      slug: "r-statistical-software",
      title: "Use R when statistics is part of a larger workflow.",
      section: "CoCalc is not trying to be RStudio.",
    },
    {
      slug: "octave",
      title: "Run Octave in notebooks, scripts, and terminals.",
      section: "A browser-based path for MATLAB-style teaching and scripts.",
    },
    {
      slug: "slides",
      title: "Present from the same canvas where technical ideas are built.",
      section: "Slides are structured whiteboards.",
    },
  ])(
    "renders the richer $slug feature page",
    ({
      section,
      slug,
      title,
    }: {
      section: string;
      slug: string;
      title: string;
    }) => {
      render(
        <PublicFeaturesApp
          config={{ help_email: "help@example.com", site_name: "Launchpad" }}
          initialRoute={{ slug, view: "detail" }}
        />,
      );

      expect(screen.getByText(title)).not.toBeNull();
      expect(screen.getByText(section)).not.toBeNull();
    },
  );

  it.each([
    { finalCta: "Start using SageMath on CoCalc", slug: "sage" },
    { finalCta: "Start using CoCalc whiteboards", slug: "whiteboard" },
    { finalCta: "Start making slides", slug: "slides" },
    { finalCta: "Start using R", slug: "r-statistical-software" },
    { finalCta: "Start using Octave", slug: "octave" },
    { finalCta: "Start using Julia", slug: "julia" },
  ])(
    "uses projects as the $slug CTA for authenticated users",
    ({ finalCta, slug }) => {
      render(
        <PublicFeaturesApp
          config={{
            help_email: "help@example.com",
            is_authenticated: true,
            site_name: "Launchpad",
          }}
          initialRoute={{ slug, view: "detail" }}
        />,
      );

      const projectLinks = screen.getAllByRole("link", {
        name: "Open projects",
      });
      expect(projectLinks.length).toBeGreaterThan(0);
      for (const link of projectLinks) {
        expect(link.getAttribute("href")).toBe("/projects");
      }
      expect(screen.queryByText(finalCta)).toBeNull();
    },
  );

  it("renders the compare feature page", () => {
    render(
      <PublicFeaturesApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ slug: "compare", view: "detail" }}
      />,
    );

    expect(
      screen.getByText("Compare CoCalc by workspace model"),
    ).not.toBeNull();
    expect(screen.getByText("How CoCalc compares by category")).not.toBeNull();
    expect(
      screen.getByText("Google Colab and quick notebook hosts"),
    ).not.toBeNull();
    expect(
      screen.getByText("AI-native work changes the comparison"),
    ).not.toBeNull();
    expect(
      screen.getByText("Connect this feature to a product path."),
    ).not.toBeNull();
    expect(
      screen
        .getByRole("link", { name: "Compare product paths" })
        .getAttribute("href"),
    ).toBe("/products");
    expect(
      screen.queryByRole("link", { name: "Compare workspace model" }),
    ).toBeNull();
  });
});
