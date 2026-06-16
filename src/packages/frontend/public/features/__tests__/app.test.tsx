/** @jest-environment jsdom */

import { fireEvent, render, screen, within } from "@testing-library/react";

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

function textLength(element: Element): number {
  return (element.textContent ?? "").replace(/\s+/g, " ").trim().length;
}

function getDirectChildren(element: HTMLElement): HTMLElement[] {
  return Array.from(element.children) as HTMLElement[];
}

function headingLabels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("h2, h3, h4"))
    .map((heading) => (heading.textContent ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

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
  const contextualSupportLinks = [
    {
      context: "feature-ai",
      label: "Ask about AI workflows",
      slug: "ai",
    },
    {
      context: "feature-jupyter-notebook",
      label: "Ask about Jupyter workflows",
      slug: "jupyter-notebook",
    },
    {
      context: "feature-teaching",
      label: "Ask about teaching workflows",
      slug: "teaching",
    },
    {
      context: "feature-terminal",
      label: "Ask about terminal workflows",
      slug: "terminal",
    },
    {
      context: "feature-linux",
      label: "Ask about Linux environments",
      slug: "linux",
    },
    {
      context: "feature-api",
      label: "Ask about API integration",
      slug: "api",
    },
    {
      context: "feature-whiteboard",
      label: "Ask about whiteboards",
      slug: "whiteboard",
    },
    {
      context: "feature-latex-editor",
      label: "Ask about LaTeX workflows",
      slug: "latex-editor",
    },
    {
      context: "feature-slides",
      label: "Ask about slides",
      slug: "slides",
    },
  ] as const;

  const auditedFeaturePages = [
    {
      marker: "Codex where the work happens.",
      slug: "ai",
    },
    {
      marker: "Jupyter notebooks for work that needs to keep going",
      slug: "jupyter-notebook",
    },
    {
      marker: "Python that moves from notebook to script to paper.",
      slug: "python",
    },
    {
      marker: "Use SageMath where its history and future meet.",
      slug: "sage",
    },
    {
      marker: "Use R when statistics is part of a larger workflow.",
      slug: "r-statistical-software",
    },
    {
      marker: "Use Julia in notebooks, terminals, Pluto, and source files.",
      slug: "julia",
    },
    {
      marker: "A Linux workspace you can actually administer.",
      slug: "linux",
    },
    {
      marker: "A terminal is a live project document.",
      slug: "terminal",
    },
    {
      marker: "Teach where students compute, write, and collaborate",
      slug: "teaching",
    },
    {
      marker: "Write the paper where the code, figures, and review live",
      slug: "latex-editor",
    },
    {
      marker: "A technical whiteboard for math, code, and collaboration.",
      slug: "whiteboard",
    },
    {
      marker: "Present from the same canvas where technical ideas are built.",
      slug: "slides",
    },
    {
      marker: "Automate and integrate CoCalc from your own systems",
      slug: "api",
    },
    {
      marker: "Run Octave in notebooks, scripts, and terminals.",
      slug: "octave",
    },
  ] as const;

  it("renders the features index", () => {
    render(
      <PublicFeaturesApp
        config={{ site_name: "Launchpad" }}
        initialRoute={{ view: "index" }}
      />,
    );

    expect(
      screen.getByRole("heading", {
        name: "Choose the workflow your team needs",
      }),
    ).not.toBeNull();
    expect(screen.getByText(/^Use this index to find/)).not.toBeNull();
    expect(screen.queryByText(/Launchpad features make/)).toBeNull();
    const startingPoints = screen.getByRole("region", {
      name: "CoCalc feature starting points",
    });
    expect(
      within(startingPoints).getByText(
        "Pick the page that matches the question in front of you.",
      ),
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
        .getByRole("link", { name: /Courses/i })
        .getAttribute("href"),
    ).toBe("/features/teaching");
    expect(
      within(startingPoints).queryByRole("link", { name: /Compare CoCalc/i }),
    ).toBeNull();
    expect(screen.queryByText("Feature map")).toBeNull();
    expect(
      screen.queryByAltText(/CoCalc feature map/i),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Documents")).not.toBeNull();
    expect(screen.getByText("Compute")).not.toBeNull();
    expect(screen.getByText("AI and automation")).not.toBeNull();
    expect(screen.getAllByText("Jupyter Notebooks").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Linux Terminal").length).toBeGreaterThan(0);
    expect(screen.queryByText("Open page")).toBeNull();
    expect(screen.queryByRole("link", { name: /Compare CoCalc/i })).toBeNull();
    expect(
      screen.getByRole("link", { name: /CoCalc CLI/i }).getAttribute("href"),
    ).toBe("/docs/cli/use-cocalc-cli");
    expect(
      screen.queryByRole("link", { name: "Compare product paths" }),
    ).toBeNull();
    expect(
      screen.queryByRole("link", { name: "Pricing and licensing" }),
    ).toBeNull();
    expect(
      screen
        .getAllByRole("link", { name: /Jupyter Notebooks/i })[0]
        .getAttribute("href"),
    ).toBe("/features/jupyter-notebook");
  });

  it("keeps the feature index visually calm and route-specific", () => {
    const { container } = render(
      <PublicFeaturesApp
        config={{ site_name: "Launchpad" }}
        initialRoute={{ view: "index" }}
      />,
    );

    expect(
      container.querySelector(".cocalc-feature-index-hero"),
    ).not.toBeNull();
    expect(
      container.querySelectorAll(".cocalc-feature-starter-card"),
    ).toHaveLength(4);
    expect(
      container.querySelectorAll(".cocalc-feature-group-label"),
    ).toHaveLength(4);
    expect(container.querySelectorAll(".cocalc-feature-link-card").length).toBe(
      15,
    );
    expect(
      container.querySelectorAll(".cocalc-feature-link-card .ant-tag"),
    ).toHaveLength(0);
    expect(
      container.querySelectorAll(".cocalc-feature-link-card .fa-arrow-right")
        .length,
    ).toBe(0);
    expect(
      container.querySelectorAll(
        ".cocalc-feature-card-icon-row .ant-typography",
      ),
    ).toHaveLength(0);
    expect(container.textContent ?? "").not.toMatch(
      /Feature map|Compare workspace model|FilesRuntimeHistoryPeopleAgents|The CoCalc workspace model|The shared unit of work|Durable collaborative projects|Full feature index/i,
    );

    for (const card of container.querySelectorAll(
      ".cocalc-feature-link-card",
    )) {
      expect(textLength(card)).toBeLessThanOrEqual(260);
    }
    for (const groupLabel of container.querySelectorAll(
      ".cocalc-feature-group-label",
    )) {
      expect(groupLabel.closest("a")).toBeNull();
      expect(groupLabel.getAttribute("style") ?? "").not.toContain(
        "box-shadow",
      );
    }
    expect(screen.getByText("Documents").closest("a")).toBeNull();
    const css = Array.from(container.querySelectorAll("style"))
      .map((style) => style.textContent ?? "")
      .join("\n");
    expect(css).toContain(".cocalc-feature-link-card:hover");
    expect(css).toContain(".cocalc-feature-starter-card:hover");
    expect(css).toContain("cursor: pointer");
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
        name: "AI Agents",
        level: 1,
      }),
    ).not.toBeNull();
    expect(screen.getByText("Codex where the work happens.")).not.toBeNull();
    expect(screen.getByText("Codex in chat")).not.toBeNull();
    expect(screen.getByText("Create account")).not.toBeNull();
    const featureNav = screen.getByRole("region", {
      name: "Feature page navigation",
    });
    expect(
      within(featureNav)
        .getByRole("link", { name: "Features" })
        .getAttribute("href"),
    ).toBe("/features");
    expect(within(featureNav).getByText("AI Agents")).not.toBeNull();
    expect(within(featureNav).queryByText("Feature detail")).toBeNull();
    expect(
      within(featureNav).queryByRole("link", { name: /Next:/ }),
    ).toBeNull();
    expect(
      within(featureNav).queryByRole("link", { name: /Previous:/ }),
    ).toBeNull();
    expect(screen.getByText("Decide how CoCalc should run")).not.toBeNull();
    expect(
      screen
        .getByRole("link", { name: "Compare operating models" })
        .getAttribute("href"),
    ).toBe("/products");
    expect(
      screen
        .getByRole("link", { name: "Pricing and licensing" })
        .getAttribute("href"),
    ).toBe("/pricing");
    expect(
      screen
        .getByRole("link", { name: "Compare CoCalc fit" })
        .getAttribute("href"),
    ).toBe("/features/compare");
    expect(
      screen
        .getAllByRole("link", { name: "Browse feature workflows" })
        .map((link) => link.getAttribute("href")),
    ).toEqual(["/features"]);
    expect(screen.queryByRole("link", { name: /Next feature:/ })).toBeNull();
    expect(
      screen.queryByRole("link", { name: /Previous feature:/ }),
    ).toBeNull();
  });

  it("canonicalizes feature aliases before rendering detail navigation", () => {
    render(
      <PublicFeaturesApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ slug: "openai-chatgpt", view: "detail" }}
      />,
    );

    expect(screen.getByText("Codex where the work happens.")).not.toBeNull();
    const featureNav = screen.getByRole("region", {
      name: "Feature page navigation",
    });
    expect(
      within(featureNav)
        .getByRole("link", { name: "Features" })
        .getAttribute("href"),
    ).toBe("/features");
    expect(within(featureNav).getByText("AI Agents")).not.toBeNull();
    expect(
      within(featureNav).queryByRole("link", { name: /Next:/ }),
    ).toBeNull();
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
    const { container } = render(
      <PublicFeaturesApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ slug: "jupyter-notebook", view: "detail" }}
      />,
    );

    expect(
      screen.getByText("Jupyter notebooks for work that needs to keep going"),
    ).not.toBeNull();
    expect(screen.getByText("Keep runs alive")).not.toBeNull();
    expect(screen.getByText("Work together live")).not.toBeNull();
    expect(screen.getByText("Review and recover changes")).not.toBeNull();
    expect(
      screen.getByText("When the notebook depends on more than cells"),
    ).not.toBeNull();
    expect(screen.getByText("Where to go from here")).not.toBeNull();
    expect(screen.getByText("Bring Codex into a live notebook")).not.toBeNull();
    expect(
      screen.getByText("Turn notebook work into a visual flow"),
    ).not.toBeNull();
    expect(screen.getByText("Teach with notebook assignments")).not.toBeNull();
    expect(screen.getByText("Check Jupyter compatibility")).not.toBeNull();
    expect(
      screen.queryByRole("link", { name: "Compare notebook tools" }),
    ).toBeNull();
    expect(screen.queryByText("Durable execution")).toBeNull();
    expect(screen.queryByText("Agent-ready")).toBeNull();
    expect(screen.queryByText("When notebooks become shared work")).toBeNull();
    expect(
      screen.queryByText("Ready to try a notebook workflow in CoCalc?"),
    ).toBeNull();
    expect(screen.queryByText("Start using Jupyter on CoCalc")).toBeNull();
    expect(
      screen.queryByText(
        "Let the agent work with the notebook you actually have open",
      ),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "See agent details" }));
    expect(
      screen.getByRole("dialog", {
        name: "How Codex works with live notebooks",
      }),
    ).not.toBeNull();
    expect(container.querySelectorAll(".ant-tag")).toHaveLength(0);
    expect(container.textContent ?? "").not.toMatch(
      /stale files|Positioning guide|Choose the next workflow when the notebook grows/i,
    );
    expect(new Set(headingLabels(container)).size).toBe(
      headingLabels(container).length,
    );
    expect(
      screen
        .getByRole("link", { name: "Jupyter compatibility guide" })
        .getAttribute("href"),
    ).toBe("https://sagemathinc.github.io/cocalc-guides/cocalc-for-jupyter/");
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
    expect(screen.getByText("Keep the working tree together")).not.toBeNull();
    expect(screen.getByText("Recover draft history")).not.toBeNull();
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
      screen.getByText(/CoCalc works beside the campus LMS/i),
    ).not.toBeNull();
    expect(
      screen.getByText(
        "Keep administration in the LMS. Run coursework in CoCalc.",
      ),
    ).not.toBeNull();
    expect(screen.getByText("Keep in your LMS")).not.toBeNull();
    expect(
      screen.getByText("Use CoCalc for technical coursework"),
    ).not.toBeNull();
    expect(screen.getByText("Use a notebook hub when")).not.toBeNull();
    expect(
      screen.queryByText(
        "Pair CoCalc with the systems your institution already uses",
      ),
    ).toBeNull();
    expect(screen.getByText("Give each student a project")).not.toBeNull();
    expect(screen.getByText("Hand out and collect work")).not.toBeNull();
    expect(screen.getByText("Keep the environment consistent")).not.toBeNull();
    expect(
      screen.getByText("Run the assignment loop in student projects"),
    ).not.toBeNull();
    expect(
      screen.getByText("Reduce setup and support friction"),
    ).not.toBeNull();
    expect(
      screen.getByText("Choose the teaching path that fits"),
    ).not.toBeNull();
    expect(screen.queryByText("Assign, collect, grade, return")).toBeNull();
    expect(
      screen.queryByText("Grade in the same workspace students used"),
    ).toBeNull();
    expect(
      screen.queryByText("Notebook teaching works with nbgrader"),
    ).toBeNull();
    expect(screen.queryByText("Reduce local setup friction")).toBeNull();
    expect(
      screen.queryByText("Share a reusable course environment"),
    ).toBeNull();
    expect(container.querySelectorAll(".ant-tag")).toHaveLength(0);
    expect(
      screen.getByRole("link", { name: "Environment guide" }),
    ).toHaveAttribute(
      "href",
      "https://sagemathinc.github.io/cocalc-guides/rootfs-management/",
    );
    expect(
      within(screen.getByText("Technical course workspace").closest("section")!)
        .getAllByRole("link", { name: /teaching guide/i })
        .map((link) => link.getAttribute("href")),
    ).toEqual(["https://sagemathinc.github.io/cocalc-guides/teaching/"]);
    expect(
      within(screen.getByText("Technical course workspace").closest("section")!)
        .getByRole("link", { name: "Compare product paths" })
        .getAttribute("href"),
    ).toBe("/products");
    const disallowedTeachingCopy = [
      "RootFS",
      "rootfs",
      "Live computational classroom",
      "teaching center",
      "first minute",
      "strongest",
      "institutional shell",
      ["serious", "technical"].join(" "),
    ];
    expect(container.textContent ?? "").not.toMatch(
      new RegExp(disallowedTeachingCopy.join("|"), "i"),
    );
    expect(container.innerHTML).not.toContain("cocalc.com/testimonials");
    expect(
      screen.queryByText("Teach in the same environment where students work"),
    ).toBeNull();
    expect(new Set(headingLabels(container)).size).toBe(
      headingLabels(container).length,
    );
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
    expect(screen.queryByText("Use hosted CoCalc.ai")).toBeNull();
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
      screen.getByText("Build course and team environments once"),
    ).not.toBeNull();
    expect(screen.queryByText("RootFS images make setup reusable")).toBeNull();
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
        "A technical whiteboard for math, code, and collaboration.",
      ),
    ).not.toBeNull();
    expect(
      screen.getByText("Put Jupyter cells in a directed graph."),
    ).not.toBeNull();
    expect(screen.getByText("Explain with editable text")).not.toBeNull();
    expect(
      screen.getByText("Run cells when the diagram needs code"),
    ).not.toBeNull();
    expect(screen.queryByText("Transparent format")).toBeNull();
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

  it.each(auditedFeaturePages)(
    "keeps the audited $slug feature page route-specific and free of decorative tags",
    ({ marker, slug }) => {
      const { container } = render(
        <PublicFeaturesApp
          config={{ help_email: "help@example.com", site_name: "Launchpad" }}
          initialRoute={{ slug, view: "detail" }}
        />,
      );

      expect(screen.getByText(marker)).not.toBeNull();
      expect(container.querySelectorAll(".ant-tag")).toHaveLength(0);
      expect(container.textContent ?? "").not.toMatch(
        /Feature map|Workflow map|Positioning|Real collaborative Python|Collaborative Linux terminal|Real project Linux|LaTeX inside a technical project|Where CoCalc fits|Technical presentations|Collaborative technical canvas|serious technical work|serious Linux|strongest|workspace model|internal planning|multi-bay|control plane|\bstale\b|CoCalc-AI|locked-down|launchpad-style|internal platform|narrow patch|install narrowly|narrower tool/i,
      );

      const headings = Array.from(
        container.querySelectorAll("main h2, main h3, main h4"),
      )
        .map((heading) => heading.textContent?.replace(/\s+/g, " ").trim())
        .filter((heading): heading is string => !!heading);
      expect(new Set(headings).size).toBe(headings.length);

      for (const paragraph of container.querySelectorAll("main p")) {
        expect(textLength(paragraph)).toBeLessThanOrEqual(390);
      }

      const nextSteps = screen.getByRole("region", {
        name: "Feature operating model next steps",
      });
      expect(
        within(nextSteps)
          .getByRole("link", { name: "Compare operating models" })
          .getAttribute("href"),
      ).toBe("/products");
      expect(
        within(nextSteps)
          .getByRole("link", { name: "Pricing and licensing" })
          .getAttribute("href"),
      ).toBe("/pricing");
      expect(
        within(nextSteps)
          .getByRole("link", { name: "Browse feature workflows" })
          .getAttribute("href"),
      ).toBe("/features");
      expect(
        within(nextSteps).queryByRole("link", { name: /Next feature:/ }),
      ).toBeNull();
      expect(
        within(nextSteps).queryByRole("link", { name: /Previous feature:/ }),
      ).toBeNull();
    },
  );

  it.each(contextualSupportLinks)(
    "keeps $slug support CTA contextual and route-specific",
    ({ context, label, slug }) => {
      render(
        <PublicFeaturesApp
          config={{ help_email: "help@example.com", site_name: "Launchpad" }}
          initialRoute={{ slug, view: "detail" }}
        />,
      );

      if (slug === "jupyter-notebook") {
        fireEvent.click(
          screen.getByRole("button", { name: "See agent details" }),
        );
      }

      const hrefs = screen
        .getAllByRole("link", { name: label })
        .map((link) => link.getAttribute("href"));
      expect(hrefs.length).toBeGreaterThan(0);
      for (const href of hrefs) {
        expect(href).toContain("/support/new?");
        expect(href).toContain(`context=${context}`);
        expect(href).not.toContain("mailto:");
      }
    },
  );

  it("keeps the remaining audited feature pages from drifting back to metadata headings", () => {
    const routes = [
      "ai",
      "terminal",
      "linux",
      "whiteboard",
      "latex-editor",
      "slides",
    ] as const;
    const disallowedHeadings = [
      "Rich prompts",
      "Collaborative by default",
      "Actually collaborative",
      "Agent-aware",
      "Use sudo",
      "Share the environment",
      "Recover and reuse",
      "Markdown native",
      "Math first",
      "Executable cells",
      "Realtime by default",
      "Transparent format",
      "Source and PDF",
      "Coauthor live",
      "Codex nearby",
      "The terminal gives Codex a concrete loop",
      "RootFS images make setup reusable",
      "Choose CoCalc when the paper is part of a larger computation",
    ];

    for (const slug of routes) {
      const { unmount } = render(
        <PublicFeaturesApp
          config={{ help_email: "help@example.com", site_name: "Launchpad" }}
          initialRoute={{ slug, view: "detail" }}
        />,
      );

      for (const name of disallowedHeadings) {
        expect(screen.queryByRole("heading", { name })).toBeNull();
      }
      unmount();
    }
  });

  it("keeps the HTTP API page distinct from the CoCalc CLI", () => {
    render(
      <PublicFeaturesApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ slug: "api", view: "detail" }}
      />,
    );

    expect(
      screen.getByText(/This is the integration API, not the CoCalc CLI/i),
    ).not.toBeNull();
    expect(
      screen
        .getByRole("link", { name: "API documentation" })
        .getAttribute("href"),
    ).toBe("/docs/api/http-api");
    expect(
      screen
        .getAllByRole("link", { name: "Ask about API integration" })
        .map((link) => link.getAttribute("href")),
    ).toEqual([expect.stringContaining("/support/new?")]);
  });

  it("renders the compare feature page", () => {
    const { container } = render(
      <PublicFeaturesApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ slug: "compare", view: "detail" }}
      />,
    );

    expect(
      screen.getByRole("heading", {
        name: "When is CoCalc the right fit?",
      }),
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", {
        name: "The practical split.",
      }),
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", {
        name: "CoCalc fits when...",
      }),
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", {
        name: "A focused tool fits when...",
      }),
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", { name: "Decision checklist." }),
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", { name: "Where to go next." }),
    ).not.toBeNull();
    expect(
      screen.getByText(/Best fit: work that needs review/i),
    ).not.toBeNull();
    expect(
      screen
        .getAllByRole("link", { name: "Compare operating models" })
        .map((link) => link.getAttribute("href")),
    ).toEqual(["/products", "/products"]);
    expect(
      screen
        .getAllByRole("link", { name: "Pricing and licensing" })
        .map((link) => link.getAttribute("href")),
    ).toEqual(["/pricing"]);
    expect(
      screen
        .getByRole("link", { name: "Review pricing options" })
        .getAttribute("href"),
    ).toBe("/pricing");
    expect(
      screen.getByRole("link", { name: "AI workflows" }).getAttribute("href"),
    ).toBe("/features/ai");
    expect(
      screen
        .getByRole("link", { name: "Teaching workflows" })
        .getAttribute("href"),
    ).toBe("/features/teaching");
    expect(
      screen
        .getByRole("link", { name: "Talk with CoCalc" })
        .getAttribute("href"),
    ).toBe("mailto:help@example.com");
    expect(screen.queryByRole("link", { name: "Create account" })).toBeNull();
    expect(
      screen.queryByRole("region", {
        name: "Feature operating model next steps",
      }),
    ).toBeNull();
    expect(screen.queryByText("Decide how CoCalc should run")).toBeNull();
    expect(
      screen.queryByRole("link", { name: "Compare workspace model" }),
    ).toBeNull();
    expect(container.querySelector("table")).toBeNull();
    expect(container.textContent ?? "").not.toMatch(
      /These comparisons are intentionally high level|How CoCalc compares by category|Google Colab|Deepnote|narrower point solution|product ladder|card wall|Use CoCalc when/i,
    );
  });

  it("adds compare-page trust resources only when built-in policies are public", () => {
    render(
      <PublicFeaturesApp
        config={{
          help_email: "help@example.com",
          policy_pages: "sagemathinc",
          site_name: "Launchpad",
        }}
        initialRoute={{ slug: "compare", view: "detail" }}
      />,
    );

    expect(
      screen
        .getByRole("link", { name: "Review trust resources" })
        .getAttribute("href"),
    ).toBe("/policies/trust");
    expect(screen.getByText("Checking buyer confidence")).not.toBeNull();
    expect(
      screen.getByText(/Security, SOC 2, GDPR, and public trust resources/),
    ).not.toBeNull();
  });

  it("keeps the compare page scannable and route-focused", () => {
    const { container } = render(
      <PublicFeaturesApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ slug: "compare", view: "detail" }}
      />,
    );

    const decisionRows = screen.getByRole("group", {
      name: "CoCalc compare decision rows",
    });

    expect(
      container.querySelectorAll(".cocalc-compare-decision-panel"),
    ).toHaveLength(2);
    expect(getDirectChildren(decisionRows)).toHaveLength(5);
    expect(
      container.querySelectorAll(".cocalc-compare-route-row"),
    ).toHaveLength(4);
    expect(
      container.querySelectorAll(
        ".cocalc-compare-signal-card,.cocalc-compare-narrow-card,.cocalc-compare-question-card,.cocalc-compare-next-step",
      ),
    ).toHaveLength(0);

    for (const panel of container.querySelectorAll(
      ".cocalc-compare-decision-panel",
    )) {
      expect(textLength(panel)).toBeLessThanOrEqual(480);
    }
    for (const row of getDirectChildren(decisionRows)) {
      expect(textLength(row)).toBeLessThanOrEqual(310);
    }

    const css = Array.from(container.querySelectorAll("style"))
      .map((style) => style.textContent ?? "")
      .join("\n");
    expect(css).toContain(".cocalc-compare-hero");
    expect(css).toContain(".cocalc-compare-split");
    expect(css).toContain(".cocalc-compare-checklist");
    expect(css).toContain("@media (max-width: 900px)");
    expect(css).toContain("@media (max-width: 560px)");

    expect(container.textContent ?? "").not.toMatch(
      /serious technical work|internal planning|multi-bay|project hosts|control plane|stale files|Use CoCalc when|narrower tool/i,
    );
  });
});
