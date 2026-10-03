/** @jest-environment jsdom */

import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { getPublicFeaturePage } from "@cocalc/util/public-feature-pages";
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
  it("carries feature intent into unauthenticated signup links", () => {
    const { container } = render(
      <PublicFeaturesApp
        config={{ site_name: "Launchpad" }}
        initialRoute={{ slug: "jupyter-notebook", view: "detail" }}
      />,
    );

    expect(
      container.querySelector('a[href="/auth/sign-up?intent=jupyter-python"]'),
    ).not.toBeNull();
  });

  it("renders the features index", () => {
    const { container } = render(
      <PublicFeaturesApp
        config={{ site_name: "Launchpad" }}
        initialRoute={{ view: "index" }}
      />,
    );

    expect(
      screen.getByRole("heading", {
        name: "One persistent project for people, tools, and agents.",
      }),
    ).not.toBeNull();
    expect(screen.queryByText("Durable collaborative projects")).toBeNull();
    expect(screen.getByText("Runtime")).not.toBeNull();
    expect(screen.getByText("Documents")).not.toBeNull();
    expect(screen.getByText("AI workflows")).not.toBeNull();
    expect(screen.getAllByText("Jupyter Notebooks").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Linux Terminal").length).toBeGreaterThan(0);
    expect(
      container.querySelector(
        'a[href="/features/terminal"].cocalc-public-interactive-card',
      ),
    ).not.toBeNull();
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
        config={{ cocalc_product: "launchpad", site_name: "Launchpad" }}
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

  it("shows Projects and Agents in the shared nav when authenticated", () => {
    render(
      <PublicFeaturesApp
        config={{ is_authenticated: true, site_name: "Launchpad" }}
        initialRoute={{ view: "index" }}
      />,
    );

    expect(
      screen.getAllByRole("link", { name: /^Open / }).length,
    ).toBeGreaterThan(0);
  });

  it("renders a detail page", () => {
    render(
      <PublicFeaturesApp
        config={{
          cocalc_product: "launchpad",
          help_email: "help@example.com",
          site_name: "Launchpad",
        }}
        initialRoute={{ slug: "ai", view: "detail" }}
      />,
    );

    expect(
      screen.getByRole("heading", {
        name: "AI Agents in CoCalc",
        level: 1,
      }),
    ).not.toBeNull();
    expect(
      screen.getByText(
        "Run AI agents where files, notebooks, compute, and teams stay together.",
      ),
    ).not.toBeNull();
    expect(
      screen.getByText("Direct, inspect, and continue agent work"),
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", { name: "Start with the project" }),
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", {
        name: "Use the agent interface that fits the task.",
      }),
    ).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "Read the Codex guide" }),
    ).toHaveAttribute("href", "/docs/ai/codex-chat");
    expect(
      screen.getByRole("link", {
        name: "Claude Code in CoCalc (Experimental Preview)",
      }),
    ).toHaveAttribute("href", "/docs/ai/claude-code");
    expect(
      screen.getAllByRole("link", {
        name: "Compare with agent sandboxes",
      })[0],
    ).toHaveAttribute("href", "/features/compare");
    expect(
      screen.getByRole("link", { name: "Plan research compute" }),
    ).toHaveAttribute("href", "/features/research-compute");
    expect(
      screen.getByRole("link", { name: "Compare ways to run CoCalc" }),
    ).toHaveAttribute("href", "/products");
    expect(screen.getByText(/Review Codex activity and diffs/)).not.toBeNull();
    expect(
      screen.queryByText(/files touched during agent-assisted work/),
    ).toBeNull();
    expect(screen.queryByText(/how an agent changed a file/)).toBeNull();
    expect(screen.getAllByText("Create account").length).toBeGreaterThan(0);
  });

  it.each([undefined, "star"])(
    "does not advertise unavailable research compute from the %s profile",
    (product) => {
      const { container } = render(
        <PublicFeaturesApp
          config={{ cocalc_product: product, site_name: "CoCalc" }}
          initialRoute={{ slug: "ai", view: "detail" }}
        />,
      );

      expect(
        container.querySelector('a[href="/features/research-compute"]'),
      ).toBeNull();
    },
  );

  it("does not link to hosted Codex docs from CoCalc Plus", () => {
    render(
      <PublicFeaturesApp
        config={{ cocalc_product: "plus", site_name: "CoCalc Plus" }}
        initialRoute={{ slug: "ai", view: "detail" }}
      />,
    );

    expect(
      screen.queryByRole("link", { name: "Read the Codex guide" }),
    ).toBeNull();
    expect(
      screen.queryByRole("link", {
        name: "Claude Code in CoCalc (Experimental Preview)",
      }),
    ).toBeNull();
    expect(screen.queryByRole("link", { name: "Codex setup" })).toBeNull();
    expect(
      screen.queryByRole("link", { name: "Plan research compute" }),
    ).toBeNull();
    const accountLinks = screen.getAllByRole("link", {
      name: "Create account",
    });
    expect(accountLinks.length).toBeGreaterThan(0);
    for (const link of accountLinks) {
      expect(link).toHaveAttribute("href", "/auth/sign-up?intent=codex");
    }
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

  it("shows the feature sub-nav with the active pill marked", () => {
    const { container } = render(
      <PublicFeaturesApp
        config={{ site_name: "Launchpad" }}
        initialRoute={{ slug: "terminal", view: "detail" }}
      />,
    );

    const nav = container.querySelector('nav[aria-label="Feature pages"]');
    expect(nav).not.toBeNull();
    const active = nav!.querySelector('[aria-current="page"]');
    expect(active?.getAttribute("href")).toBe(featurePath("terminal"));
    expect(
      nav!.querySelector(`a[href="${featurePath("latex-editor")}"]`),
    ).not.toBeNull();
    expect(
      nav!.querySelector(`a[href="${featurePath("software-environment")}"]`),
    ).not.toBeNull();
    expect(nav!.querySelector(`a[href="${featurePath()}"]`)).not.toBeNull();
  });

  it("marks the all-features pill active on the index", () => {
    const { container } = render(
      <PublicFeaturesApp
        config={{ site_name: "Launchpad" }}
        initialRoute={{ view: "index" }}
      />,
    );

    const nav = container.querySelector('nav[aria-label="Feature pages"]');
    expect(
      nav?.querySelector('[aria-current="page"]')?.getAttribute("href"),
    ).toBe(featurePath());
  });

  it("renders the richer jupyter feature page", () => {
    render(
      <PublicFeaturesApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ slug: "jupyter-notebook", view: "detail" }}
      />,
    );

    expect(
      screen.getByText("Online Jupyter notebooks, built for collaboration"),
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", {
        name: "Codex works with the live notebook",
      }),
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", { name: "Chat anchored to any cell" }),
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", {
        name: "Jupyter Studio: a content-first notebook view",
      }),
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", {
        name: "TimeTravel: document edit history",
      }),
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
      screen.getByText("An online LaTeX editor with a full project behind it"),
    ).not.toBeNull();
    expect(
      screen.getByText("A full workspace, not one document"),
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", { name: "Forward and inverse search" }),
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", {
        name: "Chat and bookmarks anchored to your source",
      }),
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", {
        name: "Rich text editing, real LaTeX",
      }),
    ).not.toBeNull();
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

  it("opens and closes the screenshot zoom viewer on click", () => {
    render(
      <PublicFeaturesApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ slug: "latex-editor", view: "detail" }}
      />,
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getAllByTitle("Click to enlarge")[0]);
    const dialog = screen.getByRole("dialog");
    expect(dialog).not.toBeNull();
    fireEvent.click(dialog);
    expect(screen.queryByRole("dialog")).toBeNull();
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

  it("renders the terminal page from its feature record, like the crawler fallback", () => {
    const page = getPublicFeaturePage("terminal")!;
    const { container } = render(
      <PublicFeaturesApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ slug: "terminal", view: "detail" }}
      />,
    );

    expect(
      screen.getByRole("heading", { level: 2, name: page.tagline }),
    ).not.toBeNull();
    expect(screen.getByText(page.summary)).not.toBeNull();
    expect(page.highlights).toHaveLength(4);
    for (const highlight of page.highlights!) {
      expect(screen.getByText(highlight)).not.toBeNull();
    }
    expect(page.sections).toHaveLength(4);
    for (const { bullets, links, paragraphs, title } of page.sections!) {
      // The page renders paragraphs and links; bullets would reach only the
      // crawler fallback.
      expect(bullets).toBeUndefined();
      expect(
        screen.getByRole("heading", { level: 3, name: title }),
      ).not.toBeNull();
      for (const paragraph of paragraphs!) {
        expect(screen.getByText(paragraph)).not.toBeNull();
      }
      for (const { href, label } of links ?? []) {
        expect(
          screen.getByRole("link", { name: label }).getAttribute("href"),
        ).toBe(href);
      }
    }
    expect(page.signUpLabel).toBe("Start on CoCalc.ai");
    const ctas = screen.getAllByRole("link", { name: page.signUpLabel });
    expect(ctas).toHaveLength(2);
    for (const cta of ctas) {
      expect(cta.getAttribute("href")).toBe("/auth/sign-up?intent=code");
    }
    // The record's image is the link preview and the page's only screenshot
    // (the shell's logos have empty alt text).
    expect(page.image).toBe("/public/landing/project-terminal-20260916.jpg");
    const screenshots = Array.from(container.querySelectorAll("img")).filter(
      (img) => img.getAttribute("alt") !== "",
    );
    expect(screenshots).toHaveLength(1);
    expect(screenshots[0].getAttribute("src")).toBe(page.image);
    expect(screenshots[0].getAttribute("alt")).toMatch(/Agent button/);
    expect(
      screen.getByText(
        /When AI is enabled for your site, account, and project/,
      ),
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
    expect(projectLinks).toHaveLength(2);
    for (const link of projectLinks) {
      expect(link.getAttribute("href")).toBe("/projects");
    }
    expect(
      screen.queryByRole("link", {
        name: getPublicFeaturePage("terminal")!.signUpLabel,
      }),
    ).toBeNull();
  });

  it("renders the software-environment feature page", () => {
    render(
      <PublicFeaturesApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ slug: "software-environment", view: "detail" }}
      />,
    );

    expect(
      screen.getByText("Your project's software is an image you choose"),
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", {
        name: "Ready-made images for real workflows",
      }),
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", { name: "Pick per project, switch anytime" }),
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", {
        name: "Build and share your own images",
      }),
    ).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "Browse the image catalog" }),
    ).not.toBeNull();
  });

  it("renders the richer linux environment page", () => {
    render(
      <PublicFeaturesApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ slug: "linux", view: "detail" }}
      />,
    );

    expect(
      screen.getByText("A complete Linux environment in your browser."),
    ).not.toBeNull();
    expect(
      screen.getByText("Root access with sudo, and installs that persist"),
    ).not.toBeNull();
    expect(
      screen.getByText("Snapshots and backups with configurable retention"),
    ).not.toBeNull();
    expect(screen.getByText("SSH, scp, and rsync")).not.toBeNull();
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

  it("renders the graphical Linux applications page", () => {
    render(
      <PublicFeaturesApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ slug: "x11", view: "detail" }}
      />,
    );

    expect(
      screen.getByText(
        "Linux graphical applications, directly in your browser.",
      ),
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", {
        name: "Focus one application, keep every window visible",
      }),
    ).not.toBeNull();
    expect(screen.getByText("PipeWire browser audio")).not.toBeNull();
    expect(
      screen.getByText("One persistent graphical display per project"),
    ).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "Blit" }).getAttribute("href"),
    ).toBe("https://blit.sh/");
    expect(
      screen
        .getByRole("link", { name: "Graphical applications guide" })
        .getAttribute("href"),
    ).toBe("/app-docs/terminal/graphical-applications");
  });

  it("uses projects as the graphical Linux CTA for authenticated users", () => {
    render(
      <PublicFeaturesApp
        config={{
          help_email: "help@example.com",
          is_authenticated: true,
          site_name: "Launchpad",
        }}
        initialRoute={{ slug: "x11", view: "detail" }}
      />,
    );

    const projectLinks = screen.getAllByRole("link", { name: "Open projects" });
    expect(projectLinks.length).toBeGreaterThan(0);
    for (const link of projectLinks) {
      expect(link.getAttribute("href")).toBe("/projects");
    }
    expect(screen.queryByText("Run graphical applications")).toBeNull();
  });

  it("renders the richer python feature page", () => {
    render(
      <PublicFeaturesApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ slug: "python", view: "detail" }}
      />,
    );

    expect(
      screen.getByText(
        "A full Python environment online, set up the way you want.",
      ),
    ).not.toBeNull();
    expect(
      screen.getByText("Install the packages you want, at any layer"),
    ).not.toBeNull();
    expect(screen.getByText("Heavy computations and GPUs")).not.toBeNull();
    expect(screen.getByText("Python online")).not.toBeNull();
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
      title: "Use SageMath online, without installing anything.",
      section: "SageTeX: Sage inside LaTeX documents",
    },
    {
      slug: "julia",
      title: "Run Julia online, in notebooks, Pluto, and the terminal.",
      section: "Package environments that stay with the project",
    },
    {
      slug: "r-statistical-software",
      title: "R statistical software online, from analysis to report.",
      section: "Knitr documents in the LaTeX editor",
    },
    {
      slug: "octave",
      title: "Run GNU Octave online in a project you control.",
      section: "Octave, with the packages you expect",
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

    expect(
      screen.getByText("Persistent workspace or isolated execution?"),
    ).not.toBeNull();
    expect(screen.getByText("Decision checklist")).not.toBeNull();
    expect(
      screen.getByRole("heading", {
        name: "Shared project or agent sandbox?",
      }),
    ).not.toBeNull();
    expect(
      screen
        .getByRole("region", {
          name: "CoCalc and AI agent sandbox comparison",
        })
        .getAttribute("id"),
    ).toBe("agent-sandboxes");
    expect(
      screen.getByText(/Some support persistent files, snapshots/),
    ).not.toBeNull();
    expect(
      screen.getByText(/persistent shared project that people and agents/),
    ).not.toBeNull();
    expect(
      screen.getByRole("columnheader", {
        name: "Choose an agent sandbox when",
      }),
    ).not.toBeNull();
    expect(
      screen.getByText(/If your design requires automatic fleets/),
    ).not.toBeNull();
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

// Managed VMs stay off the compute page, as an option or as a detail, until
// they are generally available.
const MANAGED_VM_TERMS = /\bVMs?\b|virtual machines?|\bWindows\b/i;

// cocalc.ai is Launchpad on the canonical host; /customize reports the
// request host as `dns`.
const COCALC_AI = { cocalc_product: "launchpad", dns: "cocalc.ai" };

// jsdom toggles a details element when its summary is clicked, but it does
// not click a focused summary on Enter or Space as browsers do. This presses
// the key on the focused element and then clicks that element, as a browser
// would, after checking that the page did not cancel the key.
async function pressOnFocusedSummary(
  user: ReturnType<typeof userEvent.setup>,
  key: "{Enter}" | "[Space]",
) {
  const focused = document.activeElement as HTMLElement;
  expect(focused.tagName).toBe("SUMMARY");
  let cancelled = false;
  const watch = (event: Event) => {
    if (event.defaultPrevented) cancelled = true;
  };
  window.addEventListener("keydown", watch);
  window.addEventListener("keyup", watch);
  try {
    await user.keyboard(key);
  } finally {
    window.removeEventListener("keydown", watch);
    window.removeEventListener("keyup", watch);
  }
  expect(cancelled).toBe(false);
  focused.click();
}

describe("research compute product visibility", () => {
  it.each(["plus", undefined, "unknown"])(
    "omits only compute from the index and subnav for product %s",
    (product) => {
      const { container } = render(
        <PublicFeaturesApp
          config={{ cocalc_product: product, site_name: "CoCalc" }}
          initialRoute={{ view: "index" }}
        />,
      );
      expect(
        container.querySelector('a[href="/features/research-compute"]'),
      ).toBeNull();
      expect(
        container.querySelector('a[href="/features/terminal"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('a[href="/features/jupyter-notebook"]'),
      ).not.toBeNull();
      expect(screen.getByText("Runtime")).not.toBeNull();
    },
  );

  it("reports Plus as not found without exposing the compute documentation links", () => {
    const { container } = render(
      <PublicFeaturesApp
        config={{ cocalc_product: "plus" }}
        initialRoute={{ view: "detail", slug: "research-compute" }}
      />,
    );
    expect(screen.getByText("Feature page not found")).not.toBeNull();
    expect(
      container.querySelector('a[href="/docs/hosts/project-hosts"]'),
    ).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Research Compute", level: 1 }),
    ).toBeNull();
  });

  it("keeps unknown availability distinct from not found and preserves the initial title", () => {
    document.title = "Server compute title";
    render(
      <PublicFeaturesApp
        initialRoute={{ view: "detail", slug: "research-compute" }}
      />,
    );
    expect(
      screen.getByText(/Feature availability could not be checked/),
    ).not.toBeNull();
    expect(screen.queryByText("Feature page not found")).toBeNull();
    expect(document.title).toBe("Server compute title");
  });

  it.each(["launchpad", "rocket"])(
    "renders compute after unknown configuration resolves to %s",
    (product) => {
      const route = { view: "detail" as const, slug: "research-compute" };
      const { rerender } = render(<PublicFeaturesApp initialRoute={route} />);
      expect(
        screen.getByText(/Feature availability could not be checked/),
      ).not.toBeNull();
      rerender(
        <PublicFeaturesApp
          config={{ cocalc_product: product }}
          initialRoute={route}
        />,
      );
      expect(
        screen.getByRole("heading", { name: "Research Compute", level: 1 }),
      ).not.toBeNull();
      expect(
        screen.getByRole("link", { name: "Use project hosts" }),
      ).toHaveAttribute("href", "/docs/hosts/project-hosts");
      expect(
        screen.getByRole("heading", {
          name: "Compute for demanding analysis and simulation.",
          level: 2,
        }),
      ).not.toBeNull();
      for (const link of screen.getAllByRole("link", {
        name: "Choose compute for research",
      })) {
        expect(link).toHaveAttribute("href", "/docs/hosts/choose-compute");
      }
      rerender(
        <PublicFeaturesApp
          config={{ cocalc_product: "plus" }}
          initialRoute={route}
        />,
      );
      expect(screen.getByText("Feature page not found")).not.toBeNull();
      expect(
        screen.queryByRole("link", { name: "Use project hosts" }),
      ).toBeNull();
    },
  );

  it("renders the compute page from its feature record, like the crawler fallback", () => {
    const page = getPublicFeaturePage("research-compute", COCALC_AI)!;
    const { container } = render(
      <PublicFeaturesApp
        config={{
          ...COCALC_AI,
          help_email: "help@example.com",
          site_name: "CoCalc",
        }}
        initialRoute={{ view: "detail", slug: page.slug }}
      />,
    );

    // One H1, the record's title; the hero line is the record's tagline.
    expect(
      Array.from(container.querySelectorAll("h1")).map((h) => h.textContent),
    ).toEqual([page.title]);
    expect(
      screen.getByRole("heading", { level: 2, name: page.tagline }),
    ).not.toBeNull();
    expect(screen.getByText(page.summary)).not.toBeNull();

    // In order: the options with the cost line, and the sizing section with
    // its collapsed technical details.
    expect(page.sections).toHaveLength(2);
    const [options, sizing] = page.sections!;
    for (const { paragraphs, title } of page.sections!) {
      expect(
        screen.getByRole("heading", { level: 2, name: title }),
      ).not.toBeNull();
      expect(paragraphs).toHaveLength(1);
      expect(screen.getByText(paragraphs![0])).not.toBeNull();
    }
    expect(options.cards).toHaveLength(2);
    for (const { body, link, title } of options.cards!) {
      expect(
        screen.getByRole("heading", { level: 3, name: title }),
      ).not.toBeNull();
      expect(screen.getByText(body)).not.toBeNull();
      if (link) {
        expect(
          screen.getByRole("link", { name: link.label }).getAttribute("href"),
        ).toBe(link.href);
      }
    }
    expect(sizing.detailsLabel).toBe("Technical details");
    const disclosure = screen.getByText(sizing.detailsLabel!)
      .parentElement as HTMLDetailsElement;
    expect(disclosure.tagName).toBe("DETAILS");
    expect(disclosure.open).toBe(false);
    expect(
      within(disclosure)
        .getAllByRole("listitem", { hidden: true })
        .map((li) => li.textContent),
    ).toEqual(sizing.bullets);
    expect(sizing.links).toHaveLength(1);
    for (const { href, label } of sizing.links!) {
      const links = screen.getAllByRole("link", { name: label });
      // The hero's documentation button and the link at the end.
      expect(links).toHaveLength(2);
      for (const link of links) {
        expect(link.getAttribute("href")).toBe(href);
      }
    }
    expect(page.docsUrl).toBe(sizing.links![0].href);

    expect(page.signUpLabel).toBe("Start on CoCalc.ai");
    const ctas = screen.getAllByRole("link", { name: page.signUpLabel });
    expect(ctas).toHaveLength(2);
    for (const cta of ctas) {
      expect(cta.getAttribute("href")).toBe("/auth/sign-up?intent=code");
    }
    expect(
      screen.getByRole("link", { name: "Contact CoCalc" }).getAttribute("href"),
    ).toBe("mailto:help@example.com");

    // The hero is text only, so no claim rests on an image.
    expect(container.querySelector("figure")).toBeNull();
    // No managed VM option, detail or guide link.
    expect(container.textContent).not.toMatch(MANAGED_VM_TERMS);
    expect(
      container.querySelector('a[href*="projects/virtual-machines"]'),
    ).toBeNull();
  });

  // Other sites, such as a customer-operated Launchpad or Rocket site, show
  // the same page without CoCalc.ai's cost line and with the default sign-up
  // label, as their crawler fallback does.
  it.each([
    ["launchpad", "launchpad.example.edu"],
    ["rocket", "compute.example.edu"],
  ])(
    "leaves CoCalc.ai's sign-up and billing off the compute page for %s on %s",
    (cocalc_product, dns) => {
      const renderMain = (config: { cocalc_product: string; dns: string }) => {
        const { unmount } = render(
          <PublicFeaturesApp
            config={config}
            initialRoute={{ view: "detail", slug: "research-compute" }}
          />,
        );
        const text = screen.getByRole("main").textContent!;
        unmount();
        return text;
      };
      const cocalcAi = getPublicFeaturePage("research-compute", COCALC_AI)!;
      const costLine = cocalcAi.sections![0].paragraphs![0];
      const onCocalcAi = renderMain(COCALC_AI);
      expect(onCocalcAi).toContain(costLine);
      // The hero button and the button at the end.
      expect(onCocalcAi.split("Start on CoCalc.ai")).toHaveLength(3);

      const page = getPublicFeaturePage("research-compute", {
        cocalc_product,
        dns,
      })!;
      expect(page.signUpLabel).toBeUndefined();
      expect(page.sections![0].paragraphs).toEqual([]);
      const elsewhere = renderMain({ cocalc_product, dns });
      expect(elsewhere).toBe(
        onCocalcAi
          .replace(costLine, "")
          .replaceAll("Start on CoCalc.ai", "Start using CoCalc"),
      );
      expect(elsewhere).not.toContain("CoCalc.ai");
      expect(elsewhere).not.toContain("membership");
    },
  );

  it("opens and closes the technical details from the keyboard", async () => {
    const page = getPublicFeaturePage("research-compute", COCALC_AI)!;
    const [options, sizing] = page.sections!;
    render(
      <PublicFeaturesApp
        config={COCALC_AI}
        initialRoute={{ view: "detail", slug: page.slug }}
      />,
    );
    const user = userEvent.setup();

    // A native disclosure. Testing Library has no role for <summary>, so the
    // control is found by its label, which is its accessible name.
    const summary = screen.getByText("Technical details");
    expect(summary.tagName).toBe("SUMMARY");
    const details = summary.parentElement as HTMLDetailsElement;
    expect(details.tagName).toBe("DETAILS");
    expect(details.firstElementChild).toBe(summary);
    const items = within(details).getAllByRole("listitem", { hidden: true });
    expect(items.map((item) => item.textContent)).toEqual(sizing.bullets);
    const expectDisclosure = (open: boolean) => {
      expect(details.open).toBe(open);
      for (const item of items) {
        if (open) {
          expect(item).toBeVisible();
        } else {
          expect(item).not.toBeVisible();
        }
      }
      expect(summary).toBeVisible();
      expect(summary).toHaveFocus();
    };

    // Closed at first. Tab moves from the last option's link to the summary.
    expect(details.open).toBe(false);
    screen.getByRole("link", { name: options.cards![1].link!.label }).focus();
    await user.tab();
    expectDisclosure(false);

    await pressOnFocusedSummary(user, "{Enter}");
    expectDisclosure(true);
    await pressOnFocusedSummary(user, "{Enter}");
    expectDisclosure(false);
    await pressOnFocusedSummary(user, "[Space]");
    expectDisclosure(true);
    await pressOnFocusedSummary(user, "[Space]");
    expectDisclosure(false);

    // Tab then leaves the summary for the button row after the list.
    await user.tab();
    expect(summary).not.toHaveFocus();
    expect(
      screen.getAllByRole("link", { name: "Start on CoCalc.ai" }),
    ).toContain(document.activeElement);
  });

  it("opens project hosts for signed-in visitors", () => {
    const { container } = render(
      <PublicFeaturesApp
        config={{ cocalc_product: "launchpad", is_authenticated: true }}
        initialRoute={{ view: "detail", slug: "research-compute" }}
      />,
    );

    expect(container.textContent).not.toMatch(MANAGED_VM_TERMS);
    const ctas = screen.getAllByRole("link", { name: "Open project hosts" });
    expect(ctas).toHaveLength(2);
    for (const cta of ctas) {
      expect(cta.getAttribute("href")).toBe("/hosts");
    }
    expect(
      screen.queryByRole("link", {
        name: getPublicFeaturePage("research-compute")!.signUpLabel,
      }),
    ).toBeNull();
  });
});
