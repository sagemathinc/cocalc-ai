/** @jest-environment jsdom */

import { execFileSync } from "child_process";
import { readFileSync } from "fs";

import { fireEvent, render, screen, within } from "@testing-library/react";

import {
  combineLeak,
  DARK_FEATURE_CARD_STYLE,
  expectHeadingHierarchy,
  expectPrimaryCtaEmphasisSane,
  expectProseDensity,
  expectTextSizesOnScale,
  getDirectCards,
  getHeadingTexts,
  HERO_H1_MAX,
  installMatchMediaStub,
  INTERNAL_IMPLEMENTATION_TERMS,
  SECTION_H2_MAX,
  textLength,
} from "../../__tests__/test-helpers";
import { PUBLIC_DARK } from "../../theme";
import PublicFeaturesApp from "../app";
import { featurePath, getFeaturesRouteFromPath } from "../routes";

beforeAll(() => {
  installMatchMediaStub();
});

function trackedFeatureSources(): { file: string; source: string }[] {
  return execFileSync("git", ["ls-files", "public/features/*.tsx"], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter((file) => file && !file.includes("/__tests__/"))
    .map((file) => ({ file, source: readFileSync(file, "utf8") }));
}

// Internal/implementation language that must never leak into feature copy.
// The shared INTERNAL_IMPLEMENTATION_TERMS floor supplies the cross-surface
// bans (serious technical work, project hosts, multi-bay, control plane,
// RootFS, ...); only the feature-surface-unique phrases are listed here so the
// floor stays the single source of truth for the shared terms.
const INTERNAL_CONTEXT_LEAKAGE = combineLeak(
  INTERNAL_IMPLEMENTATION_TERMS,
  "Feature map|Workflow map|Positioning|Real collaborative Python|Collaborative Linux terminal|Real project Linux|LaTeX inside a technical project|Where CoCalc fits|Technical presentations|Collaborative technical canvas|serious Linux|strongest|workspace model|internal planning|\\bstale\\b|CoCalc-AI|locked-down|launchpad-style|internal platform|narrow patch|install narrowly|narrower tool|Use CoCalc when|competitor comparison|proof packet|evidence register|pitch docs|AGENTS\\.md|CLAUDE\\.md|GEMINI\\.md|public-site cohesion audit|agent operating",
);

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
  it("uses PUBLIC_RADIUS.panel for exact 8px feature panel radii", () => {
    const offenders = trackedFeatureSources().flatMap(({ file, source }) => {
      const messages: string[] = [];
      if (/\b(?:FEATURE_)?PANEL_RADIUS\b/.test(source)) {
        messages.push(`${file}: local panel radius constant`);
      }
      if (/borderRadius:\s*8\b/.test(source)) {
        messages.push(`${file}: bare borderRadius: 8`);
      }
      return messages;
    });

    expect(offenders).toEqual([]);
  });

  it("uses PUBLIC_DARK tokens for exact mock chrome colors", () => {
    const tokenizedDarkHex =
      /#(?:0b1522|10213f|0b1f47|111827|dbeafe|86efac|bfdbfe|ff6b6b|ffd166|06d6a0)\b/i;
    const offenders = trackedFeatureSources().flatMap(({ file, source }) =>
      tokenizedDarkHex.test(source)
        ? [`${file}: tokenable PUBLIC_DARK literal`]
        : [],
    );

    expect(offenders).toEqual([]);
  });

  it("uses PUBLIC_ELEVATION tokens for feature shadow ink", () => {
    const legacyFeatureShadow = /rgba\(33,\s*49,\s*57,/;
    const offenders = trackedFeatureSources().flatMap(({ file, source }) =>
      legacyFeatureShadow.test(source)
        ? [`${file}: legacy feature shadow literal`]
        : [],
    );

    expect(offenders).toEqual([]);
  });

  const contextualSupportLinks = [
    {
      context: "feature-ai",
      label: "Ask about AI workflows",
      slug: "ai",
    },
    {
      context: "feature-automations",
      label: "Ask about project automations",
      slug: "automations",
    },
    {
      context: "feature-cli",
      label: "Ask about CLI automation",
      slug: "cli",
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
    {
      context: "feature-python",
      label: "Ask about Python workflows",
      slug: "python",
    },
    {
      context: "feature-sage",
      label: "Ask about SageMath workflows",
      slug: "sage",
    },
    {
      context: "feature-r-statistical-software",
      label: "Ask about R workflows",
      slug: "r-statistical-software",
    },
    {
      context: "feature-octave",
      label: "Ask about Octave workflows",
      slug: "octave",
    },
    {
      context: "feature-more-languages",
      label: "Ask about language workflows",
      slug: "more-languages",
    },
  ] as const;

  const auditedFeaturePages = [
    {
      marker: "Codex where the work happens.",
      slug: "ai",
    },
    {
      marker: "Turn recurring project workflows into repeatable runs.",
      slug: "automations",
    },
    {
      marker: "Run project work from the command line.",
      slug: "cli",
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
      marker: "Use SageMath inside collaborative mathematics projects.",
      slug: "sage",
    },
    {
      marker: "Use R for statistics and reproducible reporting.",
      slug: "r-statistical-software",
    },
    {
      marker:
        "Use Julia in Pluto, Jupyter, and shared modeling projects.",
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
      marker: "Whiteboards and slides for math, code, and collaboration.",
      slug: "whiteboard",
    },
    {
      marker: "Present from the same canvas where technical ideas are built.",
      slug: "slides",
    },
    {
      marker:
        "Drive your projects, notebooks, and terminals from your own code",
      slug: "api",
    },
    {
      marker:
        "Run GNU Octave with notebooks, .m files, and shared numerical work.",
      slug: "octave",
    },
    {
      marker: "Use many other languages from the same project.",
      slug: "more-languages",
    },
  ] as const;

  it("renders the features index", () => {
    const { container } = render(
      <PublicFeaturesApp
        config={{ site_name: "Launchpad" }}
        initialRoute={{ view: "index" }}
      />,
    );

    // Hero identity is the region + a single capped <h1>; the exact headline
    // wording is free to change without a test edit.
    const indexHero = container.querySelector(".cocalc-feature-index-hero");
    expect(indexHero).not.toBeNull();
    const indexH1 = container.querySelectorAll("h1");
    expect(indexH1).toHaveLength(1);
    expect(textLength(indexH1[0])).toBeLessThanOrEqual(HERO_H1_MAX);
    expect(
      screen.getAllByRole("link", { name: /Courses and labs/i }),
    ).toHaveLength(1);
    expect(
      screen.queryByAltText(/CoCalc feature map/i),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Notebooks and writing")).not.toBeNull();
    expect(
      screen.queryByRole("link", { name: "Project notes and Markdown" }),
    ).toBeNull();
    expect(screen.getByText("AI workflows")).not.toBeNull();
    expect(screen.getByText("Runtime")).not.toBeNull();
    expect(screen.getByText("Languages")).not.toBeNull();
    expect(screen.getByText("Teaching")).not.toBeNull();
    const indexText = container.textContent ?? "";
    expect(indexText.indexOf("Runtime")).toBeLessThan(
      indexText.indexOf("Notebooks and writing"),
    );
    expect(indexText.indexOf("Notebooks and writing")).toBeLessThan(
      indexText.indexOf("AI workflows"),
    );
    expect(indexText.indexOf("AI workflows")).toBeLessThan(
      indexText.indexOf("Languages"),
    );
    expect(indexText.indexOf("Teaching")).toBeGreaterThan(
      indexText.indexOf("Languages"),
    );
    // Group-label identity + order is pinned positively above; the prior
    // per-variant negative prose bans were redundant copy pins and were
    // removed. Internal-language leakage stays centrally guarded.
    expect(screen.getAllByText("Jupyter Notebooks").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Linux Terminal").length).toBeGreaterThan(0);
    expect(container.textContent ?? "").not.toMatch(INTERNAL_CONTEXT_LEAKAGE);
    expect(screen.queryByRole("link", { name: /Compare CoCalc/i })).toBeNull();
    expect(
      screen.getByRole("link", { name: /CoCalc CLI/i }).getAttribute("href"),
    ).toBe("/features/cli");
    expect(
      screen.getByText(
        "Run documented commands against CoCalc projects so scripts and shell-capable agents can inspect context, run notebook checks, and leave outputs for review.",
      ),
    ).not.toBeNull();
    expect(
      screen.getByText(
        /notebooks, code, terminals, documents, outputs, TimeTravel history/i,
      ),
    ).not.toBeNull();
    expect(container.textContent ?? "").not.toMatch(/command-line surface/i);
    expect(
      screen
        .getByRole("link", { name: /Project Automations/i })
        .getAttribute("href"),
    ).toBe("/features/automations");
    expect(screen.queryByRole("link", { name: /^HTTP API$/ })).toBeNull();
    expect(
      screen
        .getByRole("link", { name: /Dedicated Compute/i })
        .getAttribute("href"),
    ).toBe("/docs/hosts/project-hosts");
    expect(
      screen.getByRole("link", { name: /More/i }).getAttribute("href"),
    ).toBe("/features/more-languages");
    const featureIndexLinks = Array.from(container.querySelectorAll("a")).map(
      (link) => link.getAttribute("href"),
    );
    expect(featureIndexLinks).toContain("/features/whiteboard");
    expect(featureIndexLinks).not.toContain("/features/slides");
    const languageLinks = Array.from(
      container.querySelectorAll(".cocalc-feature-link-list a"),
    ).map((link) => link.getAttribute("href"));
    expect(languageLinks).toContain("/features/more-languages");
    expect(languageLinks).not.toContain("/docs/terminal/use-terminal");
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
      container.querySelectorAll(".cocalc-feature-group-label"),
    ).toHaveLength(4);
    expect(container.querySelectorAll(".cocalc-feature-link-card").length).toBe(
      10,
    );
    expect(container.querySelectorAll(".cocalc-feature-list-link").length).toBe(
      6,
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
    expect(screen.queryByText(/^Documents$/)).toBeNull();
    expect(
      screen.queryByRole("link", { name: "Project notes and Markdown" }),
    ).toBeNull();
    const css = Array.from(container.querySelectorAll("style"))
      .map((style) => style.textContent ?? "")
      .join("\n");
    expect(css).toContain(".cocalc-feature-link-card:hover");
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
    const { container } = render(
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
    // Hero marker is the page identity anchor (treated like a route canary).
    expect(screen.getByText("Codex where the work happens.")).not.toBeNull();
    // Body keeps a route-specific keyword rather than pinning the sentence.
    expect(
      screen.getByText(/edit Markdown notes or documentation/i),
    ).not.toBeNull();
    // Mock-UI labels (not headings): the agent panel says "Agent thread" /
    // "Durable agent thread", never the prior "Codex"/"chat history" labels.
    expect(screen.getByText("Agent thread")).not.toBeNull();
    expect(screen.queryByText("Codex thread")).toBeNull();
    expect(
      container
        .querySelector(".cocalc-ai-workflow-panel")
        ?.getAttribute("style") ?? "",
    ).not.toContain(PUBLIC_DARK.terminalSurface);
    expect(screen.getByText("Durable agent thread")).not.toBeNull();
    expect(screen.queryByText("Durable chat history")).toBeNull();
    // Closing section identity without pinning the exact headline wording.
    expect(screen.getByText(/Choose the .*path that fits/i)).not.toBeNull();
    expect(screen.getAllByText("Create account").length).toBeGreaterThan(0);
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
    expect(
      screen
        .getByRole("link", { name: "Compare operating models" })
        .getAttribute("href"),
    ).toBe("/products");
    // next-steps/Decide/Next-Previous absence is centrally backstopped by the
    // auditedFeaturePages structural test below for all 14 feature slugs.
    expect(
      screen.queryByRole("link", { name: "Pricing and licensing" }),
    ).toBeNull();
    expect(
      screen.queryByRole("link", { name: "Compare CoCalc fit" }),
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

    // Hero marker = page identity anchor (route-canary equivalent).
    expect(
      screen.getByText("Jupyter notebooks for work that needs to keep going"),
    ).not.toBeNull();
    // Three durable-execution story cards exist — count, not prose.
    const storyRow = container.querySelector(".cocalc-jupyter-story-row");
    expect(storyRow).not.toBeNull();
    expect((storyRow as HTMLElement).querySelectorAll("h3")).toHaveLength(3);
    expect((storyRow as HTMLElement).querySelectorAll("h4")).toHaveLength(0);
    // Closing section identity without pinning the exact headline.
    expect(screen.getByText(/Choose the .*path that fits/i)).not.toBeNull();
    // Mock-UI output labels stay qualitative (never invented metrics).
    expect(screen.getByText("data loaded")).not.toBeNull();
    expect(screen.getByText("model summary ready")).not.toBeNull();
    expect(screen.queryByText("42,180 rows loaded")).toBeNull();
    expect(screen.queryByText("R^2 = 0.94")).toBeNull();
    // Agent details modal identity (aria contract).
    fireEvent.click(screen.getByRole("button", { name: "See agent details" }));
    expect(
      screen.getByRole("dialog", {
        name: "How Codex works with live notebooks",
      }),
    ).not.toBeNull();
    expect(container.querySelectorAll(".ant-tag")).toHaveLength(0);
    expect(new Set(getHeadingTexts(container)).size).toBe(
      getHeadingTexts(container).length,
    );
    // Routing canaries: /products operating-model link + the compatibility
    // documentation deep link.
    expect(
      screen
        .getByRole("link", { name: "Compare operating models" })
        .getAttribute("href"),
    ).toBe("/products");
    expect(
      screen
        .getByRole("link", { name: "Compatibility guide" })
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

    // Hero marker = page identity anchor.
    expect(
      screen.getByText(
        "Write the paper where the code, figures, and review live",
      ),
    ).not.toBeNull();
    // Route-specific body keyword (LaTeX writing loop) instead of pinned prose.
    expect(screen.getByText(/writing loop/i)).not.toBeNull();
    // Mock-UI label ban: the agent panel reads "AI review thread", not "Codex".
    expect(screen.queryByText("Codex review thread")).toBeNull();
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

    // Hero marker = page identity anchor.
    expect(
      screen.getByText("Teach where students compute, write, and collaborate"),
    ).not.toBeNull();
    // "Technical course workspace" is the section anchor reused below to scope
    // the doc/route links; it doubles as a presence check.
    expect(screen.getByText("Technical course workspace")).not.toBeNull();
    // Route-specific teaching body keyword (LMS / coursework split) instead of
    // pinning the exact marketing sentences.
    expect(screen.getAllByText(/LMS|coursework/i).length).toBeGreaterThan(0);
    // Mock-UI label stays qualitative, never an invented notebook count; and
    // the assignment panel stays light.
    expect(screen.getByText("nbgrader queue ready")).not.toBeNull();
    expect(screen.queryByText("nbgrader: 26 notebooks ready")).toBeNull();
    expect(
      container
        .querySelector(".cocalc-teaching-assignment-panel")
        ?.getAttribute("style") ?? "",
    ).not.toMatch(DARK_FEATURE_CARD_STYLE);
    // Closing section identity without pinning the headline.
    expect(screen.getByText(/Choose the .*path that fits/i)).not.toBeNull();
    // Planning-guides panel + teaching's own unauth CTA identity.
    expect(screen.getByText("Useful planning guides")).not.toBeNull();
    expect(screen.getByText("Use hosted CoCalc.ai")).not.toBeNull();
    expect(container.querySelectorAll(".ant-tag")).toHaveLength(0);
    // Documentation deep links (route canaries), scoped via the section anchor.
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
        .getByRole("link", { name: "Compare operating models" })
        .getAttribute("href"),
    ).toBe("/products");
    // Internal-language leakage: shared floor + teaching-surface-unique bans.
    expect(container.textContent ?? "").not.toMatch(
      combineLeak(
        INTERNAL_IMPLEMENTATION_TERMS,
        "Live computational classroom",
        "teaching center",
        "first minute",
        "strongest",
        "institutional shell",
      ),
    );
    // No invented external proof / testimonials.
    expect(container.innerHTML).not.toContain("cocalc.com/testimonials");
    expect(new Set(getHeadingTexts(container)).size).toBe(
      getHeadingTexts(container).length,
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

    // Hero marker = page identity anchor.
    expect(
      screen.getByText("A terminal is a live project document."),
    ).not.toBeNull();
    // Mock-UI label: the .term-file address line stays in the terminal mock.
    expect(
      screen.getAllByText("A .term file gives the shell an address").length,
    ).toBeGreaterThan(0);
    // Closing section identity without pinning the headline.
    expect(screen.getByText(/Choose the .*path that fits/i)).not.toBeNull();
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

    // Hero marker = page identity anchor.
    expect(
      screen.getByText("A Linux workspace you can actually administer."),
    ).not.toBeNull();
    // Route-specific Linux body keyword instead of pinning the exact prose.
    expect(
      screen.getAllByText(/administer|system packages|sudo/i).length,
    ).toBeGreaterThan(0);
    // Closing section identity without pinning the headline.
    expect(screen.getByText(/Choose the .*path that fits/i)).not.toBeNull();
    // Mock-UI label stays qualitative, never an invented version string.
    expect(screen.getByText("graphviz version reported")).not.toBeNull();
    expect(screen.queryByText("graphviz version 2.43.0")).toBeNull();
    // Linux-surface-unique leakage ban (root-filesystem implementation talk).
    expect(screen.queryByText(/root filesystem/i)).toBeNull();
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

    // Hero marker = page identity anchor.
    expect(
      screen.getByText("Python that moves from notebook to script to paper."),
    ).not.toBeNull();
    // Route-specific section keyword instead of pinned heading prose.
    expect(
      screen.getByText("The right interface at each stage"),
    ).not.toBeNull();
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

    // Hero marker = page identity anchor.
    expect(
      screen.getByText(
        "Whiteboards and slides for math, code, and collaboration.",
      ),
    ).not.toBeNull();
    // Route-specific section keyword (whiteboard runs Jupyter cells).
    expect(
      screen.getByText("Put Jupyter cells in a directed graph."),
    ).not.toBeNull();
    expect(
      screen.getByText("Slide decks stay close to the project."),
    ).not.toBeNull();
  });

  it.each([
    {
      contextLabels: ["Project context"],
      slug: "automations",
      title: "Turn recurring project workflows into repeatable runs.",
      section: "Automate the work, not just the request.",
    },
    {
      contextLabels: ["Course context", "Project context"],
      slug: "sage",
      title: "Use SageMath inside collaborative mathematics projects.",
      section: "Use Sage with the surrounding project.",
    },
    {
      contextLabels: ["Project context"],
      slug: "julia",
      title: "Use Julia in Pluto, Jupyter, and shared modeling projects.",
      section: "Keep Julia close to the rest of the research.",
    },
    {
      contextLabels: ["Project context"],
      slug: "r-statistical-software",
      title: "Use R for statistics and reproducible reporting.",
      section: "Keep R close to the rest of the analysis.",
    },
    {
      contextLabels: ["Project context"],
      slug: "octave",
      title:
        "Run GNU Octave with notebooks, .m files, and shared numerical work.",
      section: "Teach and run Octave without local setup drift.",
    },
    {
      contextLabels: ["Project context"],
      slug: "more-languages",
      title: "Use many other languages from the same project.",
      section: "Use the language that fits the project.",
    },
    {
      slug: "slides",
      title: "Present from the same canvas where technical ideas are built.",
      section: "How a deck comes together",
    },
  ])(
    "renders the richer $slug feature page",
    ({
      contextLabels,
      section,
      slug,
      title,
    }: {
      contextLabels?: string[];
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
      for (const label of contextLabels ?? []) {
        expect(screen.getByText(label)).not.toBeNull();
      }
      if (slug === "julia") {
        expect(
          screen.queryByRole("link", { name: "Ask about Julia workflows" }),
        ).toBeNull();
      }
    },
  );

  it("keeps compressed workflow pages from restoring duplicate card rows", () => {
    const pages = [
      {
        removedHeadings: [
          "Start from the project",
          "Give inspectable context",
          "Review before relying on it",
          "A sandbox for agent work, with humans nearby.",
        ],
        slug: "ai",
      },
      {
        removedHeadings: ["Trigger", "Run", "Record", "Review"],
        slug: "automations",
      },
      {
        removedHeadings: [
          "Run project commands",
          "Share one live stream",
          "Give agents terminal state",
          "When a terminal should be shared",
        ],
        slug: "terminal",
      },
      {
        removedHeadings: [
          "Install system packages",
          "Give everyone the same setup",
          "Save known-good environments",
          "When a project-local Linux environment matters",
        ],
        slug: "linux",
      },
      {
        removedHeadings: ["Scripts and modules", "Terminals"],
        slug: "python",
      },
      {
        removedHeadings: [
          "Recover draft history",
          "Use Codex as an editor and build assistant, not an author",
        ],
        slug: "latex-editor",
      },
      {
        removedHeadings: [
          "Explain with editable text",
          "Put math on the board",
          "Run cells when the diagram needs code",
        ],
        slug: "whiteboard",
      },
      {
        removedHeadings: [
          "Slide-sized pages",
          "Use math and live examples",
          "Edit with coauthors and instructors",
        ],
        slug: "slides",
      },
      {
        removedHeadings: [
          "Open mathematics",
          "Notebook first",
          "SageTeX included",
          "SageMath can be more than an interactive calculator.",
        ],
        slug: "sage",
      },
      {
        removedHeadings: ["R notebooks", "R in the shell", "Reports"],
        slug: "r-statistical-software",
      },
      {
        removedHeadings: [
          "Jupyter notebooks",
          "Normal Julia",
          "Pluto available",
        ],
        slug: "julia",
      },
      {
        removedHeadings: ["Notebooks", ".m files", "Teaching"],
        slug: "octave",
      },
      {
        removedHeadings: [
          "Compiled code",
          "Scripting and shell",
          "JVM and web",
          "Data workflows",
        ],
        slug: "more-languages",
      },
    ] as const;

    for (const { removedHeadings, slug } of pages) {
      const { unmount } = render(
        <PublicFeaturesApp
          config={{ help_email: "help@example.com", site_name: "Launchpad" }}
          initialRoute={{ slug, view: "detail" }}
        />,
      );

      for (const name of removedHeadings) {
        expect(screen.queryByRole("heading", { name })).toBeNull();
      }
      unmount();
    }
  });

  it.each([
    { finalCta: "Start using SageMath on CoCalc", slug: "sage" },
    { finalCta: "Create account", slug: "whiteboard" },
    { finalCta: "Start making slides", slug: "slides" },
    { finalCta: "Start using R", slug: "r-statistical-software" },
    { finalCta: "Start using Octave", slug: "octave" },
    { finalCta: "Start using Julia", slug: "julia" },
    { finalCta: "Start a workflow", slug: "automations" },
    { finalCta: "Start a project", slug: "more-languages" },
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

  it.each([
    "jupyter-notebook",
    "automations",
    "terminal",
    "linux",
    "python",
    "sage",
    "whiteboard",
    "slides",
    "r-statistical-software",
    "julia",
    "octave",
    "more-languages",
  ] as const)("keeps %s route-ending CTA panels light", (slug) => {
    const { container } = render(
      <PublicFeaturesApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ slug, view: "detail" }}
      />,
    );

    const panels = Array.from(
      container.querySelectorAll(".cocalc-feature-final-panel"),
    );
    expect(panels.length).toBeGreaterThan(0);
    for (const panel of panels) {
      expect(panel.getAttribute("style") ?? "").not.toMatch(
        DARK_FEATURE_CARD_STYLE,
      );
    }
  });

  it("uses the balanced final band on the Julia pilot page", () => {
    const { container } = render(
      <PublicFeaturesApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ slug: "julia", view: "detail" }}
      />,
    );

    expect(container.querySelector(".cocalc-feature-final-band")).not.toBeNull();
    expect(screen.getByText("When Julia belongs in CoCalc")).not.toBeNull();
    expect(screen.getByText("Related workflows")).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "Compare operating models" }),
    ).not.toBeNull();
  });

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
      if (slug === "cli") {
        expect(
          screen
            .getAllByRole("link", { name: "CLI Docs" })
            .map((link) => link.getAttribute("href")),
        ).toContain("/docs/cli/use-cocalc-cli");
        expect(
          screen.queryByRole("link", { name: "Create account" }),
        ).toBeNull();
        expect(screen.queryByRole("link", { name: "CLI guide" })).toBeNull();
        expect(
          screen.getByText("documented commands for project workflows"),
        ).not.toBeNull();
        expect(screen.getByText("reviewable notebook workflow")).not.toBeNull();
        expect(screen.getByText("Read project context")).not.toBeNull();
        expect(screen.getByText("Run bounded actions")).not.toBeNull();
        expect(screen.getByText("Return reviewable output")).not.toBeNull();
        expect(
          screen.getByRole("img", {
            name: "CoCalc CLI project workflow example",
          }),
        ).not.toBeNull();
        expect(
          screen.getByText("$ cocalc browser files --project-id PROJECT_ID"),
        ).not.toBeNull();
        expect(
          screen.getByText(
            "$ cocalc project jupyter exec --path analysis.ipynb --stdin",
          ),
        ).not.toBeNull();
        expect(
          screen.queryByText(
            /Phase 0|RootFS|Conat|bay|practical bridge|typed surface|run and report/i,
          ),
        ).toBeNull();
      }
      expect(container.querySelectorAll(".ant-tag")).toHaveLength(0);
      expect(container.textContent ?? "").not.toMatch(INTERNAL_CONTEXT_LEAKAGE);
      expect(container.textContent ?? "").not.toMatch(
        /42,180 rows loaded|R\^2 = 0\.94|26 notebooks ready|graphviz version 2\.43\.0|0 errors|2 warnings|installed 12 packages|resolved 18 packages|3 passed|14 iterations|\bRootFS\b|\bOverleaf\b|\bRStudio\b|\bPosit\b|\bMathematica\b|\bMaple\b|MATLAB-style|every MATLAB workflow|spot instances|stable programmatic interface|stable way to automate|stable route/i,
      );

      const headings = Array.from(
        container.querySelectorAll("main h2, main h3, main h4"),
      )
        .map((heading) => heading.textContent?.replace(/\s+/g, " ").trim())
        .filter((heading): heading is string => !!heading);
      expect(new Set(headings).size).toBe(headings.length);
      expect(container.querySelectorAll("main h4")).toHaveLength(0);

      // Design guardrail: primary-CTA emphasis stays sane — the main action may
      // repeat hero+close, but flag 3+ repeats or multiple repeated primaries.
      expectPrimaryCtaEmphasisSane(
        container.querySelector("main") as HTMLElement,
      );

      // Design guardrail: no empty headings and no skipped heading levels.
      expectHeadingHierarchy(container.querySelector("main") as HTMLElement);

      // Design guardrail: prose density — no body paragraph is a wall of text.
      expectProseDensity(container.querySelector("main") as HTMLElement, {
        maxChars: 390,
      });

      // Design guardrail: every inline-sized paragraph uses a PUBLIC_TYPE size.
      expectTextSizesOnScale(container.querySelector("main") as HTMLElement);

      const nextSteps = screen.queryByRole("region", {
        name: "Feature operating model next steps",
      });
      expect(
        screen
          .getAllByRole("link")
          .some((link) => link.getAttribute("href") === "/products"),
      ).toBe(true);
      expect(nextSteps).toBeNull();
      expect(screen.queryByText("Decide how CoCalc should run")).toBeNull();
      expect(screen.queryByRole("link", { name: /Next feature:/ })).toBeNull();
      expect(
        screen.queryByRole("link", { name: /Previous feature:/ }),
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

    // The page is the HTTP integration API — it routes to the HTTP API docs,
    // not a CLI page (the distinction is structural, not a pinned copy line).
    // One (not duplicated) "API documentation" CTA, in the hero.
    expect(
      screen
        .getAllByRole("link", { name: "API documentation" })
        .map((link) => link.getAttribute("href")),
    ).toEqual(["/docs/api/http-api"]);
    expect(
      screen
        .getAllByRole("link", { name: "Compare operating models" })
        .map((link) => link.getAttribute("href")),
    ).toContain("/products");
    const askLinks = screen.getAllByRole("link", {
      name: "Ask about API integration",
    });
    expect(askLinks).toHaveLength(1);
    expect(askLinks[0].getAttribute("href")).toContain("/support/new?");
    expect(askLinks[0].getAttribute("href")).toContain("context=feature-api");
  });

  it("keeps the Automations page distinct from the HTTP API page", () => {
    render(
      <PublicFeaturesApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ slug: "automations", view: "detail" }}
      />,
    );

    expect(
      screen.getByText(
        "Turn recurring project workflows into repeatable runs.",
      ),
    ).not.toBeNull();
    expect(
      screen.queryByRole("link", { name: "API documentation" }),
    ).toBeNull();
    expect(
      screen.getByRole("link", { name: "HTTP API" }).getAttribute("href"),
    ).toBe("/features/api");
    const askLinks = screen.getAllByRole("link", {
      name: "Ask about project automations",
    });
    expect(askLinks).toHaveLength(1);
    expect(askLinks[0].getAttribute("href")).toContain(
      "context=feature-automations",
    );
  });

  it("renders the compare feature page", () => {
    const { container } = render(
      <PublicFeaturesApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ slug: "compare", view: "detail" }}
      />,
    );

    // Compare-page section identity via keyword + heading uniqueness instead
    // of pinning each exact headline; the two-sided "fits when" decision is the
    // load-bearing structure (its panel/row counts are held by the scannable
    // test below).
    const compareHeadings = getHeadingTexts(container, "h1, h2, h3, h4");
    expect(new Set(compareHeadings).size).toBe(compareHeadings.length);
    expect(textLength(container.querySelector("h2")!)).toBeLessThanOrEqual(
      SECTION_H2_MAX,
    );
    expect(
      screen.getByText(
        /Evaluate CoCalc when notebooks, code, terminals, documents, outputs, TimeTravel history/i,
      ),
    ).not.toBeNull();
    expect(
      screen.getByText(/Best fit: multi-artifact projects/i),
    ).not.toBeNull();
    expect(
      screen
        .getAllByRole("link", { name: "Compare operating models" })
        .map((link) => link.getAttribute("href")),
    ).toEqual(["/products", "/products"]);
    expect(
      screen.queryByRole("link", { name: "Pricing and licensing" }),
    ).toBeNull();
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
    ).toEqual(expect.stringContaining("/support/new?"));
    expect(
      screen
        .getByRole("link", { name: "Talk with CoCalc" })
        .getAttribute("href"),
    ).toEqual(expect.stringContaining("context=feature-compare"));
    expect(
      screen
        .getByRole("link", { name: "Talk with CoCalc" })
        .getAttribute("href"),
    ).toEqual(expect.stringContaining("type=purchase"));
    expect(
      screen
        .getByRole("link", { name: "Talk with CoCalc" })
        .getAttribute("href"),
    ).not.toContain("mailto:");
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
    expect(
      screen.getByRole("table", {
        name: "CoCalc compare decision rows",
      }),
    ).not.toBeNull();
    expect(
      screen.getByRole("columnheader", { name: "Decision question" }),
    ).not.toBeNull();
    expect(
      screen.getByRole("columnheader", { name: "Choose CoCalc when" }),
    ).not.toBeNull();
    expect(
      screen.getByRole("columnheader", {
        name: "Choose a lighter tool when",
      }),
    ).not.toBeNull();
    expect(container.textContent ?? "").not.toMatch(
      /These comparisons are intentionally high level|How CoCalc compares by category|Google Colab|Deepnote|narrower point solution|product ladder|card wall|Use CoCalc when/i,
    );
  });

  it("adds compare-page trust materials only when built-in policies are public", () => {
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
        .getByRole("link", { name: "Review trust materials" })
        .getAttribute("href"),
    ).toBe("/policies/trust");
    expect(screen.getByText("Trust and privacy review")).not.toBeNull();
    expect(
      screen.getByText(
        /Published trust materials for evaluators who need security, privacy, or procurement context/,
      ),
    ).not.toBeNull();
    expect(screen.queryByText(/Security, SOC 2, GDPR/)).toBeNull();
  });

  it("keeps the compare page scannable and route-focused", () => {
    const { container } = render(
      <PublicFeaturesApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ slug: "compare", view: "detail" }}
      />,
    );

    const decisionTable = screen.getByRole("table", {
      name: "CoCalc compare decision rows",
    });
    const decisionRows = Array.from(
      decisionTable.querySelectorAll(".cocalc-compare-row"),
    );

    expect(
      container.querySelectorAll(".cocalc-compare-decision-panel"),
    ).toHaveLength(0);
    expect(decisionRows).toHaveLength(5);
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
    for (const row of decisionRows) {
      expect(textLength(row)).toBeLessThanOrEqual(310);
    }

    const css = Array.from(container.querySelectorAll("style"))
      .map((style) => style.textContent ?? "")
      .join("\n");
    expect(css).toContain(".cocalc-compare-hero");
    expect(css).toContain(".cocalc-compare-checklist");
    expect(css).toContain(".cocalc-compare-table");
    expect(css).toContain("@media (max-width: 900px)");
    expect(css).toContain("@media (max-width: 560px)");

    expect(container.textContent ?? "").not.toMatch(INTERNAL_CONTEXT_LEAKAGE);
  });
});
