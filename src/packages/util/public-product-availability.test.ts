import {
  getHiddenPublicProductRedirect,
  getShownPublicProductByView,
  getShownPublicProducts,
  HIDDEN_PUBLIC_PRODUCT_REDIRECT_STATUS,
  PUBLIC_PRODUCT_AVAILABILITY,
  PUBLIC_PRODUCTS,
  publicProductView,
  shownPublicProductNames,
} from "./public-product-availability";
import { buildPublicSitemapPaths } from "./public-site-metadata";

afterEach(() => jest.restoreAllMocks());

const HIDDEN_VIEWS = ["products-cocalc-launchpad", "products-cocalc-rocket"];

describe("public product availability", () => {
  it("shows CoCalc Plus and Star, and hides the products without a current release", () => {
    expect(PUBLIC_PRODUCT_AVAILABILITY).toEqual({
      launchpad: false,
      plus: true,
      rocket: false,
      star: true,
    });
    expect(getShownPublicProducts().map(({ name }) => name)).toEqual([
      "CoCalc Plus",
      "CoCalc Star",
    ]);
    expect(PUBLIC_PRODUCTS.map(publicProductView)).toEqual([
      "products-cocalc-plus",
      "products-cocalc-star",
      "products-cocalc-launchpad",
      "products-cocalc-rocket",
    ]);
  });

  it("redirects a hidden product's page temporarily to the products page", () => {
    expect(HIDDEN_PUBLIC_PRODUCT_REDIRECT_STATUS).toBe(302);
    for (const view of HIDDEN_VIEWS) {
      expect(getHiddenPublicProductRedirect(view)).toBe("products");
      expect(getShownPublicProductByView(view)).toBeUndefined();
    }
    for (const view of [
      "products",
      "products-cocalc-plus",
      "products-cocalc-star",
      "products-unknown",
      undefined,
    ]) {
      expect(getHiddenPublicProductRedirect(view)).toBeUndefined();
    }
    expect(getShownPublicProductByView("products-cocalc-plus")?.id).toBe(
      "plus",
    );
    expect(getShownPublicProductByView("products-cocalc-star")?.id).toBe(
      "star",
    );
  });

  it("lists the shown products in the sitemap and leaves the hidden ones out", () => {
    const paths = buildPublicSitemapPaths({ policy_pages: "sagemathinc" });
    expect(paths.filter((path) => path.startsWith("/products"))).toEqual([
      "/products",
      "/products/cocalc-plus",
      "/products/cocalc-star",
    ]);
  });

  it("hides a product again with its switch", () => {
    jest.replaceProperty(PUBLIC_PRODUCT_AVAILABILITY, "plus", false);

    expect(getHiddenPublicProductRedirect("products-cocalc-plus")).toBe(
      "products",
    );
    expect(getShownPublicProductByView("products-cocalc-plus")).toBeUndefined();
    expect(
      buildPublicSitemapPaths({ policy_pages: "sagemathinc" }).filter((path) =>
        path.startsWith("/products"),
      ),
    ).toEqual(["/products", "/products/cocalc-star"]);
  });

  it("brings a product back with its switch", () => {
    jest.replaceProperty(PUBLIC_PRODUCT_AVAILABILITY, "launchpad", true);

    expect(getHiddenPublicProductRedirect("products-cocalc-launchpad")).toBe(
      undefined,
    );
    expect(getShownPublicProductByView("products-cocalc-launchpad")?.name).toBe(
      "CoCalc Launchpad",
    );
    expect(getHiddenPublicProductRedirect("products-cocalc-rocket")).toBe(
      "products",
    );
    expect(
      shownPublicProductNames(["star", "launchpad"], { short: true }),
    ).toEqual(["Star", "Launchpad"]);
    expect(
      buildPublicSitemapPaths({ policy_pages: "sagemathinc" }).filter((path) =>
        path.startsWith("/products"),
      ),
    ).toEqual([
      "/products",
      "/products/cocalc-plus",
      "/products/cocalc-star",
      "/products/cocalc-launchpad",
    ]);
  });

  it("lists every product page in the sitemap when every product is shown", () => {
    for (const id of ["plus", "launchpad", "rocket"] as const) {
      jest.replaceProperty(PUBLIC_PRODUCT_AVAILABILITY, id, true);
    }
    expect(
      buildPublicSitemapPaths({ policy_pages: "sagemathinc" }).filter((path) =>
        path.startsWith("/products"),
      ),
    ).toEqual([
      "/products",
      "/products/cocalc-plus",
      "/products/cocalc-star",
      "/products/cocalc-launchpad",
      "/products/cocalc-rocket",
    ]);
  });
});
