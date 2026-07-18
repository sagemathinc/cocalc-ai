/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";

import PublicFeaturesApp from "../app";
import { getFeatureIndexPages } from "../catalog";
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
        name: "Collaborate using your favorite software and AI agents.",
      }),
    ).not.toBeNull();
    expect(screen.queryByText("Durable collaborative projects")).toBeNull();
    expect(screen.getByText("Runtime")).not.toBeNull();
    expect(screen.getByText("Documents")).not.toBeNull();
    expect(screen.getByText("AI workflows")).not.toBeNull();
    expect(screen.getAllByText("Jupyter Notebooks").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Linux Terminal").length).toBeGreaterThan(0);
    expect(screen.queryByText("Open page")).toBeNull();
    expect(
      screen
        .getAllByRole("link", { name: /Jupyter Notebooks/i })[0]
        .getAttribute("href"),
    ).toBe("/features/jupyter-notebook");
  });

  it("renders every indexed feature page on the index", () => {
    const { container } = render(
      <PublicFeaturesApp
        config={{ site_name: "Launchpad" }}
        initialRoute={{ view: "index" }}
      />,
    );

    for (const page of getFeatureIndexPages()) {
      expect(screen.getAllByText(page.title).length).toBeGreaterThan(0);
      expect(
        container.querySelector(`a[href="${featurePath(page.slug)}"]`),
      ).not.toBeNull();
    }

    expect(
      screen.getByRole("heading", { name: "Whiteboard & Slides" }),
    ).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "Explore Slides" }).getAttribute("href"),
    ).toBe(featurePath("slides"));
    expect(screen.queryByRole("heading", { name: "Slides" })).toBeNull();
    expect(container.querySelector("a a")).toBeNull();

    expect(screen.queryByText("Feature Assets")).toBeNull();
    expect(screen.queryByText("Internationalization")).toBeNull();
    expect(
      container.querySelector(`a[href="${featurePath("icons")}"]`),
    ).toBeNull();
    expect(
      container.querySelector(`a[href="${featurePath("i18n")}"]`),
    ).toBeNull();
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
        name: "Codex Agent Chat",
        level: 1,
      }),
    ).not.toBeNull();
    expect(screen.getByText("Codex where the work happens.")).not.toBeNull();
    expect(screen.getByText("Run an agent turn in order.")).not.toBeNull();
    expect(screen.getAllByText("Create account").length).toBeGreaterThan(0);
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

    expect(
      screen.getByText("Jupyter notebooks for work that needs to keep going"),
    ).not.toBeNull();
    expect(
      screen.getByText("When the notebook depends on more than cells"),
    ).not.toBeNull();
    expect(screen.getByText("Ready to use Jupyter in CoCalc?")).not.toBeNull();
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
    expect(screen.queryByText("Start using Jupyter in CoCalc")).toBeNull();
  });

  it("renders the richer latex feature page", () => {
    render(
      <PublicFeaturesApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ slug: "latex-editor", view: "detail" }}
      />,
    );

    expect(
      screen.getByText("LaTeX project with source, PDF preview, and build log"),
    ).not.toBeNull();
    expect(screen.getByText("Keep the working tree together")).not.toBeNull();
    expect(screen.getByText("Ready to write LaTeX in CoCalc?")).not.toBeNull();
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
    render(
      <PublicFeaturesApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ slug: "teaching", view: "detail" }}
      />,
    );

    expect(
      screen.getByText("Teach where students compute, write, and collaborate"),
    ).not.toBeNull();
    expect(
      screen.getByText(
        "Run coursework in shared projects while the LMS keeps rosters and calendars.",
      ),
    ).not.toBeNull();
    expect(screen.getByText("Start with course projects")).not.toBeNull();
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
    expect(screen.queryByText("Start a course in CoCalc")).toBeNull();
  });

  it("renders the richer terminal feature page", () => {
    render(
      <PublicFeaturesApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ slug: "terminal", view: "detail" }}
      />,
    );

    expect(
      screen.getByText("A Linux terminal that lives in your project."),
    ).not.toBeNull();
    expect(
      screen.getAllByText("Each terminal opens in its own folder.").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByText("Put the shell beside the work it changes"),
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
    expect(screen.queryByText("Create account")).toBeNull();
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
      screen.getByText(
        "Install at the right layer, verify, and document what changed",
      ),
    ).not.toBeNull();
    expect(screen.getByText("Ready to use Linux in CoCalc?")).not.toBeNull();
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
    expect(
      screen.getByText("The right interface at each stage"),
    ).not.toBeNull();
    expect(screen.getByText("Project context")).not.toBeNull();
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
    expect(screen.queryByRole("link", { name: "Create account" })).toBeNull();
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
        "Whiteboards and slides that keep the code, math, and explanations together.",
      ),
    ).not.toBeNull();
    expect(
      screen.getByText("Move board work into a slide deck when it is ready."),
    ).not.toBeNull();
    expect(screen.getByText("Start with a board or deck")).not.toBeNull();
  });

  it("renders the richer api feature page", () => {
    render(
      <PublicFeaturesApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ slug: "api", view: "detail" }}
      />,
    );

    expect(
      screen.getByText(
        "Drive your projects, notebooks, and terminals from your own code",
      ),
    ).not.toBeNull();
    expect(
      screen.getByText("A documented route, not fragile UI scripts"),
    ).not.toBeNull();
  });

  it.each([
    {
      slug: "sage",
      title: "Use SageMath inside collaborative mathematics projects.",
      section: "Use Sage with the surrounding project.",
    },
    {
      slug: "julia",
      title: "Use Julia in Pluto, Jupyter, and shared modeling projects.",
      section: "Keep Julia close to the rest of the research.",
    },
    {
      slug: "r-statistical-software",
      title: "Use R for statistics and reproducible reporting.",
      section: "Keep R close to the rest of the analysis.",
    },
    {
      slug: "octave",
      title:
        "Run GNU Octave with notebooks, .m files, and shared numerical work.",
      section: "Run reproducible Octave work without local setup drift.",
    },
    {
      slug: "slides",
      title: "Present from the same canvas where technical ideas are built.",
      section: "How a deck comes together",
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

  it.each(["julia", "r-statistical-software", "teaching"])(
    "renders the configured support link on the %s feature page",
    (slug) => {
      render(
        <PublicFeaturesApp
          config={{ help_email: "help@example.com", site_name: "Launchpad" }}
          initialRoute={{ slug, view: "detail" }}
        />,
      );

      expect(
        screen
          .getByRole("link", { name: "Contact support" })
          .getAttribute("href"),
      ).toBe("mailto:help@example.com");
    },
  );

  it.each([
    { finalCta: "Start using SageMath", slug: "sage" },
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
      expect(screen.queryByRole("link", { name: finalCta })).toBeNull();
    },
  );

  it("renders the compare feature page", () => {
    const { container } = render(
      <PublicFeaturesApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ slug: "compare", view: "detail" }}
      />,
    );

    expect(screen.getByText("When is CoCalc the right fit?")).not.toBeNull();
    expect(screen.getByText("Decision checklist")).not.toBeNull();
    expect(screen.getByText("Where to go next")).not.toBeNull();
    expect(
      screen.getByText("Hosted, local, single-VM, and private deployment."),
    ).not.toBeNull();
    const supportHref =
      screen
        .getByRole("link", { name: "Talk with CoCalc" })
        .getAttribute("href") ?? "";
    expect(supportHref).toContain("/support/new?");
    expect(supportHref).toContain("type=question");
    expect(supportHref).toContain("context=feature-compare");
    expect(supportHref).not.toContain("type=purchase");
    expect(supportHref.startsWith("mailto:")).toBe(false);
    expect(
      container.querySelectorAll(".cocalc-compare-route-row"),
    ).toHaveLength(3);
    expect(
      screen.queryByRole("link", { name: "Review pricing options" }),
    ).toBeNull();
    expect(
      screen.queryByText("Google Colab and quick notebook hosts"),
    ).toBeNull();
  });

  it("adds the trust route on the compare feature page when built-in policies are enabled", () => {
    const { container } = render(
      <PublicFeaturesApp
        config={{ policy_pages: "sagemathinc", site_name: "Launchpad" }}
        initialRoute={{ slug: "compare", view: "detail" }}
      />,
    );

    expect(
      container.querySelectorAll(".cocalc-compare-route-row"),
    ).toHaveLength(4);
    expect(
      screen.getByText("Security and privacy context for evaluating CoCalc."),
    ).not.toBeNull();
    expect(
      screen
        .getByRole("link", { name: "Review trust and compliance" })
        .getAttribute("href"),
    ).toBe("/policies/trust");
  });
});
