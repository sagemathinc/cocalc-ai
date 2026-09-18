import { getPublicPricingContent } from "@cocalc/util/public-pricing-content";
import { getPublicFeaturePage } from "@cocalc/util/public-feature-pages";
import { getDocsEntry } from "@cocalc/docs";
import {
  isPublicHomeLinkAvailable,
  getPublicHomeContent,
  PUBLIC_HOME_CONTENT as homeContent,
} from "@cocalc/util/public-home-content";
import { renderPublicRoutePrerender } from "./public-prerender";

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
});

describe("core landing page initial HTML", () => {
  it.each(["/", "/prefix"])(
    "renders useful home, product, and pricing content on %s",
    (basePath) => {
      const prefix = basePath === "/" ? "" : basePath;
      const home = renderPublicRoutePrerender({ section: "home" }, basePath);
      expect(home).toContain('data-cocalc-public-prerender="home"');
      expect(home).toContain(homeContent.hero.title);
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
      expect(pricing).toContain("When your work needs more");
      expect(pricing).toContain(
        "Choose a membership for the work you do today",
      );
      expect(pricing).toContain(
        `href="${prefix}/auth/sign-up">Create account for hosted CoCalc`,
      );
      expect(pricing).toContain("Compare customer-operated options");
      expect(pricing).toContain("Sign in to buy or manage seats.");
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
        "Access depends on your account, available capacity and deployment",
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
      expect(plus).toContain(
        `href="${prefix}/products/cocalc-plus#install-cocalc-plus">Review CoCalc Plus setup`,
      );
      expect(plus).toContain("Run one project on your own computer");
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
    expect(html).toContain("Choose where your AI work gets done.");
    expect(html).toContain(
      "Build a dashboard, test a model or develop an application.",
    );
    expect(html).toContain(
      "A persistent workspace and isolated execution are not opposites",
    );
    expect(html).toContain("CoCalc also has APIs and a CLI");
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

describe("shared homepage content", () => {
  it.each(["/", "/prefix", "/docs"])(
    "renders the client story and prefixed links on %s",
    (basePath) => {
      const html = renderPublicRoutePrerender({ section: "home" }, basePath, {
        cocalc_product: "launchpad",
        policy_pages: "sagemathinc",
      });
      const prefix = basePath === "/" ? "" : basePath;
      for (const text of [
        homeContent.hero.title,
        homeContent.hero.description,
        homeContent.hero.example.description,
        homeContent.closing.description,
      ]) {
        expect(html).toContain(text);
      }
      for (const group of [
        homeContent.benefits,
        homeContent.workflows,
        homeContent.hosting,
      ]) {
        expect(html).toContain(`<h2>${group.title}</h2>`);
        for (const card of group.cards) {
          expect(html).toContain(`<h3>${card.title}</h3>`);
          expect(html).toContain(card.description);
        }
      }
      for (const path of [
        homeContent.hero.example.guide.href,
        homeContent.hero.example.image,
        homeContent.hero.secondary.href,
        homeContent.benefits.link.href,
        "pricing",
        "products",
        "policies/trust",
      ]) {
        expect(html).toContain(`href="${prefix}/${path}"`);
      }
      expect(html.match(/<h1>/g)).toHaveLength(1);
      expect(html.match(/<section /g)).toHaveLength(5);
    },
  );

  it("filters hosted docs and unconfigured policies", () => {
    const html = renderPublicRoutePrerender({ section: "home" }, "/prefix", {
      cocalc_product: "plus",
      policy_pages: "",
    });
    expect(html).not.toContain('href="/prefix/docs/research/');
    expect(html).not.toContain('href="/prefix/docs/hosts/');
    expect(html).not.toContain('href="/prefix/policies/trust"');
    expect(html).toContain('href="/prefix/docs/terminal/use-terminal"');
    expect(html).toContain(
      'href="/prefix/products/cocalc-plus#install-cocalc-plus"',
    );
    expect(html).not.toMatch(
      /CoCalc.ai|collaborator|coauthor|hosted membership|project host|auth\/sign-up/i,
    );
    expect(html).not.toContain(homeContent.hero.example.image);
    expect(html).toContain(getPublicHomeContent("plus").hero.description);
  });

  it("escapes custom site labels and URL attributes", () => {
    const html = renderPublicRoutePrerender(
      { section: "home" },
      '/prefix" data-injected="yes',
      {
        site_name: 'Example <script>alert(1)</script> "team"',
        cocalc_product: "star",
      },
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;team&quot;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain(' data-injected="yes');
  });
});

// Keep the lightweight Home contract checked against the authoritative registry.
it.each([undefined, "plus", "launchpad", "rocket", "star"])(
  "matches Home link visibility to the docs registry for %s",
  (product) => {
    const content = getPublicHomeContent(product);
    const links = [
      content.hero.example.guide,
      ...content.workflows.cards.map((c) => c.link),
      ...content.hosting.cards.flatMap((c) => c.links),
    ];
    for (const link of links.filter((l) => l.href.startsWith("docs/"))) {
      const slug = link.href.slice(5).split("#")[0];
      expect(isPublicHomeLinkAvailable(link.href, product)).toBe(
        getDocsEntry(slug, {
          product: product === "plus" ? "plus" : undefined,
        }) != null,
      );
    }
  },
);

describe("professional AI project initial HTML", () => {
  it.each(["/", "/prefix", "/docs"])(
    "renders the same professional project briefs across product profiles on %s",
    (basePath) => {
      const { getPublicAIContent } = require("@cocalc/util/public-ai-content");
      const prefix = basePath === "/" ? "" : basePath;
      for (const product of [
        undefined,
        "star",
        "plus",
        "launchpad",
        "rocket",
      ]) {
        for (const slug of ["ai", "openai-chatgpt"]) {
          const content = getPublicAIContent(product);
          const html = renderPublicRoutePrerender(
            { section: "features", route: { view: "detail", slug } },
            basePath,
            { cocalc_product: product },
          )!;
          expect(html).toContain(content.hero.title);
          expect(html.split(content.hero.description)).toHaveLength(2);
          for (const card of content.projects.cards) {
            expect(html).toContain(card.title);
            expect(html).toContain(card.description);
            expect(html).toContain(`href="${prefix}${card.link.href}"`);
          }
          for (const step of content.workflow.steps) {
            expect(html).toContain(step.title);
            expect(html).toContain(step.description);
          }
          expect(html).toContain(content.review.description);
          expect(html).toContain(content.setup.description);
          expect(html).not.toContain("Teams and teaching");
          expect(html).not.toContain("3 checks complete");
          if (product === "plus") {
            expect(html).toContain(
              `href="${prefix}/products/cocalc-plus#install-cocalc-plus"`,
            );
            expect(html).not.toContain("auth/sign-up");
            expect(html).not.toContain("invite others");
            expect(html).not.toContain("docs/research/");
            expect(html).not.toContain("docs/ai/codex-chat");
          } else {
            expect(html).toContain(
              `href="${prefix}/auth/sign-up?intent=codex"`,
            );
          }
          expect(
            html.includes(`href="${prefix}/features/research-compute"`),
          ).toBe(product === "launchpad" || product === "rocket");
        }
      }
    },
  );
});

describe("shared pricing guidance", () => {
  it.each(["launchpad", "star", "plus"])(
    "keeps %s initial HTML consistent with the buying copy",
    (product) => {
      const content = getPublicPricingContent(product);
      const html = renderPublicRoutePrerender(
        { section: "pricing" },
        "/preview-base",
        { cocalc_product: product },
      );
      expect(html).toContain(content.hero.title);
      expect(html).toContain(content.hero.description);
      expect(html).toContain(content.deployment.description);
      expect(html).toContain('href="/preview-base/products"');
      expect(html).not.toContain('href="/products"');
      expect(html).not.toContain("Pay at the end of the month");
      if (product === "plus") {
        expect(html).not.toContain("Hosted memberships");
        expect(html).not.toContain("auth/sign-up");
        expect(html).toContain(content.quote.description);
      } else {
        expect(html).toContain(content.memberships.upgrade);
        expect(html).toContain(
          "Enable JavaScript to load current membership plans and prices.",
        );
        expect(html).toContain(content.team.description);
      }
    },
  );
});
