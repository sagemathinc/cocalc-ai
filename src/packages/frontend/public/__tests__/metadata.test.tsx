/** @jest-environment jsdom */

import { render, waitFor } from "@testing-library/react";

import {
  applyPublicRouteMetadata,
  getPublicRouteMetadata,
  PublicRouteHeadMetadata,
} from "../metadata";
import { getPublicMetadataRouteFromPath } from "@cocalc/util/public-site-metadata";
// Registers the docs registry with the metadata API; the browser loads this
// lazily on docs routes, tests need it wired up front.
import "@cocalc/util/public-site-metadata-docs";
import type { PublicRoute } from "../routes";
import { PUBLIC_SITEMAP_PATHS } from "../sitemap-paths";
import { getFeatureIndexPages } from "../features/catalog";

type PublicProductsRoute = Extract<PublicRoute, { section: "products" }>;

function productRoute(
  view: PublicProductsRoute["route"]["view"],
): PublicProductsRoute {
  return {
    route: { view },
    section: "products",
  };
}

function headMeta(selector: string): string | null {
  return document.head.querySelector(selector)?.getAttribute("content") ?? null;
}

function canonicalHref(): string | null {
  return (
    document.head
      .querySelector('link[data-cocalc-public-route-meta="canonical"]')
      ?.getAttribute("href") ?? null
  );
}

beforeEach(() => {
  document.head
    .querySelectorAll("[data-cocalc-public-route-meta]")
    .forEach((element) => element.remove());
});

describe("public route metadata", () => {
  it("frames the five product paths for public previews", () => {
    const products = getPublicRouteMetadata(
      {
        route: { view: "products" },
        section: "products",
      },
      { site_name: "CoCalc" },
    );
    expect(products.title).toBe("Ways to Run CoCalc | CoCalc");
    expect(products.description).toContain("hosted CoCalc.ai");
    expect(products.description).toContain("CoCalc Plus");
    expect(products.description).toContain("CoCalc Star");
    expect(products.description).toContain("CoCalc Launchpad");
    expect(products.description).toContain("CoCalc Rocket");

    const star = getPublicRouteMetadata(
      {
        route: { view: "products-cocalc-star" },
        section: "products",
      },
      { site_name: "CoCalc" },
    );
    expect(star.title).toBe("CoCalc Star | CoCalc");
    expect(star.description).toContain("single-VM appliance");
    expect(star.description).toContain("one public Ubuntu VM");

    const launchpad = getPublicRouteMetadata(
      {
        route: { view: "products-cocalc-launchpad" },
        section: "products",
      },
      { site_name: "CoCalc" },
    );
    expect(launchpad.description).toContain("customer-operated");
    expect(launchpad.description).toContain("private deployment");

    const rocket = getPublicRouteMetadata(
      {
        route: { view: "products-cocalc-rocket" },
        section: "products",
      },
      { site_name: "CoCalc" },
    );
    expect(rocket.description).toContain("customer-operated");
    expect(rocket.description).toContain("private-cloud");
  });

  it("keeps teaching, support, pricing, and auth metadata public-facing", () => {
    const routes: PublicRoute[] = [
      {
        route: { slug: "teaching", view: "detail" },
        section: "features",
      },
      {
        route: { slug: "compare", view: "detail" },
        section: "features",
      },
      { section: "pricing" },
      { route: { view: "new" }, section: "support" },
      {
        route: { kind: "auth-form", view: "sign-up" },
        section: "auth",
      },
      {
        route: { kind: "auth-form", view: "sign-in" },
        section: "auth",
      },
    ];

    for (const route of routes) {
      const metadata = getPublicRouteMetadata(route, { site_name: "CoCalc" });
      expect(metadata.title).toContain("CoCalc");
      expect(metadata.description).not.toMatch(/serious technical work/i);
      expect(metadata.description).not.toMatch(/internal/i);
      expect(metadata.description).not.toMatch(/LMS replacement/i);
    }

    expect(
      getPublicRouteMetadata(routes[0], { site_name: "CoCalc" }).title,
    ).toBe("Technical Courses and Labs | CoCalc");
    expect(
      getPublicRouteMetadata(routes[3], { site_name: "CoCalc" }).description,
    ).toContain("pricing, deployment, product paths");
  });

  it("uses default CoCalc marketing metadata for default Launchpad branding", () => {
    const metadata = getPublicRouteMetadata(
      { section: "home" },
      {
        cocalc_product: "launchpad",
        is_launchpad: true,
        site_name: "CoCalc Launchpad",
      },
    );

    expect(metadata.title).toBe("CoCalc");
    expect(metadata.description).toContain("shared project workspace");
    expect(metadata.description).not.toMatch(/notebooks, code, documents/i);
  });

  it("can build canonical and image paths below a server base path", () => {
    const metadata = getPublicRouteMetadata(
      productRoute("products-cocalc-star"),
      { site_name: "CoCalc" },
      { basePath: "/base" },
    );

    expect(metadata.canonicalPath).toBe("/base/products/cocalc-star");
    expect(metadata.imagePath).toBe("/base/public/landing/product-options.jpg");
  });

  it("canonicalizes duplicated marketing routes to cocalc.ai on branded hosts", () => {
    const marketing = getPublicRouteMetadata(
      productRoute("products-cocalc-star"),
      { dns: "university.example.edu", site_name: "University CoCalc" },
      { basePath: "/university-cocalc" },
    );
    expect(marketing.canonicalPath).toBe(
      "https://cocalc.ai/products/cocalc-star",
    );

    const localNews = getPublicRouteMetadata(
      { route: { view: "news" }, section: "news" },
      { dns: "university.example.edu", site_name: "University CoCalc" },
    );
    expect(localNews.canonicalPath).toBe("/news");

    const localSignIn = getPublicRouteMetadata(
      {
        route: { kind: "auth-form", view: "sign-in" },
        section: "auth",
      },
      { dns: "university.example.edu", site_name: "University CoCalc" },
    );
    expect(localSignIn.canonicalPath).toBe("/auth/sign-in");
  });

  it("uses per-entry docs metadata for docs detail pages", () => {
    const route = getPublicMetadataRouteFromPath(
      "/docs/projects/project-secrets",
    );
    const metadata = getPublicRouteMetadata(route, { site_name: "CoCalc" });

    expect(metadata.title).toBe("Project secrets - Documentation | CoCalc");
    expect(metadata.description).toContain("encrypted, read-only files");
    expect(metadata.canonicalPath).toBe("/docs/projects/project-secrets");
  });

  it("does not collapse sitemap detail paths to section canonicals", () => {
    for (const [path, canonicalPath] of [
      ["/about/team", "/about/team"],
      ["/about/team/william-stein", "/about/team/william-stein"],
      ["/policies/privacy", "/policies/privacy"],
      ["/lang", "/lang"],
      ["/en", "/en"],
      ["/rootfs/ubuntu-24.04", "/rootfs/ubuntu-24.04"],
      ["/rootfs/id/rootfs-image-1", "/rootfs/id/rootfs-image-1"],
      ["/news/some-post-42", "/news/some-post-42"],
      ["/news/some-post-42/1751000000", "/news/some-post-42"],
    ] as const) {
      const route = getPublicMetadataRouteFromPath(path);
      const metadata = getPublicRouteMetadata(route, { site_name: "CoCalc" });
      expect(metadata.canonicalPath).toBe(canonicalPath);
    }
  });

  it("only emits routable feature detail pages in the public metadata sitemap", () => {
    const featurePaths = PUBLIC_SITEMAP_PATHS.filter((path) =>
      path.startsWith("/features/"),
    );
    expect(featurePaths).toEqual([
      ...getFeatureIndexPages().map((page) => `/features/${page.slug}`),
      "/features/slides",
    ]);
    expect(PUBLIC_SITEMAP_PATHS).toContain("/features/slides");
    expect(PUBLIC_SITEMAP_PATHS).not.toContain("/features/automations");
    expect(PUBLIC_SITEMAP_PATHS).not.toContain("/features/cli");
    expect(PUBLIC_SITEMAP_PATHS).not.toContain("/features/more-languages");
    expect(PUBLIC_SITEMAP_PATHS).not.toContain("/features/icons");
    expect(PUBLIC_SITEMAP_PATHS).not.toContain("/features/i18n");
    expect(PUBLIC_SITEMAP_PATHS).toContain("/about/team");
    expect(PUBLIC_SITEMAP_PATHS).toContain("/rootfs");
    expect(PUBLIC_SITEMAP_PATHS).not.toContain("/guides/rstudio-project");
    expect(PUBLIC_SITEMAP_PATHS).not.toContain("/policies/imprint");
  });

  it("applies canonical and social tags for the current public route", async () => {
    render(
      <PublicRouteHeadMetadata
        config={{ site_name: "CoCalc" }}
        route={{
          route: { view: "products-cocalc-star" },
          section: "products",
        }}
      />,
    );

    await waitFor(() =>
      expect(headMeta('meta[property="og:title"]')).toBe(
        "CoCalc Star | CoCalc",
      ),
    );
    expect(headMeta('meta[name="description"]')).toContain(
      "single-VM appliance",
    );
    expect(headMeta('meta[property="og:description"]')).toContain(
      "one public Ubuntu VM",
    );
    expect(headMeta('meta[name="twitter:card"]')).toBe("summary_large_image");
    expect(headMeta('meta[property="og:image"]')).toBe(
      "http://localhost/public/landing/product-options.jpg",
    );
    expect(canonicalHref()).toBe("https://cocalc.ai/products/cocalc-star");
  });

  it("keeps the branded-host marketing canonical after React mounts", async () => {
    render(
      <PublicRouteHeadMetadata
        config={{
          dns: "university.example.edu",
          site_name: "University CoCalc",
        }}
        route={productRoute("products-cocalc-star")}
      />,
    );

    await waitFor(() =>
      expect(canonicalHref()).toBe("https://cocalc.ai/products/cocalc-star"),
    );
    expect(headMeta('meta[property="og:url"]')).toBe(
      "https://cocalc.ai/products/cocalc-star",
    );
  });

  it("updates managed head tags when the route changes", async () => {
    const { rerender } = render(
      <PublicRouteHeadMetadata
        config={{ site_name: "CoCalc" }}
        route={productRoute("products-cocalc-star")}
      />,
    );

    await waitFor(() =>
      expect(canonicalHref()).toBe("https://cocalc.ai/products/cocalc-star"),
    );

    rerender(
      <PublicRouteHeadMetadata
        config={{ site_name: "CoCalc" }}
        route={{
          route: { view: "new" },
          section: "support",
        }}
      />,
    );

    await waitFor(() =>
      expect(headMeta('meta[property="og:title"]')).toBe(
        "Contact CoCalc Support | CoCalc",
      ),
    );
    expect(headMeta('meta[name="description"]')).toContain(
      "pricing, deployment, product paths",
    );
    expect(canonicalHref()).toBe("http://localhost/support/new");
  });
});

describe("robots noindex tag management", () => {
  it("adds noindex for restricted pages and removes it on navigation", () => {
    const base = {
      canonicalPath: "/docs/admin/users",
      description: "d",
      imagePath: "/i.png",
      title: "t",
    };
    applyPublicRouteMetadata({ ...base, noindex: true });
    expect(headMeta('meta[data-cocalc-public-route-meta="robots"]')).toBe(
      "noindex",
    );

    applyPublicRouteMetadata({ ...base, canonicalPath: "/docs" });
    expect(
      document.head.querySelector(
        'meta[data-cocalc-public-route-meta="robots"]',
      ),
    ).toBeNull();
  });
});
