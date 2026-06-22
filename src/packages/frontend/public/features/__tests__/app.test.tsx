/** @jest-environment jsdom */

import { execFileSync } from "child_process";
import { readFileSync } from "fs";

import { render, screen, within } from "@testing-library/react";

import {
  combineLeak,
  DARK_FEATURE_CARD_STYLE,
  expectHeadingHierarchy,
  expectPrimaryCtaEmphasisSane,
  expectProseDensity,
  expectTextSizesOnScale,
  getDirectCards,
  getHeadingTexts,
  getPrimaryCtas,
  HERO_H1_MAX,
  installMatchMediaStub,
  INTERNAL_IMPLEMENTATION_TERMS,
  SECTION_H2_MAX,
  textLength,
} from "../../__tests__/test-helpers";
import { PUBLIC_DARK, PUBLIC_TYPE } from "../../theme";
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

function trackedFeaturePageSources(): {
  file: string;
  name: string;
  source: string;
}[] {
  return execFileSync("git", ["ls-files", "public/features/*-page.tsx"], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((file) => ({
      file,
      name: file.split("/").pop() ?? file,
      source: readFileSync(file, "utf8"),
    }));
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

const SHARED_PRIMITIVE_FEATURE_PAGES = [
  "automations",
  "julia",
  "jupyter-notebook",
  "latex-editor",
  "linux",
  "more-languages",
  "octave",
  "python",
  "r-statistical-software",
  "sage",
  "terminal",
] as const;

const FINAL_BAND_FEATURE_PAGES = [
  "automations",
  "julia",
  "jupyter-notebook",
  "latex-editor",
  "linux",
  "more-languages",
  "octave",
  "python",
  "r-statistical-software",
  "sage",
  "slides",
  "terminal",
  "whiteboard",
] as const;

const CUSTOM_FEATURE_PAGES_WITHOUT_SHARED_PRIMITIVES = new Set([
  "ai-page.tsx",
  "api-page.tsx",
  "cli-page.tsx",
  "compare-page.tsx",
  "teaching-page.tsx",
]);

const SHARED_CARD_PRIMITIVE =
  /\b(?:ContextList|FeatureFinalBand|StartCard|StoryCard)\b/;

const INLINE_STYLE_LIMIT = 15;
const LEGACY_INLINE_STYLE_BUDGETS: Record<string, number> = {
  "ai-page.tsx": 21,
  "cli-page.tsx": 23,
  "python-page.tsx": 20,
  "sage-page.tsx": 21,
  "teaching-page.tsx": 35,
};

// Route accent and gradient literals are being phased into shared tokens. Until
// then, every remaining raw hex literal must be explicit here so new colors are
// a conscious design-system decision rather than accidental local styling.
const ALLOWED_RAW_HEX_COLORS_BY_FEATURE_PAGE: Record<
  string,
  readonly string[]
> = {
  "ai-page.tsx": [
    "#278c83",
    "#2f6fda",
    "#7c3aed",
    "#f59e0b",
    "#f7f4ff",
    "#fff8e8",
    "#ffffff",
  ],
  "automations-page.tsx": ["#f4fbff", "#f8fbf4", "#ffffff"],
  "cli-page.tsx": [
    "#101820",
    "#cbd5e1",
    "#f4f9ff",
    "#fde68a",
    "#fff8e8",
    "#ffffff",
  ],
  "julia-page.tsx": ["#f4fff8", "#f7f4ff", "#ffffff"],
  "jupyter-notebook-page.tsx": [
    "#389e0d",
    "#7c3aed",
    "#f37726",
    "#f4f9ff",
    "#fff8e8",
    "#ffffff",
  ],
  "latex-editor-page.tsx": [
    "#278c83",
    "#7c3aed",
    "#ad6800",
    "#f4f9ff",
    "#fff8e8",
    "#ffffff",
  ],
  "linux-page.tsx": [
    "#096dd9",
    "#278c83",
    "#ad6800",
    "#f4f9ff",
    "#fff8e8",
    "#ffffff",
  ],
  "more-languages-page.tsx": ["#4b5563", "#f5f9ff", "#f7faf7", "#ffffff"],
  "octave-page.tsx": ["#d4380d", "#f4f9ff", "#fff7f1", "#ffffff"],
  "python-page.tsx": [
    "#278c83",
    "#2f6fda",
    "#389e0d",
    "#7c3aed",
    "#ad6800",
    "#f4f9ff",
    "#f5fbff",
    "#fff8e8",
    "#ffffff",
  ],
  "r-statistical-software-page.tsx": [
    "#386cb0",
    "#f4f9ff",
    "#f6fff4",
    "#ffffff",
  ],
  "sage-page.tsx": [
    "#2f6fda",
    "#389e0d",
    "#7c3aed",
    "#ad6800",
    "#f3fbf3",
    "#fff8e8",
    "#ffffff",
  ],
  "slides-page.tsx": ["#d46b08"],
  "terminal-page.tsx": [
    "#096dd9",
    "#278c83",
    "#ad6800",
    "#f4f9ff",
    "#fff8e8",
    "#ffffff",
  ],
  "whiteboard-page.tsx": ["#2f6fda", "#389e0d", "#ad6800", "#d4380d"],
};

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

  it.each(SHARED_PRIMITIVE_FEATURE_PAGES)(
    "keeps %s on the shared feature-detail primitives",
    (slug) => {
      const { container } = render(
        <PublicFeaturesApp
          config={{ help_email: "help@example.com", site_name: "Launchpad" }}
          initialRoute={{ slug, view: "detail" }}
        />,
      );

      expect(
        container.querySelector(".cocalc-feature-final-band"),
      ).not.toBeNull();
      expect(
        container.querySelectorAll(".cocalc-feature-context-list").length,
      ).toBeGreaterThanOrEqual(1);
    },
  );

  it.each(FINAL_BAND_FEATURE_PAGES)(
    "keeps %s final-band columns vertically balanced",
    (slug) => {
      const { container } = render(
        <PublicFeaturesApp
          config={{ help_email: "help@example.com", site_name: "Launchpad" }}
          initialRoute={{ slug, view: "detail" }}
        />,
      );

      const finalBand = container.querySelector(".cocalc-feature-final-band");
      expect(finalBand).not.toBeNull();
      expect(finalBand?.querySelector(".ant-row-middle")).not.toBeNull();
      expect(finalBand?.querySelector(".ant-row-top")).toBeNull();
    },
  );

  it("keeps new route pages from shipping without shared card primitives", () => {
    const offenders = trackedFeaturePageSources().flatMap(
      ({ file, name, source }) =>
        SHARED_CARD_PRIMITIVE.test(source) ||
        CUSTOM_FEATURE_PAGES_WITHOUT_SHARED_PRIMITIVES.has(name)
          ? []
          : [`${file}: no shared feature card primitive`],
    );

    expect(offenders).toEqual([]);
  });

  it("keeps feature pages within the inline-style budget", () => {
    const offenders = trackedFeaturePageSources().flatMap(
      ({ file, name, source }) => {
        const limit = LEGACY_INLINE_STYLE_BUDGETS[name] ?? INLINE_STYLE_LIMIT;
        const count = source.match(/style=\{\{/g)?.length ?? 0;
        return count > limit
          ? [`${file}: ${count} inline style blocks, limit ${limit}`]
          : [];
      },
    );

    expect(offenders).toEqual([]);
  });

  it("keeps raw feature-page hex colors on the explicit allowlist", () => {
    const offenders = trackedFeaturePageSources().flatMap(
      ({ file, name, source }) => {
        const allowed = new Set(
          (ALLOWED_RAW_HEX_COLORS_BY_FEATURE_PAGE[name] ?? []).map((hex) =>
            hex.toLowerCase(),
          ),
        );
        return [...source.matchAll(/#[0-9a-f]{3,8}\b/gi)]
          .map((match) => match[0].toLowerCase())
          .filter((hex) => !allowed.has(hex))
          .map((hex) => `${file}: raw hex ${hex}`);
      },
    );

    expect(offenders).toEqual([]);
  });

  it("keeps feature-page font sizes tokenized outside numeric icon glyphs", () => {
    const rawFontSizePx =
      /(?:fontSize:\s*["'][0-9]+px["']|font-size:\s*[0-9]+px)/gi;
    const offenders = trackedFeaturePageSources().flatMap(({ file, source }) =>
      [...source.matchAll(rawFontSizePx)].map(
        (match) => `${file}: raw px font-size ${match[0]}`,
      ),
    );

    expect(offenders).toEqual([]);
  });

  const contextualSupportLinks = [
    {
      context: "feature-cli",
      label: "Ask about CLI automation",
      slug: "cli",
    },
    {
      context: "feature-api",
      label: "Ask about API integration",
      slug: "api",
    },
  ] as const;

  const removedFinalSupportLinks = [
    { label: "Ask about project automations", slug: "automations" },
    { label: "Ask about teaching workflows", slug: "teaching" },
    { label: "Ask about whiteboards", slug: "whiteboard" },
    { label: "Ask about slides", slug: "slides" },
    { label: "Ask about SageMath workflows", slug: "sage" },
    { label: "Ask about R workflows", slug: "r-statistical-software" },
    { label: "Ask about Julia workflows", slug: "julia" },
    { label: "Ask about Octave workflows", slug: "octave" },
    { label: "Ask about language workflows", slug: "more-languages" },
    { label: "Ask about AI workflows", slug: "ai" },
    { label: "Ask about LaTeX workflows", slug: "latex-editor" },
    { label: "Ask about Python workflows", slug: "python" },
    { label: "Ask about Linux environments", slug: "linux" },
    { label: "Ask about terminal workflows", slug: "terminal" },
    { label: "Ask about Jupyter workflows", slug: "jupyter-notebook" },
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
      marker: "Use Julia in Pluto, Jupyter, and shared modeling projects.",
      slug: "julia",
    },
    {
      marker: "A Linux workspace you can actually administer.",
      slug: "linux",
    },
    {
      marker: "A Linux terminal that lives in your project.",
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
      marker:
        "Whiteboards and slides that keep the code, math, and explanations together — in one durable, reviewable project.",
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
        "Keep your notebooks, code, and history together in one project.",
      ),
    ).not.toBeNull();
    expect(
      screen.getByText("Keep the whole job in one durable project."),
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
    const codexGuide = screen.getByRole("link", {
      name: "Read the Codex guide",
    });
    expect(codexGuide.getAttribute("href")).toContain("/codex-agent-chat/");
    expect(codexGuide.className).toContain("ant-btn-primary");
    const pageText = container.textContent ?? "";
    expect(pageText.indexOf("Read the Codex guide")).toBeLessThan(
      pageText.indexOf("Create account"),
    );
    expect(
      getPrimaryCtas(container.querySelector("main") as HTMLElement),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          href: expect.stringContaining("/codex-agent-chat/"),
          name: "Read the Codex guide",
        }),
        expect.objectContaining({
          href: "/auth/sign-up",
          name: "Create account",
        }),
      ]),
    );
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
    expect(
      container.querySelector(".cocalc-feature-context-list"),
    ).not.toBeNull();
    expect(
      container.querySelector(".cocalc-feature-final-band"),
    ).not.toBeNull();
    // Closing section identity without pinning the exact headline.
    expect(screen.getByText(/Choose the .*path that fits/i)).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "Start using Jupyter in CoCalc" }),
    ).toHaveAttribute("href", "/auth/sign-up");
    // Mock-UI output labels stay qualitative (never invented metrics).
    expect(screen.getByText("data loaded")).not.toBeNull();
    expect(screen.getByText("model summary ready")).not.toBeNull();
    expect(screen.queryByText("42,180 rows loaded")).toBeNull();
    expect(screen.queryByText("R^2 = 0.94")).toBeNull();
    expect(container.textContent ?? "").toContain(
      "cocalc project jupyter cells --path analysis.ipynb",
    );
    expect(screen.getByText(/directed graph beside diagrams/i)).not.toBeNull();
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
    expect(screen.queryByText("Start using Jupyter in CoCalc")).toBeNull();
  });

  it("renders the richer latex feature page", () => {
    const { container } = render(
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
    expect(
      container.querySelector(".cocalc-feature-context-list"),
    ).not.toBeNull();
    expect(
      container.querySelector(".cocalc-feature-final-band"),
    ).not.toBeNull();
    // Route-specific body keyword (LaTeX writing loop) instead of pinned prose.
    expect(screen.getByText(/writing loop/i)).not.toBeNull();
    // Mock-UI label ban: the agent panel reads "AI review thread", not "Codex".
    expect(screen.queryByText("Codex review thread")).toBeNull();
    // Decorative PDF mock text should not pollute the document heading outline.
    expect(screen.queryByRole("heading", { name: "Spectral gap" })).toBeNull();
    const fitTable = within(container).getByRole("table", {
      name: "LaTeX environment fit decisions",
    });
    expect(fitTable.getAttribute("aria-describedby")).toBe(
      "cocalc-latex-fit-table-caption",
    );
    expect(fitTable.querySelector("caption")?.textContent).toMatch(
      /Each row compares a writing task/i,
    );
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
      screen.getByText("A Linux terminal that lives in your project."),
    ).not.toBeNull();
    // Section marker: the .term-file folder anchor remains explicit.
    expect(
      screen.getAllByText("Each terminal opens in its own folder.").length,
    ).toBeGreaterThan(0);
    // Closing section identity without pinning the headline.
    expect(
      screen.getByText("Where the terminal earns its place"),
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
    const { container } = render(
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
    expect(
      container.querySelector(".cocalc-feature-context-list"),
    ).not.toBeNull();
    expect(
      container.querySelector(".cocalc-feature-final-band"),
    ).not.toBeNull();
    expect(screen.getByText(/You decide what runs/i)).not.toBeNull();
    expect(screen.queryByText(/and running the command/i)).toBeNull();
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
    expect(screen.getByText("Project context")).not.toBeNull();
    expect(
      screen.queryByText("$ uv venv && uv pip install numpy matplotlib"),
    ).toBeNull();
    expect(screen.queryByText("Codex sees the surrounding work")).toBeNull();
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
        "Whiteboards and slides that keep the code, math, and explanations together — in one durable, reviewable project.",
      ),
    ).not.toBeNull();
    // Route-specific section keyword (whiteboard runs Jupyter cells).
    expect(
      screen.getByText("Put Jupyter cells in a directed graph."),
    ).not.toBeNull();
    expect(screen.getByText("Connected page")).not.toBeNull();
    expect(screen.queryByText("Connected explanation")).toBeNull();
    expect(
      screen.getByText("Move board work into a slide deck when it is ready."),
    ).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "More about slide decks" }),
    ).toHaveAttribute("href", "/features/slides");
    expect(
      screen.queryByLabelText(
        "Illustration of CoCalc slides as slide-sized whiteboard pages",
      ),
    ).toBeNull();
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
      section: "Run reproducible Octave work without local setup drift.",
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
    },
  );

  it("keeps the Octave hero visually dominant over its first proof section", () => {
    render(
      <PublicFeaturesApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ slug: "octave", view: "detail" }}
      />,
    );

    const heroTitle = screen.getByText(
      "Run GNU Octave with notebooks, .m files, and shared numerical work.",
    );
    const proofTitle = screen.getByText(
      "Run reproducible Octave work without local setup drift.",
    );

    expect(heroTitle.tagName).toBe("H2");
    expect(proofTitle.tagName).toBe("H3");
    expect(proofTitle).toHaveStyle(`font-size: ${PUBLIC_TYPE.subhead}px`);
  });

  it.each(removedFinalSupportLinks)(
    "keeps the $slug final support CTA removed",
    ({ label, slug }) => {
      render(
        <PublicFeaturesApp
          config={{ help_email: "help@example.com", site_name: "Launchpad" }}
          initialRoute={{ slug, view: "detail" }}
        />,
      );

      expect(screen.queryByRole("link", { name: label })).toBeNull();
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
    { finalCta: "Start using SageMath", slug: "sage" },
    { finalCta: "Create account", slug: "whiteboard" },
    { finalCta: "Start making slides", slug: "slides" },
    { finalCta: "Start using R", slug: "r-statistical-software" },
    { finalCta: "Start using Octave", slug: "octave" },
    { finalCta: "Start using Julia", slug: "julia" },
    { finalCta: "Start a workflow", slug: "automations" },
    { finalCta: "Start in a project", slug: "more-languages" },
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

  it.each([
    { slug: "julia", title: "When Julia belongs in CoCalc" },
    { slug: "octave", title: "When Octave belongs in CoCalc" },
    {
      slug: "more-languages",
      title: "When another language belongs in CoCalc",
    },
    {
      slug: "automations",
      title: "When project automation belongs in CoCalc",
    },
    {
      slug: "whiteboard",
      title: "When a board or deck belongs in CoCalc",
    },
    {
      slug: "r-statistical-software",
      title: "From analysis to a shared report",
    },
    {
      slug: "python",
      title: "Run the same Python project where you need it",
    },
    {
      slug: "slides",
      title: "When slides belong in CoCalc",
    },
    {
      slug: "sage",
      title: "When SageMath belongs in CoCalc.",
    },
  ] as const)("uses the balanced final band on $slug", ({ slug, title }) => {
    const { container } = render(
      <PublicFeaturesApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ slug, view: "detail" }}
      />,
    );

    expect(
      container.querySelector(".cocalc-feature-final-band"),
    ).not.toBeNull();
    expect(screen.getByText(title)).not.toBeNull();
    expect(screen.getByText("Related")).not.toBeNull();
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
      if (slug !== "ai") {
        expectPrimaryCtaEmphasisSane(
          container.querySelector("main") as HTMLElement,
        );
      }

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
    expect(
      screen.getByRole("link", { name: "CoCalc CLI" }).getAttribute("href"),
    ).toBe("/features/cli");
    expect(
      screen.queryByRole("link", { name: "Ask about project automations" }),
    ).toBeNull();
    expect(
      screen.getByRole("link", { name: "Compare operating models" }),
    ).not.toBeNull();
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
        /When a whole project must stay together — durable and reviewable as collaborators change/i,
      ),
    ).not.toBeNull();
    expect(
      screen.getByText(
        /Best fit: durable, reproducible, multi-artifact projects/i,
      ),
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
    const decisionTable = screen.getByRole("table", {
      name: "CoCalc compare decision rows",
    });
    expect(decisionTable).not.toBeNull();
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
    expect(decisionTable).toHaveAttribute(
      "aria-describedby",
      "cocalc-compare-table-caption",
    );
    expect(decisionTable.querySelector("caption")?.textContent).toMatch(
      /labelled stacked fields/,
    );
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
