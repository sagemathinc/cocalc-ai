import { getPublicFeaturePage } from "@cocalc/util/public-feature-pages";
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
      const home = renderPublicRoutePrerender({ section: "home" }, basePath);
      expect(home).toContain('data-cocalc-public-prerender="home"');
      expect(home).toContain(
        "Keep people, AI agents, and project work together.",
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
      expect(pricing).not.toContain("then choose a plan");
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
