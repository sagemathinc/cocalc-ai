import { getPublicFeaturePage } from "@cocalc/util/public-feature-pages";
import { renderPublicRoutePrerender } from "./public-prerender";

describe("public feature initial HTML", () => {
  it("keeps research documentation links on the deployment prefix", () => {
    const page = getPublicFeaturePage("research-compute")!;
    const html = renderPublicRoutePrerender(
      { section: "features", route: { view: "detail", slug: page.slug } },
      "/prefix",
    );

    expect(html).toContain('data-cocalc-public-prerender="feature"');
    for (const section of page.sections ?? []) {
      for (const link of section.links ?? []) {
        expect(html).toContain(`href="/prefix${link.href}"`);
      }
    }
    expect(html).not.toContain('href="/docs/');
    expect(html).toContain('href="/prefix/auth/sign-up"');
  });
});
