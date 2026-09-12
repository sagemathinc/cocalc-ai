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
