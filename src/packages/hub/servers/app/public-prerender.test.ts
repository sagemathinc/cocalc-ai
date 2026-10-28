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
  getPublicAboutIntro,
  PUBLIC_ABOUT_HEADLINE,
  PUBLIC_ABOUT_HISTORY,
  PUBLIC_ABOUT_PRINCIPLES,
  PUBLIC_ABOUT_PRINCIPLES_HEADLINE,
  PUBLIC_ABOUT_REASON,
  PUBLIC_ABOUT_TRUST,
  PUBLIC_TEAM_BILLING_CONTACT,
  PUBLIC_TEAM_MEMBERS,
  UNPUBLISHED_TEAM_PROFILE_SLUGS,
} from "@cocalc/util/public-about-content";
import {
  getPublicFeaturePage,
  PUBLIC_API_HTTP_INTEGRATIONS,
  PUBLIC_CLI_COMPUTER_COMMANDS,
  PUBLIC_CLI_IN_PROJECTS,
  PUBLIC_CLI_INSTALL_COMMAND,
  PUBLIC_CLI_INSTALL_STEP,
  PUBLIC_CLI_INSTALL_TITLE,
  PUBLIC_CLI_INSTALL_WINDOWS,
  PUBLIC_CLI_ON_YOUR_COMPUTER,
  PUBLIC_CLI_START_AUTOMATING,
  PUBLIC_CLI_TERMS,
  PUBLIC_FEATURE_PAGES,
  PUBLIC_PLUS_FEATURE_LINES,
} from "@cocalc/util/public-feature-pages";
import type { PublicPricingTier } from "@cocalc/util/public-pricing";
import {
  buildPublicSitemapPaths,
  getPublicMetadataRouteFromPath,
  getPublicRouteMetadata,
} from "@cocalc/util/public-site-metadata";
import {
  getShownPublicProducts,
  PUBLIC_PRODUCT_AVAILABILITY,
  publicProductView,
} from "@cocalc/util/public-product-availability";
import {
  getPublicProductPageCopy,
  getPublicWhereToRunActions,
  getPublicWhereToRunHeadline,
  getPublicWhereToRunIntro,
  getPublicWhereToRunPaths,
  PUBLIC_LAUNCHPAD_INSTALL_COMMAND,
  PUBLIC_PLUS_INSTALL_COMMAND,
  PUBLIC_PLUS_INSTALL_SCRIPT_URL,
  PUBLIC_PLUS_UNINSTALL_COMMAND,
  PUBLIC_STAR_INSTALL_COMMAND,
  PUBLIC_STAR_REMOVE_COMMANDS,
  PUBLIC_WHERE_TO_RUN_COMPARISON,
  PUBLIC_WHERE_TO_RUN_COMPARISON_LINKS,
  PUBLIC_WHERE_TO_RUN_CONTACT,
  PUBLIC_WHERE_TO_RUN_PATHS_TITLE,
  PUBLIC_WHERE_TO_RUN_WORKFLOW,
  publicProductTextParts,
  PUBLIC_PRODUCT_SHARED_NOTE,
  type PublicProductBlock,
  type PublicProductPageCopy,
} from "@cocalc/util/public-products-content";
import { renderPublicRoutePrerender } from "./public-prerender";
import type { PublicRoutePrerenderData } from "./public-prerender";

afterEach(() => jest.restoreAllMocks());

// As the crawler fallback escapes text.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// What a reader sees of a product page card's block.
function blockText(block: PublicProductBlock): string {
  if (typeof block === "string" || "text" in block) {
    return publicProductTextParts(block)
      .map((part) =>
        "code" in part
          ? part.code
          : "link" in part
            ? part.link.label
            : part.text,
      )
      .join("");
  }
  return "note" in block ? block.note : block.code;
}

// Every string of a product page's shared words, as a reader sees them, with
// the note that every product page shows.
function productCopyText(copy: PublicProductPageCopy): string[] {
  return [
    copy.lead.title,
    ...copy.lead.paragraphs,
    ...copy.lead.actions.map(({ label }) => label),
    PUBLIC_PRODUCT_SHARED_NOTE.title,
    PUBLIC_PRODUCT_SHARED_NOTE.body,
    ...copy.points.flatMap(({ body, title }) => [title, body]),
    ...copy.sections.flatMap(({ blocks, links = [], title }) => [
      title,
      ...blocks.map(blockText),
      ...links.map(({ label }) => label),
    ]),
    ...(copy.notes.length > 0 ? [copy.notesTitle, ...copy.notes] : []),
    ...copy.links.map(({ label }) => label),
  ];
}

// The text of the HTML with its tags removed, so a paragraph's code and links
// read as part of it.
function inlineText(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// The HTML of the section that has this id, or this heading.
function sectionHtml(html: string, match: string): string {
  return (
    html
      .split("<section")
      .find((section) => section.includes(match))
      ?.split("</section>")[0] ?? ""
  );
}
import {
  PUBLIC_HOME_AGENT_BODY,
  PUBLIC_HOME_AGENT_STEPS,
  PUBLIC_HOME_AGENT_TITLE,
  PUBLIC_HOME_EYEBROW,
  PUBLIC_HOME_HEADLINE,
  PUBLIC_HOME_HIGHLIGHTS,
  PUBLIC_HOME_INTRO,
  PUBLIC_HOME_SECONDARY_CTA,
} from "@cocalc/util/public-home-content";
import {
  getPublicFeaturesTasks,
  PUBLIC_FEATURES_EYEBROW,
  PUBLIC_FEATURES_HEADLINE,
} from "@cocalc/util/public-features-index";

// Shared About text as readers see it, links included.
function aboutText(parts: readonly { text: string }[]): string {
  return parts.map(({ text }) => text).join("");
}

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

describe("CLI and API initial HTML", () => {
  it.each(["/", "/prefix"])(
    "renders the sentences the React page renders, on %s",
    (basePath) => {
      const html = renderPublicRoutePrerender(
        { section: "features", route: { view: "detail", slug: "api" } },
        basePath,
        { cocalc_product: "launchpad", dns: "cocalc.ai" },
      );

      expect(html).toContain("<h1>CLI and API</h1>");
      for (const text of [
        "The CLI your agents use, and your scripts can too.",
        `${PUBLIC_CLI_IN_PROJECTS} ${PUBLIC_CLI_ON_YOUR_COMPUTER}`,
        PUBLIC_API_HTTP_INTEGRATIONS,
        PUBLIC_CLI_START_AUTOMATING,
        PUBLIC_CLI_TERMS,
      ]) {
        expect(html).toContain(`<p>${text}</p>`);
      }
      // The summary starts with the sentence that is also the page's
      // description; the header prints it once, as the React page does.
      expect(html.split(PUBLIC_CLI_IN_PROJECTS)).toHaveLength(2);
      expect(html).toContain(
        '<a href="https://cocalc.ai/policies/terms">CoCalc.ai Terms of Service</a>',
      );
      expect(html).toContain(
        '<a href="https://cocalc.ai/policies/terms#api-terms">API Terms</a>',
      );
      // The install section follows the two CLI sentences, with CoCalc.ai's
      // command.
      const install = sectionHtml(html, `<h2>${PUBLIC_CLI_INSTALL_TITLE}</h2>`);
      expect(html.indexOf(PUBLIC_CLI_ON_YOUR_COMPUTER)).toBeLessThan(
        html.indexOf(PUBLIC_CLI_INSTALL_TITLE),
      );
      expect(install).toContain(`<p>${PUBLIC_CLI_INSTALL_STEP}</p>`);
      expect(install).toContain(
        "<pre><code>curl -fsSL https://cocalc.ai/cli/install.sh | sh</code></pre>",
      );
      expect(install).toContain(`<p>${PUBLIC_CLI_INSTALL_WINDOWS}</p>`);
      for (const { code, text } of PUBLIC_CLI_COMPUTER_COMMANDS) {
        expect(install).toContain(
          `<p><code>${escapeHtml(code)}</code> ${escapeHtml(text)}</p>`,
        );
      }
      // Agents run `cocalc agent` and `cocalc sensor` inside projects, and
      // the page names no computer command.
      expect(html).not.toMatch(/cocalc (agent|sensor)\b|cocalc computer/);
    },
  );

  it.each([
    [
      "a server with a domain",
      "/",
      { cocalc_product: "launchpad", dns: "star.example.com" },
    ],
    [
      "a site under a base path",
      "/prefix",
      { cocalc_product: "launchpad", dns: "cocalc.example.edu" },
    ],
    [
      "this computer",
      "/",
      { cocalc_product: "launchpad", dns: "localhost:8170" },
    ],
    [
      "a CoCalc Plus install",
      "/",
      { cocalc_product: "plus", dns: "localhost:5000" },
    ],
  ])("prints CoCalc.ai's install command on %s", (_site, basePath, config) => {
    const html = renderPublicRoutePrerender(
      { section: "features", route: { view: "detail", slug: "api" } },
      basePath,
      config,
    );
    // As the React page shows it, whatever the site's host and base path.
    expect(sectionHtml(html, `<h2>${PUBLIC_CLI_INSTALL_TITLE}</h2>`)).toContain(
      `<pre><code>${escapeHtml(PUBLIC_CLI_INSTALL_COMMAND)}</code></pre>`,
    );
    expect(html.match(/curl -fsSL \S+\/cli\/install\.sh/g)).toEqual([
      "curl -fsSL https://cocalc.ai/cli/install.sh",
    ]);
  });
});

describe("feature page headers in the initial HTML", () => {
  it.each(PUBLIC_FEATURE_PAGES.map(({ slug }) => slug))(
    "prints no lead line twice on the %s page",
    (slug) => {
      const html = renderPublicRoutePrerender(
        { section: "features", route: { view: "detail", slug } },
        "/",
        { cocalc_product: "launchpad", dns: "cocalc.ai" },
      );
      const header = /<header>([\s\S]*?)<\/header>/.exec(html)?.[1] ?? "";
      const lines = [...header.matchAll(/<p>([^<]*)<\/p>/g)].map(
        ([, text]) => text,
      );
      for (const [index, line] of lines.entries()) {
        expect(
          lines.filter((other, j) => j !== index && other.includes(line)),
        ).toEqual([]);
      }
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

      // The first screen has no trust line, as on the React page.
      expect(texts).toEqual([
        `p: ${PUBLIC_HOME_EYEBROW}`,
        `h1: ${PUBLIC_HOME_HEADLINE}`,
        `p: ${PUBLIC_HOME_INTRO}`,
        ...PUBLIC_HOME_HIGHLIGHTS.map((highlight) => `li: ${highlight}`),
      ]);
      expect(html).not.toMatch(/Developed by|since 2013/i);
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
        "Use the integrated Codex agent, Claude Code on sites that enable it, or other command-line agents in project terminals",
      );
      // the Agents guide's starter tasks (hosted products, and the default)
      expect(home).toContain(
        `href="${prefix}/docs/ai/my-agents#turn-a-recurring-task-into-an-app"`,
      );
      expect(home).toContain(
        `href="${prefix}/docs/ai/my-agents#investigate-a-change-in-your-data"`,
      );
      expect(home).not.toContain("features/compare#agent-sandboxes");
      // CoCalc Plus has no Agents workspace: the agent comparison instead
      const plus = renderPublicRoutePrerender({ section: "home" }, basePath, {
        cocalc_product: "plus",
      });
      expect(plus).toContain(`href="${prefix}/features/compare"`);
      expect(plus).not.toContain("docs/ai/my-agents");

      const products = renderPublicRoutePrerender(
        { section: "products", route: { view: "products" } },
        basePath,
      );
      expect(products).toContain('data-cocalc-public-prerender="products"');
      expect(products).toContain("<h1>Where to run CoCalc</h1>");
      expect(products).toContain("CoCalc.ai");
      // Only the products the public pages show.
      expect(products).toContain(`href="${prefix}/products/cocalc-plus"`);
      expect(products).toContain(`href="${prefix}/products/cocalc-star"`);
      expect(products).not.toMatch(/products\/cocalc-(launchpad|rocket)/);
      expect(products).not.toMatch(/\b(Launchpad|Rocket)\b/);
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
      expect(pricing).toContain(
        `<a href="${prefix}/products">Where to run CoCalc</a>`,
      );
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

  it.each(["/", "/prefix"])(
    "renders the Where to run CoCalc page from the words its React page renders, on %s",
    (basePath) => {
      const prefix = basePath === "/" ? "" : basePath;
      const html = renderPublicRoutePrerender(
        { section: "products", route: { view: "products" } },
        basePath,
      );
      for (const text of [
        getPublicWhereToRunHeadline(),
        getPublicWhereToRunIntro(),
        PUBLIC_WHERE_TO_RUN_PATHS_TITLE,
        ...getPublicWhereToRunPaths().flatMap(({ detail, title }) => [
          title,
          detail,
        ]),
        PUBLIC_WHERE_TO_RUN_COMPARISON.title,
        PUBLIC_WHERE_TO_RUN_COMPARISON.caption,
        ...PUBLIC_WHERE_TO_RUN_COMPARISON_LINKS.map(({ label }) => label),
        PUBLIC_WHERE_TO_RUN_CONTACT.title,
        PUBLIC_WHERE_TO_RUN_CONTACT.body,
        ...PUBLIC_WHERE_TO_RUN_CONTACT.links.map(({ label }) => label),
        ...getPublicWhereToRunActions().map(({ label }) => label),
      ]) {
        expect(html).toContain(escapeHtml(text));
      }
      for (const {
        cocalcAi,
        label,
        star,
      } of PUBLIC_WHERE_TO_RUN_COMPARISON.rows) {
        expect(html).toContain(
          `<tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(
            cocalcAi,
          )}</td><td>${escapeHtml(star)}</td></tr>`,
        );
      }
      expect(html).toContain(
        `href="${prefix}/products/cocalc-star#install-cocalc-star">Install CoCalc Star</a>`,
      );
      // The fallback's table has no narrow-screen layout to describe.
      expect(html).toContain(
        `<caption>${PUBLIC_WHERE_TO_RUN_COMPARISON.caption}</caption>`,
      );
      expect(html).not.toContain("narrow screens");
      expect(html).toContain(
        'href="https://cocalc.ai/pricing">Start on CoCalc.ai</a>',
      );
      expect(html).toContain(
        `href="${prefix}/features/ai">See how agents work</a>`,
      );
      expect(html).toContain(
        `href="${prefix}/docs/ai/connect-credentials">Connect AI access</a>`,
      );
    },
  );

  it.each([
    ["a Launchpad site", { cocalc_product: "launchpad" }, true],
    ["no site configuration", undefined, false],
  ])(
    "renders the Where to run CoCalc workflow section on %s",
    (_site, config, compute) => {
      const html = renderPublicRoutePrerender(
        { section: "products", route: { view: "products" } },
        "/",
        config,
      );
      expect(html).toContain(
        `<h2>${PUBLIC_WHERE_TO_RUN_WORKFLOW.title}</h2>\n  <p>${PUBLIC_WHERE_TO_RUN_WORKFLOW.body}</p>`,
      );
      for (const {
        body,
        href,
        label,
        title,
      } of PUBLIC_WHERE_TO_RUN_WORKFLOW.cards) {
        expect(
          html.includes(
            `<li><h3>${title}</h3><p>${body}</p><p><a href="/${href}">${label}</a></p></li>`,
          ),
        ).toBe(href !== "features/research-compute" || compute);
      }
    },
  );

  it("names only CoCalc.ai on Where to run CoCalc once Star is hidden", () => {
    jest.replaceProperty(PUBLIC_PRODUCT_AVAILABILITY, "star", false);
    const route = { section: "products" as const, route: { view: "products" } };
    const html = renderPublicRoutePrerender(route, "/");
    expect(html).toContain("<h2>Run your agents on CoCalc.ai.</h2>");
    expect(html).not.toContain("<table>");
    expect(html).not.toMatch(/\bStar\b/);
    expect(getPublicRouteMetadata(route).description).not.toMatch(/\bStar\b/);
  });

  it("renders a hidden product's page as the products page it redirects to", () => {
    for (const view of [
      "products-cocalc-launchpad",
      "products-cocalc-rocket",
    ]) {
      const html = renderPublicRoutePrerender(
        { section: "products", route: { view } },
        "/",
      );
      expect(html).toBe(
        renderPublicRoutePrerender(
          { section: "products", route: { view: "products" } },
          "/",
        ),
      );
      expect(html).not.toMatch(/products\/cocalc-(launchpad|rocket)/);
    }
  });

  it.each(["/", "/prefix"])(
    "renders the Star page from the words its React page renders, on %s",
    (basePath) => {
      const prefix = basePath === "/" ? "" : basePath;
      const html = renderPublicRoutePrerender(
        { section: "products", route: { view: "products-cocalc-star" } },
        basePath,
      );
      expect(html).toContain(
        "<p>Where to run CoCalc</p>\n  <h1>CoCalc Star</h1>",
      );
      for (const text of productCopyText(getPublicProductPageCopy("star"))) {
        expect(inlineText(html)).toContain(text);
      }
      expect(html).toContain(
        `href="${prefix}/docs/self-hosting/cocalc-star">Read Star setup guide</a>`,
      );
      expect(sectionHtml(html, "<h2>Agents on Star</h2>")).toContain(
        `<a href="${prefix}/docs/ai/connect-credentials">Connect AI access</a>`,
      );
      expect(html).not.toMatch(/\b(Plus|Launchpad|Rocket)\b/);
    },
  );

  it("puts the Star commands under the headings they belong to", () => {
    const html = renderPublicRoutePrerender(
      { section: "products", route: { view: "products-cocalc-star" } },
      "/",
    );
    const install = sectionHtml(html, 'id="install-cocalc-star"');
    expect(install).toContain("<h2>Install CoCalc Star</h2>");
    expect(install).toContain(
      `<pre><code>${escapeHtml(PUBLIC_STAR_INSTALL_COMMAND)}</code></pre>`,
    );
    expect(install).toContain(
      '<a href="https://www.docker.com/products/docker-desktop/">Docker Desktop</a>',
    );
    expect(install).toContain("<code>http://localhost:8170</code>");
    const remove = sectionHtml(html, "<h2>Remove it completely</h2>");
    expect(remove).toContain(
      `<pre><code>${escapeHtml(PUBLIC_STAR_REMOVE_COMMANDS)}</code></pre>`,
    );
    expect(remove).toContain("On Linux hosts with AppArmor");
    expect(remove).not.toContain("Star is one machine");
    expect(sectionHtml(html, "<h2>Boundary: one machine</h2>")).toContain(
      "Star is one machine",
    );
  });

  it.each([
    ["plus", "cocalc-plus", PUBLIC_PLUS_INSTALL_COMMAND],
    ["launchpad", "cocalc-launchpad", PUBLIC_LAUNCHPAD_INSTALL_COMMAND],
  ] as const)(
    "puts the %s install command under its install heading once its switch is on",
    (id, slug, command) => {
      jest.replaceProperty(PUBLIC_PRODUCT_AVAILABILITY, id, true);
      const html = renderPublicRoutePrerender(
        { section: "products", route: { view: `products-${slug}` } },
        "/",
      );
      expect(sectionHtml(html, `id="install-${slug}"`)).toContain(
        `<pre><code>${escapeHtml(command)}</code></pre>`,
      );
    },
  );

  // The React page renders the same words (frontend/public/__tests__/
  // app.test.tsx).
  it("renders the Plus page's install, update and uninstall steps under their headings", () => {
    const html = renderPublicRoutePrerender(
      { section: "products", route: { view: "products-cocalc-plus" } },
      "/",
    );
    expect(html).toContain("<h1>CoCalc Plus</h1>");
    for (const text of productCopyText(getPublicProductPageCopy("plus"))) {
      expect(inlineText(html)).toContain(text);
    }
    const install = sectionHtml(html, 'id="install-cocalc-plus"');
    expect(install).toContain("<h2>Install CoCalc Plus locally</h2>");
    expect(install).toContain(
      `<pre><code>${escapeHtml(PUBLIC_PLUS_INSTALL_COMMAND)}</code></pre>`,
    );
    expect(install).toContain(
      `<a href="${PUBLIC_PLUS_INSTALL_SCRIPT_URL}">Open install script</a>`,
    );
    expect(sectionHtml(html, "<h2>Updates</h2>")).toContain(
      "<pre><code>cocalc-plus update</code></pre>",
    );
    const uninstall = sectionHtml(html, "<h2>Uninstall</h2>");
    expect(uninstall).toContain(
      `<pre><code>${escapeHtml(PUBLIC_PLUS_UNINSTALL_COMMAND)}</code></pre>`,
    );
    expect(uninstall).toContain("<code>~/.local/share/cocalc-plus/data</code>");
    expect(html).not.toMatch(
      /software\.cocalc\.ai\/software\/cocalc(-plus)?\//,
    );
    expect(html).not.toMatch(/Codex is built in|shared web browser/);
  });

  // The React page shows the lead and not the route's description, so the
  // header prints the description only when the lead does not say it.
  it.each([
    ["as the switches are committed", [] as const],
    ["with Launchpad and Rocket shown", ["launchpad", "rocket"] as const],
  ])("prints each product page's description once, %s", (_state, shown) => {
    for (const id of shown) {
      jest.replaceProperty(PUBLIC_PRODUCT_AVAILABILITY, id, true);
    }
    const products = getShownPublicProducts();
    expect(products.map(({ id }) => id)).toEqual(
      expect.arrayContaining(["plus", "star", ...shown]),
    );
    for (const product of products) {
      const route = {
        section: "products" as const,
        route: { view: publicProductView(product) },
      };
      const html = renderPublicRoutePrerender(route, "/");
      const { description } = getPublicRouteMetadata(route);
      expect(html.split(escapeHtml(description))).toHaveLength(2);
    }
    const plus = renderPublicRoutePrerender(
      { section: "products", route: { view: "products-cocalc-plus" } },
      "/",
    );
    expect(
      plus.split(
        "CoCalc Plus runs CoCalc on your own computer, for your own projects.",
      ),
    ).toHaveLength(2);
  });

  it("renders a returning product's page and its links once its switch is on", () => {
    jest.replaceProperty(PUBLIC_PRODUCT_AVAILABILITY, "launchpad", true);
    const html = renderPublicRoutePrerender(
      { section: "products", route: { view: "products-cocalc-launchpad" } },
      "/",
    );
    expect(html).toContain("<h1>CoCalc Launchpad</h1>");
    for (const text of productCopyText(getPublicProductPageCopy("launchpad"))) {
      expect(inlineText(html)).toContain(text);
    }
    expect(html).toContain('id="install-cocalc-launchpad"');
    // Rocket is still hidden.
    expect(html).not.toContain("Rocket");

    const star = renderPublicRoutePrerender(
      { section: "products", route: { view: "products-cocalc-star" } },
      "/",
    );
    expect(star).toContain(
      '<a href="/products/cocalc-launchpad">View CoCalc Launchpad</a>',
    );
    const products = renderPublicRoutePrerender(
      { section: "products", route: { view: "products" } },
      "/",
    );
    expect(products).toContain('href="/products/cocalc-launchpad"');
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
      // CoCalc Plus is shown, so its guide is too, as on the React page.
      expect(guides).toContain("CoCalc Plus");
      expect(guides).toContain(
        "Self-hosting, local evaluation, durable collaborative projects, and architecture.",
      );

      const about = renderPublicRoutePrerender(
        { section: "about", route: { view: "about" } },
        basePath,
      );
      expect(about).toContain('data-cocalc-public-prerender="about"');
      expect(about).toContain(`href="${prefix}/about/team/william-stein"`);
      expect(about).toContain(`href="${prefix}/about/events"`);
      expect(about).not.toMatch(/since 2013/i);

      const support = renderPublicRoutePrerender(
        { section: "support", route: { view: "index" } },
        basePath,
      );
      expect(support).toContain('data-cocalc-public-prerender="support"');
      expect(support).toContain("Find the right next step");
      expect(support).toContain(`href="${prefix}/support/community"`);
    },
  );

  // The React page renders the same constants (frontend/public/__tests__/
  // app.test.tsx), so crawlers read the company statement word for word.
  it("renders the About statement and principles from the shared content", () => {
    const about = renderPublicRoutePrerender(
      { section: "about", route: { view: "about" } },
      "/",
    );
    const header = about.slice(
      about.indexOf("<header>"),
      about.indexOf("</header>"),
    );
    expect(
      [...header.matchAll(/<(p|h1)>([^<]+)<\/\1>/g)].map(
        ([, tag, text]) => `${tag}: ${text}`,
      ),
    ).toEqual([
      "p: SageMath, Inc. · The company behind CoCalc",
      `h1: ${PUBLIC_ABOUT_HEADLINE}`,
      // Away from cocalc.ai, the lead names Codex only.
      `p: ${aboutText(getPublicAboutIntro(false))}`,
    ]);
    expect(header).not.toMatch(/Claude/);
    expect(about.match(/<h1>/g)).toHaveLength(1);
    expect(about).toContain(
      `<p>How we build</p>\n  <h2>${PUBLIC_ABOUT_PRINCIPLES_HEADLINE}</h2>\n  <p>${PUBLIC_ABOUT_REASON}</p>`,
    );
    expect(about).toContain(
      PUBLIC_ABOUT_PRINCIPLES.map(
        ({ body, title }) => `<li><h3>${title}</h3><p>${body}</p></li>`,
      ).join(""),
    );
    expect(about).not.toMatch(
      /Claude Code|experimental preview|Incorporated|Our mission/i,
    );
  });

  // The React page renders the same words (frontend/public/__tests__/
  // app.test.tsx), in the same order, so crawlers also read the trust section
  // and the history.
  it.each(["/", "/prefix"])(
    "renders About's trust section and history from the shared content, on %s",
    (basePath) => {
      const prefix = basePath === "/" ? "" : basePath;
      const trustHref = `${prefix}/policies/trust`;
      const about = renderPublicRoutePrerender(
        { section: "about", route: { view: "about" } },
        basePath,
      );
      const { eyebrow, headline, intro, link, note } = PUBLIC_ABOUT_TRUST;
      expect(about).toContain(
        `<p>${eyebrow}</p>\n  <h2>${headline}</h2>\n  <p>${intro}</p>`,
      );
      expect(about).toContain(
        `<ul><li><a href="${trustHref}"><strong>SOC 2</strong> Independent security audit</a></li><li><a href="${trustHref}"><strong>GDPR</strong> Verified privacy program</a></li><li><strong>Flexible deployment</strong> Hosted and customer-operated</li></ul>`,
      );
      expect(about).toContain(
        `<p><strong>${note.title}</strong> ${note.body}</p>\n  <p><a href="${trustHref}">${link.label}</a></p>`,
      );
      const history = PUBLIC_ABOUT_HISTORY;
      expect(about).toContain(
        `<p>${history.eyebrow}</p>\n  <h2>${history.headline}</h2>\n  <ul>${history.timeline
          .map(({ body, year }) => `<li><strong>${year}</strong> ${body}</li>`)
          .join("")}</ul>`,
      );
      // The two strings this page rewrote, word for word.
      expect(about).toContain(
        "<h2>A mature company behind your team and its agents.</h2>",
      );
      expect(about).toContain(
        "<li><strong>Today</strong> CoCalc is rebuilt with agents at its core: they work in the same persistent, shared projects as the people who direct them.</li>",
      );
      const sections = [
        PUBLIC_ABOUT_PRINCIPLES_HEADLINE,
        headline,
        "Who we serve",
        history.headline,
        "Meet the team",
      ].map((text) => about.indexOf(`<h2>${text}</h2>`));
      expect(sections.every((index) => index >= 0)).toBe(true);
      expect([...sections].sort((a, b) => a - b)).toEqual(sections);
    },
  );

  // As on the React page, cocalc.ai's lead names Claude and links it to the
  // Claude guide.
  it.each(["/", "/prefix"])(
    "links the About lead's Claude mention to its guide on cocalc.ai, on %s",
    (basePath) => {
      const prefix = basePath === "/" ? "" : basePath;
      const about = renderPublicRoutePrerender(
        { section: "about", route: { view: "about" } },
        basePath,
        { cocalc_product: "launchpad", dns: "cocalc.ai" },
      );
      const [before, claude, after] = getPublicAboutIntro(true);
      expect(claude).toEqual({ path: "docs/ai/claude-code", text: "Claude" });
      expect(about).toContain(
        `<h1>${PUBLIC_ABOUT_HEADLINE}</h1>\n  <p>${before.text}<a href="${prefix}/docs/ai/claude-code">Claude</a>${after.text}</p>`,
      );
      expect(about).not.toMatch(/Claude Code|experimental preview/i);
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
    // One entry per published profile, and, as on the React page, the
    // billing contact goes to cocalc.ai's support page: another site's own
    // support page belongs to that site's operator.
    expect(
      [...team.matchAll(/href="\/about\/team\/([^"]+)"/g)].map(
        ([, slug]) => slug,
      ),
    ).toEqual(PUBLIC_TEAM_MEMBERS.map(({ slug }) => slug));
    expect(team).toContain(
      `<p>${PUBLIC_TEAM_BILLING_CONTACT.text} <a href="https://cocalc.ai/support">${PUBLIC_TEAM_BILLING_CONTACT.label}</a>.</p>`,
    );
    // On cocalc.ai itself, that is the site's own support page.
    expect(
      renderPublicRoutePrerender(
        { section: "about", route: { view: "about-team" } },
        "/prefix",
        { cocalc_product: "launchpad", dns: "cocalc.ai" },
      ),
    ).toContain(
      `<p>${PUBLIC_TEAM_BILLING_CONTACT.text} <a href="/prefix/support">${PUBLIC_TEAM_BILLING_CONTACT.label}</a>.</p>`,
    );

    const profile = renderPublicRoutePrerender(
      {
        section: "about",
        route: { view: "about-team-member", teamSlug: "blaec-bejarano" },
      },
      "/",
    );
    expect(profile).toContain(
      'data-cocalc-public-prerender="about-team-member"',
    );
    expect(profile).toContain("<h1>Blaec Bejarano</h1>");
    expect(profile).toContain("leads sales and partnerships");

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
      // The hub redirects these to the team page before rendering.
      ...UNPUBLISHED_TEAM_PROFILE_SLUGS.map((teamSlug) => ({
        section: "about",
        route: { view: "about-team-member", teamSlug },
      })),
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
      '<a href="/prefix/docs/ai/claude-code">Claude Code in CoCalc</a>',
    );
  });

  // Both renderings read the agent section from public-home-content.ts.
  it("keeps the Home agent section text identical in React and the crawler fallback", () => {
    const source = readFileSync(
      join(__dirname, "../../../frontend/public/home/app.tsx"),
      "utf8",
    );
    const reactSection =
      /function AgentDefinitionSection\(\)[\s\S]*?\n}\n/.exec(source)?.[0] ??
      "";
    expect(reactSection).toContain("body={PUBLIC_HOME_AGENT_BODY}");
    expect(reactSection).toContain("title={PUBLIC_HOME_AGENT_TITLE}");
    expect(reactSection).toContain("PUBLIC_HOME_AGENT_STEPS.map(");

    const html = renderPublicRoutePrerender({ section: "home" }, "/");
    const fallback = new RegExp(
      `<h2>${PUBLIC_HOME_AGENT_TITLE.replace(".", "\\.")}</h2>\\s*<p>([^<]*)</p>`,
    ).exec(html)?.[1];
    expect(fallback).toBe(PUBLIC_HOME_AGENT_BODY);
    for (const step of PUBLIC_HOME_AGENT_STEPS) {
      expect(html).toContain(
        `<li><strong>${step.title}</strong>: ${step.body}</li>`,
      );
    }
  });

  // The React Home page no longer has the tool catalogue, the audience cards
  // or the product list (frontend/public/home tests), so neither does its
  // crawler fallback, on any product. The React "Next step" section still
  // links "Where to run CoCalc" and "Review support and sales", so this
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
        ).toEqual([PUBLIC_HOME_AGENT_TITLE]);
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

// Launchpad and Rocket are hidden until their releases are current, so no
// crawler page names them, on any site, as the switches are committed. CoCalc
// Plus is shown; a test below hides it again to check that its name goes too.
describe("crawler fallback while Launchpad and Rocket are hidden", () => {
  const COCALC_AI = { cocalc_product: "launchpad", dns: "cocalc.ai" };
  const SITES = [
    ["cocalc.ai", { ...COCALC_AI, policy_pages: "sagemathinc" as const }],
    ["a Launchpad site", { cocalc_product: "launchpad" }],
    ["a Rocket site", { cocalc_product: "rocket" }],
    ["no site configuration", undefined],
  ] as const;

  function routePaths(config?: { cocalc_product?: string }): string[] {
    return [
      ...new Set([
        ...buildPublicSitemapPaths(config),
        ...PUBLIC_FEATURE_PAGES.map(({ slug }) => `/features/${slug}`),
      ]),
    ];
  }

  // Where any route's crawler text, HTML, title or description names one of
  // `names`.
  function namedOnRoutes(
    names: RegExp,
    config?: (typeof SITES)[number][1],
  ): string[] {
    const hits: string[] = [];
    for (const path of routePaths(config)) {
      const route = getPublicMetadataRouteFromPath(path);
      const variants: PublicRoutePrerenderData[] =
        route.section === "pricing"
          ? [{}, { pricingTiers: PRICING_TIERS }]
          : [{}];
      for (const data of variants) {
        const html = renderPublicRoutePrerender(route, "/", config, data);
        const { description, title } = getPublicRouteMetadata(route, config);
        for (const text of [crawlerText(html), html, title, description]) {
          const match = names.exec(text);
          if (match) {
            hits.push(
              `${path}: ${text.slice(Math.max(0, match.index - 60), match.index + 40)}`,
            );
          }
        }
      }
    }
    return hits;
  }

  it.each(SITES)(
    "names neither of them on any route on %s",
    (_site, config) => {
      expect(namedOnRoutes(/\b(Launchpad|Rocket)\b/, config)).toEqual([]);
    },
  );

  it.each(SITES)(
    "names no hidden product on any route on %s once Plus is hidden again",
    (_site, config) => {
      jest.replaceProperty(PUBLIC_PRODUCT_AVAILABILITY, "plus", false);
      expect(namedOnRoutes(/\b(Plus|Launchpad|Rocket)\b/, config)).toEqual([]);
    },
  );

  // The sentence about CoCalc Plus that each feature page's fallback shows
  // where the site describes Plus.
  const PLUS_TEXT = {
    "jupyter-notebook": PUBLIC_PLUS_FEATURE_LINES.jupyter,
    "latex-editor":
      "Use a hosted image with the required TeX tools, or install the tools for local CoCalc Plus",
    octave: PUBLIC_PLUS_FEATURE_LINES.octave,
    python: PUBLIC_PLUS_FEATURE_LINES.python,
    sage: PUBLIC_PLUS_FEATURE_LINES.sage,
  } as const;

  it.each([
    ["while Plus is shown, on cocalc.ai", COCALC_AI],
    ["on a CoCalc Plus install", { cocalc_product: "plus" }],
  ])("describes CoCalc Plus on the feature pages %s", (_site, config) => {
    for (const [slug, text] of Object.entries(PLUS_TEXT)) {
      const html = renderPublicRoutePrerender(
        { section: "features", route: { view: "detail", slug } },
        "/",
        config,
      );
      expect(crawlerText(html)).toContain(text);
    }
  });
});
