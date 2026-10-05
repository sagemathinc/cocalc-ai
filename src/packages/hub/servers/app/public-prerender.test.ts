import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DOLLAR_AMOUNT,
  INTERNAL_IMPLEMENTATION_TERMS,
  OVERPROMISE_TERMS,
  STALE_AGENT_PHRASES,
  UNSUPPORTED_CAPABILITY_TERMS,
} from "@cocalc/util/public-copy-guards";
import {
  getPublicFeaturePage,
  PUBLIC_FEATURE_PAGES,
} from "@cocalc/util/public-feature-pages";
import type { PublicPricingTier } from "@cocalc/util/public-pricing";
import {
  buildPublicSitemapPaths,
  getPublicMetadataRouteFromPath,
  getPublicRouteMetadata,
} from "@cocalc/util/public-site-metadata";
import { renderPublicRoutePrerender } from "./public-prerender";
import type { PublicRoutePrerenderData } from "./public-prerender";
import {
  PUBLIC_HOME_EYEBROW,
  PUBLIC_HOME_HEADLINE,
  PUBLIC_HOME_HIGHLIGHTS,
  PUBLIC_HOME_INTRO,
  PUBLIC_HOME_SECONDARY_CTA,
  PUBLIC_HOME_TRUST_LINE,
} from "@cocalc/util/public-home-content";
import {
  getPublicFeaturesTasks,
  PUBLIC_FEATURES_EYEBROW,
  PUBLIC_FEATURES_HEADLINE,
} from "@cocalc/util/public-features-index";

describe("public feature initial HTML", () => {
  it.each(["/prefix", "/docs"])(
    "keeps research documentation links on deployment %s",
    (basePath) => {
      const page = getPublicFeaturePage("research-compute")!;
      const html = renderPublicRoutePrerender(
        { section: "features", route: { view: "detail", slug: page.slug } },
        basePath,
        { cocalc_product: "launchpad" },
      );

      expect(html).toContain('data-cocalc-public-prerender="feature"');
      for (const section of page.sections ?? []) {
        for (const link of section.links ?? []) {
          expect(html).toContain(`href="${basePath}${link.href}"`);
        }
      }
      expect(html).not.toContain('href="/docs/hosts/');
      expect(html).toContain(`href="${basePath}/auth/sign-up"`);
    },
  );

  it.each(["/", "/prefix"])(
    "renders the terminal record that the React page renders, on %s",
    (basePath) => {
      const page = getPublicFeaturePage("terminal")!;
      // On cocalc.ai, which shows the record's sign-up label.
      const html = renderPublicRoutePrerender(
        { section: "features", route: { view: "detail", slug: page.slug } },
        basePath,
        { cocalc_product: "launchpad", dns: "cocalc.ai" },
      );

      expect(page.highlights).toHaveLength(4);
      expect(page.sections).toHaveLength(4);
      for (const text of [
        page.tagline,
        page.summary,
        ...page.highlights!.map((highlight) => `<li>${highlight}</li>`),
        ...page.sections!.flatMap(({ paragraphs, title }) => [
          `<h2>${title}</h2>`,
          ...paragraphs!,
        ]),
      ]) {
        expect(html).toContain(text);
      }
      const prefix = basePath === "/" ? "" : basePath;
      const links = page.sections!.flatMap(({ links }) => links ?? []);
      expect(links.map(({ href }) => href)).toEqual([
        "/docs/terminal/use-terminal",
        "/features/software-environment",
      ]);
      for (const { href, label } of links) {
        expect(html).toContain(`href="${prefix}${href}">${label}</a>`);
      }
      // The React page's sign-up label, not the generic one.
      expect(page.signUpLabel).toBe("Start on CoCalc.ai");
      expect(html).toContain(
        `href="${prefix}/auth/sign-up">${page.signUpLabel}</a>`,
      );
      expect(html).not.toContain("Start using CoCalc");
      expect(html).not.toContain("terminal.png");
    },
  );
});

describe("home first screen initial HTML", () => {
  // cocalc.ai's /customize reports the Launchpad product, so the cocalc.ai
  // cases do too: a rule that left out Launchpad would fail them.
  const cocalcAi = {
    cocalc_product: "launchpad",
    dns: "cocalc.ai",
    is_launchpad: true,
    site_name: "CoCalc",
  };

  // The React page renders the same constants (frontend/public/home tests),
  // so crawlers read the first screen word for word.
  it.each(["/", "/prefix"])(
    "renders the first screen from the shared Home content on %s",
    (basePath) => {
      const prefix = basePath === "/" ? "" : basePath;
      const html = renderPublicRoutePrerender(
        { section: "home" },
        basePath,
        cocalcAi,
      );
      const header = html.slice(
        html.indexOf("<header>"),
        html.indexOf("</header>"),
      );
      const texts = [...header.matchAll(/<(p|h1|li)>([^<]+)<\/\1>/g)].map(
        ([, tag, text]) => `${tag}: ${text}`,
      );

      expect(texts).toEqual([
        `p: ${PUBLIC_HOME_EYEBROW}`,
        `h1: ${PUBLIC_HOME_HEADLINE}`,
        `p: ${PUBLIC_HOME_INTRO}`,
        ...PUBLIC_HOME_HIGHLIGHTS.map((highlight) => `li: ${highlight}`),
        `p: ${PUBLIC_HOME_TRUST_LINE}`,
      ]);
      expect(header).toContain(
        `<a href="${prefix}/auth/sign-up">Start on CoCalc.ai</a> <a href="${prefix}/${PUBLIC_HOME_SECONDARY_CTA.href}">${PUBLIC_HOME_SECONDARY_CTA.label}</a>`,
      );
    },
  );

  // The first three sites and their chips match the React test in
  // frontend/public/home/__tests__/app.test.tsx, so the two renderings agree.
  const withClaude = [
    "Codex and Claude Code in one project",
    "Collaborators see edits live",
    "Restore earlier versions",
  ];
  const withoutClaude = [
    "Collaborators see edits live",
    "Restore earlier versions",
  ];
  it.each([
    ["the default CoCalc brand on cocalc.ai", cocalcAi, withClaude],
    [
      "CoCalc Plus, the local one-user runtime",
      { cocalc_product: "plus", dns: "localhost", site_name: "CoCalc" },
      ["Restore earlier versions"],
    ],
    [
      "CoCalc Plus on the canonical host",
      { cocalc_product: "plus", dns: "cocalc.ai", site_name: "CoCalc" },
      ["Restore earlier versions"],
    ],
    [
      "a self-hosted Launchpad host",
      {
        cocalc_product: "launchpad",
        dns: "launchpad.example.edu",
        is_launchpad: true,
        site_name: "CoCalc Launchpad",
      },
      withoutClaude,
    ],
    [
      "a custom logo on cocalc.ai",
      { ...cocalcAi, logo_square: "https://example.edu/logo.png" },
      withoutClaude,
    ],
    [
      "a custom site name on cocalc.ai",
      { ...cocalcAi, site_name: "University CoCalc" },
      withoutClaude,
    ],
    [
      "a cocalc.ai subdomain",
      { ...cocalcAi, dns: "dev.cocalc.ai" },
      withoutClaude,
    ],
    ["no site configuration", undefined, withoutClaude],
  ])(
    "shows only the highlights that hold on each site: %s",
    (_site, config, expected) => {
      const html = renderPublicRoutePrerender({ section: "home" }, "/", config);
      const header = html.slice(
        html.indexOf("<header>"),
        html.indexOf("</header>"),
      );
      expect(
        [...header.matchAll(/<li>([^<]+)<\/li>/g)].map(([, text]) => text),
      ).toEqual(expected);
    },
  );
});

describe("features index first screen initial HTML", () => {
  // The React index renders the same records
  // (frontend/public/features/__tests__/index-first-screen.test.tsx).
  const tools = "and tools such as Jupyter, LaTeX, R, Julia, and SageMath.";
  const hosted = `Codex agents, the CoCalc CLI, installed software, compute options, ${tools}`;
  const cocalcAi = {
    cocalc_product: "launchpad",
    dns: "cocalc.ai",
    is_launchpad: true,
    site_name: "CoCalc",
  };
  it.each([
    ["cocalc.ai", cocalcAi, "/", hosted, "Start on CoCalc.ai", 4],
    [
      "a Rocket site",
      { cocalc_product: "rocket", dns: "cocalc.example.edu" },
      "/prefix",
      hosted,
      "Create account",
      4,
    ],
    [
      "a customer-operated Launchpad site",
      {
        cocalc_product: "launchpad",
        dns: "lp.example.org",
        site_name: "CoCalc Launchpad",
      },
      "/",
      hosted,
      "Create account",
      4,
    ],
    [
      "CoCalc Plus",
      { cocalc_product: "plus", dns: "localhost" },
      "/",
      "Codex agents and the software installed on your computer.",
      undefined,
      1,
    ],
    [
      "no site configuration",
      undefined,
      "/",
      `Codex agents, the CoCalc CLI, installed software, ${tools}`,
      undefined,
      3,
    ],
  ])(
    "renders the shared first screen on %s",
    (site, config, basePath, items, signUp, taskCount) => {
      const prefix = basePath === "/" ? "" : basePath;
      const html = renderPublicRoutePrerender(
        { section: "features", route: { view: "index" } },
        basePath,
        config,
      );
      const firstScreen = html.slice(0, html.indexOf("</ul>") + 5);
      const signUpLink = signUp
        ? `<a href="${prefix}/auth/sign-up">${signUp}</a> `
        : "";
      expect(firstScreen).toContain(`<header>
  <p>${PUBLIC_FEATURES_EYEBROW}</p>
  <h1>${PUBLIC_FEATURES_HEADLINE}</h1>
  <p>See what you can use in a CoCalc project: ${items}</p>
  <p>${signUpLink}<a href="${prefix}/features/ai">Explore AI agents</a></p>
</header>`);
      const tasks = getPublicFeaturesTasks(config);
      expect(tasks).toHaveLength(taskCount);
      expect(firstScreen).toContain(
        `<ul>${tasks
          .map(
            ({ body, href, title }) =>
              `<li><h2><a href="${prefix}${href}">${title}</a></h2><p>${body.replace(/`([^`]+)`/g, "<code>$1</code>")}</p></li>`,
          )
          .join("")}</ul>`,
      );
      expect(firstScreen.includes("Claude Code")).toBe(site === "cocalc.ai");
    },
  );
});

describe("core landing page initial HTML", () => {
  it.each(["/", "/prefix"])(
    "renders useful home, product, and pricing content on %s",
    (basePath) => {
      const prefix = basePath === "/" ? "" : basePath;
      const home = renderPublicRoutePrerender({ section: "home" }, basePath);
      expect(home).toContain('data-cocalc-public-prerender="home"');
      expect(home).toContain("Build and use software with AI.");
      expect(home).toContain(
        "Use the integrated Codex agent or Claude Code, or run other command-line agents in project terminals",
      );
      expect(home).toContain(
        `href="${basePath === "/" ? "" : basePath}/features/compare"`,
      );
      expect(home).not.toContain("features/compare#agent-sandboxes");

      const products = renderPublicRoutePrerender(
        { section: "products", route: { view: "products" } },
        basePath,
      );
      expect(products).toContain('data-cocalc-public-prerender="products"');
      expect(products).toContain("Ways to Run CoCalc");
      expect(products).toContain("CoCalc.ai");
      expect(products).toContain("CoCalc Rocket");
      expect(products).toContain("persistent Linux project");
      expect(products).toContain(
        "agent features vary by product and deployment",
      );
      expect(products).not.toContain("persistent computer");

      const pricing = renderPublicRoutePrerender(
        { section: "pricing" },
        basePath,
      );
      expect(pricing).toContain('data-cocalc-public-prerender="pricing"');
      expect(pricing).toContain("Hosted memberships");
      expect(pricing).toContain("For Teams and Organizations");
      expect(pricing).toContain(
        "membership options on this page apply to the hosted service",
      );
      expect(pricing).toContain(
        `href="${prefix}/auth/sign-up">Create account for hosted CoCalc`,
      );
      expect(pricing).toContain("Compare customer-operated options");
      expect(pricing).toContain(
        "The purchaser must sign in before buying or managing seats.",
      );
      expect(pricing).not.toContain("then choose a plan");
    },
  );

  it.each(["/", "/prefix"])(
    "keeps pricing compute evaluation inside supported product profiles on %s",
    (basePath) => {
      const prefix = basePath === "/" ? "" : basePath;
      const launchpad = renderPublicRoutePrerender(
        { section: "pricing" },
        basePath,
        { cocalc_product: "launchpad" },
      );
      expect(launchpad).toContain(
        `href="${prefix}/features/research-compute">Evaluate research compute`,
      );
      expect(launchpad).toContain(
        "available models, capacity, and authorization vary by site and account",
      );

      const plus = renderPublicRoutePrerender(
        { section: "pricing" },
        basePath,
        { cocalc_product: "plus" },
      );
      expect(plus).not.toContain("features/research-compute");
      expect(plus).not.toContain("Evaluate research compute");
      expect(plus).not.toContain("Create account for hosted CoCalc");
      expect(plus).not.toContain("Hosted memberships");
      expect(plus).toContain("CoCalc Plus is the local, one-user runtime");
    },
  );

  it("uses route metadata for product detail pages", () => {
    const html = renderPublicRoutePrerender(
      {
        section: "products",
        route: { view: "products-cocalc-launchpad" },
      },
      "/",
    );
    expect(html).toContain("<h1>CoCalc Launchpad</h1>");
    expect(html).toContain("customer-operated private deployment path");
    expect(html).not.toContain("CoCalc Rocket");
  });

  it.each(["/", "/prefix"])(
    "renders stable guide, company, and support discovery content on %s",
    (basePath) => {
      const prefix = basePath === "/" ? "" : basePath;
      const guides = renderPublicRoutePrerender(
        { section: "guides", route: { view: "index" } },
        basePath,
        { cocalc_product: "launchpad" },
      );
      expect(guides).toContain('data-cocalc-public-prerender="guides"');
      expect(guides).toContain("Codex agent chat");
      expect(guides).toContain(`href="${prefix}/docs/ai/codex-chat"`);
      expect(guides).toContain("Research and writing");
      expect(guides).toContain("Durable collaborative projects");

      const about = renderPublicRoutePrerender(
        { section: "about", route: { view: "about" } },
        basePath,
      );
      expect(about).toContain('data-cocalc-public-prerender="about"');
      expect(about).toContain(
        "Building the future of collaborative computation.",
      );
      expect(about).toContain("Make serious computational work easy");
      expect(about).toContain(`href="${prefix}/about/team/william-stein"`);

      const support = renderPublicRoutePrerender(
        { section: "support", route: { view: "index" } },
        basePath,
      );
      expect(support).toContain('data-cocalc-public-prerender="support"');
      expect(support).toContain("Find the right next step");
      expect(support).toContain(`href="${prefix}/support/community"`);
    },
  );

  it("uses shared team and community records for detail discovery", () => {
    const team = renderPublicRoutePrerender(
      { section: "about", route: { view: "about-team" } },
      "/",
    );
    expect(team).toContain('data-cocalc-public-prerender="about-team"');
    expect(team).toContain("William Stein, Founder and CEO");
    expect(team).toContain("Blaec Bejarano, CSO");

    const profile = renderPublicRoutePrerender(
      {
        section: "about",
        route: { view: "about-team-member", teamSlug: "harald-schilly" },
      },
      "/",
    );
    expect(profile).toContain(
      'data-cocalc-public-prerender="about-team-member"',
    );
    expect(profile).toContain("<h1>Harald Schilly</h1>");
    expect(profile).toContain("long-time SageMath contributor");

    const community = renderPublicRoutePrerender(
      { section: "support", route: { view: "community" } },
      "/",
    );
    expect(community).toContain(
      'data-cocalc-public-prerender="support-community"',
    );
    expect(community).toContain("GitHub source code");
    expect(community).toContain(
      "https://www.linkedin.com/company/sagemath-inc./",
    );
  });

  it("does not invent stable bodies for dynamic or account-specific routes", () => {
    for (const route of [
      { section: "about", route: { view: "about-events" } },
      { section: "support", route: { view: "new" } },
      { section: "support", route: { view: "tickets" } },
      {
        section: "about",
        route: { view: "about-team-member", teamSlug: "not-a-person" },
      },
      { section: "news" },
      { section: "rootfs", route: { view: "index" } },
    ]) {
      expect(renderPublicRoutePrerender(route, "/")).toBe("");
    }
  });

  it("filters hosted-only guide links from Plus initial HTML", () => {
    const html = renderPublicRoutePrerender(
      { section: "guides", route: { view: "index" } },
      "/prefix",
      { cocalc_product: "plus" },
    );
    expect(html).toContain('data-cocalc-public-prerender="guides"');
    expect(html).not.toContain("Codex agent chat");
    expect(html).not.toContain('href="/prefix/docs/ai/codex-chat"');
    expect(html).toContain("Jupyter notebooks");
  });

  it("renders the evidence-bounded sandbox comparison", () => {
    const html = renderPublicRoutePrerender(
      { section: "features", route: { view: "detail", slug: "compare" } },
      "/",
    );
    expect(html).toContain("Shared project or agent sandbox?");
    expect(html).toContain(
      "Some support persistent files, snapshots, pause and resume",
    );
    expect(html).toContain("If your design requires automatic fleets");
    expect(html).not.toContain("sandboxes are disposable");
  });

  it.each(["ai", "compare"])(
    "does not prerender hosted documentation links for %s on Plus",
    (slug) => {
      const html = renderPublicRoutePrerender(
        { section: "features", route: { view: "detail", slug } },
        "/prefix",
        { cocalc_product: "plus" },
      );

      expect(html).toContain('data-cocalc-public-prerender="feature"');
      expect(html).not.toContain('href="/prefix/docs/');
    },
  );

  it("links the Claude Code guide from the AI page initial HTML", () => {
    const html = renderPublicRoutePrerender(
      { section: "features", route: { view: "detail", slug: "ai" } },
      "/prefix",
      { cocalc_product: "launchpad" },
    );

    expect(html).toContain(
      '<a href="/prefix/docs/ai/claude-code">Claude Code in CoCalc (Experimental Preview)</a>',
    );
  });

  it("keeps the Home agent section text identical in React and the crawler fallback", () => {
    const expected = [
      "Use the integrated Codex agent or Claude Code, or run other command-line agents in project terminals, all with the files, tools, and running services your collaborators already use.",
      "Claude Code is an experimental preview on sites that enable it and works with your personal Claude Pro or Max subscription.",
    ].join(" ");
    const source = readFileSync(
      join(__dirname, "../../../frontend/public/home/app.tsx"),
      "utf8",
    );
    const reactBody =
      /function AgentDefinitionSection\(\)[\s\S]*?<SectionIntro\s+body="([^"]*)"/.exec(
        source,
      )?.[1];
    const html = renderPublicRoutePrerender({ section: "home" }, "/");
    const fallback =
      /<h2>Agents work where your project lives\.<\/h2>\s*<p>([^<]*)<\/p>/.exec(
        html,
      )?.[1];

    expect(reactBody).toBe(expected);
    expect(fallback).toBe(expected);
  });

  // The React Home page no longer has the tool catalogue, the audience cards
  // or the product list (frontend/public/home tests), so neither does its
  // crawler fallback, on any product. The React "Next step" section still
  // links "Review product paths" and "Review support and sales", so this
  // test does not pin those labels as absent.
  it.each([
    [
      "cocalc.ai",
      {
        cocalc_product: "launchpad",
        dns: "cocalc.ai",
        is_launchpad: true,
        site_name: "CoCalc",
      },
    ],
    ["a Launchpad site", { cocalc_product: "launchpad", is_launchpad: true }],
    ["a Rocket site", { cocalc_product: "rocket" }],
    ["CoCalc Plus", { cocalc_product: "plus" }],
    ["no site configuration", undefined],
  ])(
    "keeps only the agent section after the Home first screen on %s",
    (_site, config) => {
      for (const basePath of ["/", "/prefix"]) {
        const html = renderPublicRoutePrerender(
          { section: "home" },
          basePath,
          config,
        );
        expect(
          [...html.matchAll(/<h2>([^<]+)<\/h2>/g)].map(([, text]) => text),
        ).toEqual(["Agents work where your project lives."]);
        for (const removed of [
          "One project, many workflows.",
          "Browse feature workflows",
          "Choose how CoCalc runs.",
          "customer-operated",
          "Pricing and licensing",
        ]) {
          expect(html).not.toContain(removed);
        }
      }
    },
  );
});

describe("feature initial HTML product availability", () => {
  it.each([
    undefined,
    {},
    { cocalc_product: "plus" },
    { cocalc_product: "invalid" },
  ])("does not advertise research compute for %j", (config) => {
    for (const basePath of ["/", "/prefix", "/docs"]) {
      expect(
        renderPublicRoutePrerender(
          {
            section: "features",
            route: { view: "detail", slug: "research-compute" },
          },
          basePath,
          config,
        ),
      ).toBe("");
      for (const route of [
        { view: "index" },
        { view: "detail", slug: "terminal" },
      ]) {
        const html = renderPublicRoutePrerender(
          { section: "features", route },
          basePath,
          config,
        );
        expect(html).toContain("data-cocalc-public-prerender");
        expect(html).not.toContain("research-compute");
        expect(html).toContain("jupyter-notebook");
      }
    }
  });

  it.each(["launchpad", "rocket"])(
    "renders research compute for %s",
    (cocalc_product) => {
      const config = { cocalc_product };
      const detail = renderPublicRoutePrerender(
        {
          section: "features",
          route: { view: "detail", slug: "research-compute" },
        },
        "/",
        config,
      );
      expect(detail).toContain('data-cocalc-public-prerender="feature"');
      expect(detail).toContain('href="/docs/hosts/project-hosts"');
      expect(
        renderPublicRoutePrerender(
          { section: "features", route: { view: "index" } },
          "/",
          config,
        ),
      ).toContain("research-compute");
    },
  );

  it.each(["/", "/prefix"])(
    "renders the research compute record that the React page renders, on %s",
    (basePath) => {
      // cocalc.ai is Launchpad on the canonical host.
      const config = { cocalc_product: "launchpad", dns: "cocalc.ai" };
      const page = getPublicFeaturePage("research-compute", config)!;
      const html = renderPublicRoutePrerender(
        { section: "features", route: { view: "detail", slug: page.slug } },
        basePath,
        config,
      );
      const prefix = basePath === "/" ? "" : basePath;

      expect(html).toContain(`<h1>${page.metadataTitle}</h1>`);
      expect(page.sections).toHaveLength(2);
      const [options, sizing] = page.sections!;
      for (const text of [
        `<p>${page.tagline}</p>`,
        `<p>${page.summary}</p>`,
        ...page.sections!.flatMap(({ paragraphs, title }) => [
          `<h2>${title}</h2>`,
          ...paragraphs!.map((paragraph) => `<p>${paragraph}</p>`),
        ]),
        ...options.cards!.map(
          ({ body, title }) => `<h3>${title}</h3><p>${body}</p>`,
        ),
        `<details><summary>${sizing.detailsLabel}</summary><ul>${sizing
          .bullets!.map((bullet) => `<li>${bullet}</li>`)
          .join("")}</ul></details>`,
      ]) {
        expect(html).toContain(text);
      }
      const links = [
        ...options.cards!.flatMap(({ link }) => (link ? [link] : [])),
        ...sizing.links!,
      ];
      expect(links.map(({ href }) => href)).toEqual([
        "/docs/hosts/project-hosts",
        "/docs/jupyter/remote-kernels",
        "/docs/hosts/choose-compute",
      ]);
      for (const { href, label } of links) {
        expect(html).toContain(`href="${prefix}${href}">${label}</a>`);
      }
      expect(page.signUpLabel).toBe("Start on CoCalc.ai");
      expect(html).toContain(
        `href="${prefix}/auth/sign-up">${page.signUpLabel}</a>`,
      );
      expect(html).not.toContain("Start using CoCalc");
      // Managed VMs stay off the page, as an option, a detail or a guide
      // link, until they are generally available.
      expect(html).not.toMatch(/\bVMs?\b|virtual machines?|\bWindows\b/i);
      expect(html).not.toContain("projects/virtual-machines");
    },
  );

  // Other sites, such as a customer-operated Launchpad or Rocket site, get
  // the same page without CoCalc.ai's cost line and with the default sign-up
  // label, as the React page does.
  it.each([
    ["launchpad", "launchpad.example.edu", "/"],
    ["rocket", "compute.example.edu", "/"],
    ["rocket", "compute.example.edu", "/prefix"],
  ])(
    "leaves CoCalc.ai's sign-up and billing off research compute for %s on %s%s",
    (cocalc_product, dns, basePath) => {
      const route = {
        section: "features" as const,
        route: { view: "detail" as const, slug: "research-compute" },
      };
      const cocalcAiConfig = { cocalc_product: "launchpad", dns: "cocalc.ai" };
      const costLine = getPublicFeaturePage("research-compute", cocalcAiConfig)!
        .sections![0].paragraphs![0];
      const onCocalcAi = renderPublicRoutePrerender(
        route,
        basePath,
        cocalcAiConfig,
      );
      expect(onCocalcAi).toContain(`<p>${costLine}</p>`);
      expect(onCocalcAi).toContain(">Start on CoCalc.ai</a>");

      const config = { cocalc_product, dns };
      const page = getPublicFeaturePage("research-compute", config)!;
      expect(page.signUpLabel).toBeUndefined();
      expect(page.sections![0].paragraphs).toEqual([]);
      const html = renderPublicRoutePrerender(route, basePath, config);
      expect(html).toBe(
        onCocalcAi
          .replace(`<p>${costLine}</p>`, "")
          .replace(">Start on CoCalc.ai</a>", ">Start using CoCalc</a>"),
      );
      expect(html).not.toContain("CoCalc.ai");
      expect(html).not.toContain("membership");
    },
  );

  it.each([
    ["launchpad", "cocalc.ai"],
    ["rocket", "compute.example.edu"],
  ])(
    "collapses the research compute technical details, like the page, for %s on %s",
    (cocalc_product, dns) => {
      const config = { cocalc_product, dns };
      const sizing = getPublicFeaturePage("research-compute", config)!
        .sections![1];
      const html = renderPublicRoutePrerender(
        {
          section: "features",
          route: { view: "detail", slug: "research-compute" },
        },
        "/",
        config,
      );

      // One details element, closed (no open attribute). Its summary comes
      // first and is the record's label, and every bullet is inside it.
      expect(html.match(/<details\b[^>]*>/g)).toEqual(["<details>"]);
      expect(html.match(/<summary\b[^>]*>/g)).toEqual(["<summary>"]);
      const details = html.slice(
        html.indexOf("<details>"),
        html.indexOf("</details>") + "</details>".length,
      );
      expect(details).toBe(
        `<details><summary>${sizing.detailsLabel}</summary><ul>${sizing
          .bullets!.map((bullet) => `<li>${bullet}</li>`)
          .join("")}</ul></details>`,
      );
      expect(sizing.detailsLabel).toBe("Technical details");
      expect(sizing.bullets).toHaveLength(6);
    },
  );

  it("leaves documentation rendering to its existing owner", () => {
    expect(
      renderPublicRoutePrerender(
        { section: "docs", route: { view: "index" } },
        "/",
        { cocalc_product: "launchpad" },
      ),
    ).toBe("");
  });
});

// The text a crawler reads: tags removed, entities from htmlEscape() decoded.
function crawlerText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// Keeps each guard's own flags, as the React tests' toMatch() does, and adds
// only the "g" that matchAll() needs.
function guardHits(label: string, pattern: RegExp, value: string): string[] {
  const flags = pattern.flags.includes("g")
    ? pattern.flags
    : `${pattern.flags}g`;
  return Array.from(
    value.matchAll(new RegExp(pattern.source, flags)),
    ([match]) => `${label}: "${match}"`,
  );
}

// One store tier with a trial and AI usage, so the tier text and the AI alert
// that Pricing adds when tier data loads are checked too.
const PRICING_TIERS: PublicPricingTier[] = [
  {
    ai_limits: { units_5h: 100 },
    id: "member",
    label: "Member",
    price_monthly: "25",
    price_yearly: "225",
    store_visible: true,
    trial_days: 7,
  },
];

describe("crawler fallback copy guards", () => {
  it.each(["plus", "launchpad", "rocket"])(
    "keeps guarded copy out of every %s route with a fallback",
    (cocalc_product) => {
      const config = { cocalc_product };
      const paths = new Set([
        ...buildPublicSitemapPaths(config),
        ...PUBLIC_FEATURE_PAGES.map(({ slug }) => `/features/${slug}`),
      ]);
      const sections = new Set<string>();
      const violations: string[] = [];
      for (const path of paths) {
        const route = getPublicMetadataRouteFromPath(path);
        // Pricing is checked with and without tier data, because the shell
        // passes the tiers only when it has loaded them.
        const variants: PublicRoutePrerenderData[] =
          route.section === "pricing"
            ? [{}, { pricingTiers: PRICING_TIERS }]
            : [{}];
        for (const data of variants) {
          const html = renderPublicRoutePrerender(route, "/", config, data);
          if (html === "") continue;
          sections.add(route.section);
          const text = crawlerText(html);
          const { description, title } = getPublicRouteMetadata(route, config);
          const h1 = crawlerText(
            /<h1\b[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? "",
          );
          if (h1 === "") violations.push(`${path} has no H1 text`);
          // Internal terms: the full text on Home, like the React Home tests;
          // elsewhere title, description and H1, like the React metadata
          // checks, so body text may use rendered labels, such as the pricing
          // heading "Dedicated project hosts".
          const internalTermScope =
            route.section === "home"
              ? [title, description, text]
              : [title, description, h1];
          violations.push(
            ...[
              ...guardHits("overpromise", OVERPROMISE_TERMS, text),
              ...guardHits(
                "unsupported capability",
                UNSUPPORTED_CAPABILITY_TERMS,
                text,
              ),
              ...guardHits("stale agent phrase", STALE_AGENT_PHRASES, text),
              ...(route.section === "pricing"
                ? []
                : guardHits("dollar amount", DOLLAR_AMOUNT, text)),
              ...guardHits(
                "internal term",
                INTERNAL_IMPLEMENTATION_TERMS,
                internalTermScope.join("\n"),
              ),
            ].map((hit) => `${path} ${hit}`),
          );
        }
      }
      expect(violations).toEqual([]);
      // Every section that has a fallback, so one that leaves the sitemap
      // cannot drop out of the check unnoticed.
      for (const section of [
        "home",
        "about",
        "features",
        "guides",
        "pricing",
        "products",
        "support",
      ]) {
        expect(sections).toContain(section);
      }
    },
  );
});
