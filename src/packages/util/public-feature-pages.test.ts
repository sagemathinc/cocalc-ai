import {
  PUBLIC_FEATURE_NAV_ITEMS,
  PUBLIC_FEATURE_PAGES,
  getPublicFeatureIndexPages,
  getPublicFeaturePage,
  publicFeatureHref,
} from "./public-feature-pages";
import { getDocsEntry } from "@cocalc/docs";

function expectNonEmptyString(value: string, label: string) {
  if (value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

describe("public feature page catalog", () => {
  it.each([
    ["/docs/hosts/storage", "/", "/docs/hosts/storage"],
    [
      "/docs/hosts/storage?view=full#backups",
      "/prefix",
      "/prefix/docs/hosts/storage?view=full#backups",
    ],
    [
      "/prefix/docs/hosts/storage?view=full#backups",
      "/prefix",
      "/prefix/docs/hosts/storage?view=full#backups",
    ],
    ["/prefix?view=full#top", "/prefix", "/prefix?view=full#top"],
    ["/prefix-other/docs", "/prefix", "/prefix/prefix-other/docs"],
    ["/docs/hosts/storage", "/prefix/", "/prefix/docs/hosts/storage"],
    [
      "https://example.com/docs?view=full#backups",
      "/prefix",
      "https://example.com/docs?view=full#backups",
    ],
    ["//example.com/docs", "/prefix", "//example.com/docs"],
    ["mailto:support@example.com", "/prefix", "mailto:support@example.com"],
    ["#backups", "/prefix", "#backups"],
    ["?view=full", "/prefix", "?view=full"],
  ])(
    "resolves %s on %s without changing its target",
    (href, basePath, expected) => {
      expect(publicFeatureHref(href, basePath)).toBe(expected);
    },
  );

  it("connects research compute discovery to public documentation", () => {
    const page = getPublicFeaturePage("research-compute");
    expect(page).toBeDefined();
    expect(getPublicFeatureIndexPages()).toContain(page);
    expect(
      PUBLIC_FEATURE_NAV_ITEMS.some((item) => item.slug === page?.slug),
    ).toBe(true);
    const links = [
      page?.docsUrl,
      ...(page?.sections?.flatMap(
        (section) => section.links?.map((link) => link.href) ?? [],
      ) ?? []),
    ];
    expect(links.length).toBeGreaterThan(1);
    for (const href of links) {
      expect(href).toMatch(/^\/docs\//);
      expect(
        getDocsEntry(href!.slice("/docs/".length), {
          siteProfile: "cocalc-ai",
        }),
      ).toBeDefined();
    }
  });

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
