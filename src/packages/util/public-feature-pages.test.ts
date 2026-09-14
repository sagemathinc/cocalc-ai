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
      "/prefix/prefix/docs/hosts/storage?view=full#backups",
    ],
    ["/prefix?view=full#top", "/prefix", "/prefix/prefix?view=full#top"],
    ["/docs/hosts/storage", "/docs", "/docs/docs/hosts/storage"],
    [
      "/docs/hosts/storage?view=full#backups",
      "/docs/",
      "/docs/docs/hosts/storage?view=full#backups",
    ],
    ["/docs?view=full#top", "/docs", "/docs/docs?view=full#top"],
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

describe("research compute product availability", () => {
  it.each([{}, { cocalc_product: "plus" }, { cocalc_product: "invalid" }])(
    "excludes only research compute for %j",
    (config) => {
      expect(getPublicFeaturePage("research-compute", config)).toBeUndefined();
      expect(getPublicFeatureIndexPages(config)).toEqual(
        getPublicFeatureIndexPages().filter(
          (page) => page.slug !== "research-compute",
        ),
      );
      expect(
        PUBLIC_FEATURE_NAV_ITEMS.filter(({ slug }) =>
          getPublicFeaturePage(slug, config),
        ),
      ).toEqual(
        PUBLIC_FEATURE_NAV_ITEMS.filter(
          ({ slug }) => slug !== "research-compute",
        ),
      );
      for (const page of PUBLIC_FEATURE_PAGES.filter(
        (page) => page.slug !== "research-compute",
      )) {
        for (const slug of [page.slug, ...(page.aliases ?? [])]) {
          expect(getPublicFeaturePage(slug, config)).toBe(page);
        }
      }
    },
  );

  it.each(["launchpad", "rocket"])(
    "retains the complete catalog for %s",
    (cocalc_product) => {
      expect(getPublicFeaturePage("research-compute", { cocalc_product })).toBe(
        getPublicFeaturePage("research-compute"),
      );
      expect(getPublicFeatureIndexPages({ cocalc_product })).toEqual(
        getPublicFeatureIndexPages(),
      );
    },
  );
});
