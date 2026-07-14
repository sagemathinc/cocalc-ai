/** @jest-environment jsdom */

import { act, cleanup, render, waitFor } from "@testing-library/react";

import {
  getPublicMetadataRouteFromPath,
  getPublicRouteMetadata,
  PUBLIC_SITEMAP_PATHS,
} from "@cocalc/util/public-site-metadata";
import "@cocalc/util/public-site-metadata-docs";
import PublicApp from "../app";
import { FEATURE_PAGES } from "../features/catalog";
import { getPublicRouteFromPath, publicPath } from "../routes";
import {
  installMatchMediaStub,
  INTERNAL_IMPLEMENTATION_TERMS,
  OVERPROMISE_TERMS,
} from "./test-helpers";

const FEATURE_PATHS = FEATURE_PAGES.map((page) => `features/${page.slug}`);
const PRODUCT_PATHS = [
  "products",
  "products/cocalc-plus",
  "products/cocalc-star",
  "products/cocalc-launchpad",
  "products/cocalc-rocket",
];
const MARKETING_PATHS = [
  "",
  "features",
  ...FEATURE_PATHS,
  "support",
  ...PRODUCT_PATHS,
  "pricing",
];
const HELD_FEATURE_SLUGS = [
  "automations",
  "cli",
  "more-languages",
  "project-hosts",
  "dedicated-compute",
];
const UNSUPPORTED_CAPABILITY_TERMS =
  /built-in scheduler|recurring runs?|preinstalled (language stack|C\+\+|Fortran|Rust)|default Octave kernel/i;
const DOLLAR_AMOUNT = /\$\s*\d/;

const originalFetch = global.fetch;

beforeEach(() => {
  installMatchMediaStub();
  global.fetch = jest.fn(
    () => new Promise<Response>(() => undefined),
  ) as typeof fetch;
});

afterEach(async () => {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  cleanup();
  global.fetch = originalFetch;
});

async function renderPublicPath(path: string) {
  const result = render(
    <PublicApp
      config={{ help_email: "help@example.com", site_name: "CoCalc" }}
      initialRoute={getPublicRouteFromPath(publicPath(path))}
    />,
  );
  await waitFor(() =>
    expect(result.container.textContent?.trim().length).toBeGreaterThan(0),
  );
  return result;
}

function routeMetadata(path: string) {
  return getPublicRouteMetadata(getPublicMetadataRouteFromPath(path), {
    site_name: "CoCalc",
  });
}

describe("rendered public marketing overpromise canary", () => {
  it.each(MARKETING_PATHS)("keeps unsupported claims off %s", async (path) => {
    const { container } = await renderPublicPath(path);
    const text = container.textContent ?? "";

    expect(text).not.toMatch(OVERPROMISE_TERMS);
    if (path !== "pricing") {
      expect(text).not.toMatch(DOLLAR_AMOUNT);
    }
  });
});

describe("public metadata overpromise coverage", () => {
  it("checks every sitemap route title and description", () => {
    for (const path of PUBLIC_SITEMAP_PATHS) {
      const metadata = routeMetadata(path);
      for (const value of [metadata.title, metadata.description]) {
        expect(value).not.toMatch(OVERPROMISE_TERMS);
        expect(value).not.toMatch(INTERNAL_IMPLEMENTATION_TERMS);
      }
    }
  });

  it("checks every feature catalog title and summary field", () => {
    for (const page of FEATURE_PAGES) {
      for (const value of [
        page.title,
        page.summary,
        page.metadataTitle ?? "",
        page.metadataSummary ?? "",
      ]) {
        expect(value).not.toMatch(OVERPROMISE_TERMS);
        expect(value).not.toMatch(INTERNAL_IMPLEMENTATION_TERMS);
      }
    }
  });
});

describe("public capability claim boundaries", () => {
  it("keeps held feature slugs out of the catalog and sitemap", () => {
    const catalogSlugs = FEATURE_PAGES.map((page) => page.slug);

    for (const slug of HELD_FEATURE_SLUGS) {
      expect(catalogSlugs).not.toContain(slug);
      expect(PUBLIC_SITEMAP_PATHS).not.toContain(`/features/${slug}`);
    }
  });

  it("keeps narrowly unsupported claims out of public summaries", () => {
    const featureSummaries = FEATURE_PAGES.flatMap((page) => [
      page.summary,
      page.metadataSummary ?? "",
    ]);
    const routeDescriptions = PUBLIC_SITEMAP_PATHS.map(
      (path) => routeMetadata(path).description,
    );

    for (const value of [...featureSummaries, ...routeDescriptions]) {
      expect(value).not.toMatch(UNSUPPORTED_CAPABILITY_TERMS);
    }
  });
});
