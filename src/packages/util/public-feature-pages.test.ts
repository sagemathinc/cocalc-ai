import {
  PUBLIC_FEATURE_PAGES,
  getPublicFeatureIndexPages,
  getPublicFeaturePage,
} from "./public-feature-pages";

function expectNonEmptyString(value: string, label: string) {
  if (value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

describe("public feature page catalog", () => {
  it("returns exactly the pages marked for the public feature index", () => {
    expect(getPublicFeatureIndexPages()).toEqual(
      PUBLIC_FEATURE_PAGES.filter((page) => page.index),
    );
  });

  it("keeps indexed pages ready for feature index rendering", () => {
    for (const page of getPublicFeatureIndexPages()) {
      expectNonEmptyString(page.slug, `${page.slug} slug`);
      expectNonEmptyString(page.title, `${page.slug} title`);
      expectNonEmptyString(page.tagline, `${page.slug} tagline`);
      expectNonEmptyString(page.summary, `${page.slug} summary`);
    }
  });

  it("keeps legacy feature entries hidden from the public feature index", () => {
    const indexedSlugs = new Set(
      getPublicFeatureIndexPages().map((page) => page.slug),
    );

    for (const slug of ["icons", "i18n"]) {
      const page = getPublicFeaturePage(slug);
      expect(page?.index).toBe(false);
      expect(indexedSlugs.has(slug)).toBe(false);
    }
  });

  it("does not allow slugs or aliases to shadow another feature page", () => {
    const routes = new Map<string, string>();

    for (const page of PUBLIC_FEATURE_PAGES) {
      for (const route of [page.slug, ...(page.aliases ?? [])]) {
        const existingSlug = routes.get(route);
        if (existingSlug != null) {
          throw new Error(
            `${route} points to both ${existingSlug} and ${page.slug}`,
          );
        }
        routes.set(route, page.slug);
        expect(getPublicFeaturePage(route)?.slug).toBe(page.slug);
      }
    }
  });
});
