import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getPublicFeaturePage } from "@cocalc/util/public-feature-pages";
import { renderPublicRoutePrerender } from "./public-prerender";
import {
  PUBLIC_HOME_EYEBROW,
  PUBLIC_HOME_HEADLINE,
  PUBLIC_HOME_HIGHLIGHTS,
  PUBLIC_HOME_INTRO,
  PUBLIC_HOME_SECONDARY_CTA,
  PUBLIC_HOME_TRUST_LINE,
} from "@cocalc/util/public-home-content";

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
      const html = renderPublicRoutePrerender(
        { section: "features", route: { view: "detail", slug: page.slug } },
        basePath,
        {},
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
      "CoCalc Plus",
      { cocalc_product: "plus", dns: "localhost", site_name: "CoCalc" },
      withoutClaude,
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
    "names Claude Code in the highlights only on cocalc.ai: %s",
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
      expect(pricing).toContain("For teams and organizations");
      expect(pricing).toContain(
        "membership options on this page apply to the hosted service",
      );
      expect(pricing).toContain(
        `href="${prefix}/auth/sign-up">Create account for hosted CoCalc`,
      );
      expect(pricing).toContain("Compare customer-operated options");
      expect(pricing).toContain(
        "Account actions require sign-in, and host creation also depends on membership or grant eligibility.",
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
      expect(launchpad).toContain("catalog availability, and authorization");

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
