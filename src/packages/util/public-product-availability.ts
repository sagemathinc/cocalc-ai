/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Which CoCalc products the public pages present: one switch per product, in
// this one place. The products page and its cards, links from other public
// pages, the feature pages' sentences about CoCalc Plus, the guides, the
// sitemap, route metadata, the redirects of hidden product pages, and both
// renderers (the React pages and the crawler fallback in
// hub/servers/app/public-prerender.ts) read these switches. The top
// navigation and the footer link only to the products page, which stays.
//
// The public pages present only products whose public release is current.
// CoCalc Plus is shown because its release channel serves release 1792043311,
// built on 2026-10-15. CoCalc Launchpad is hidden because its public release
// channel still serves 2026-07-01 builds, and CoCalc Rocket because it has no
// published release. A hidden product keeps its page and copy in the code,
// and its routes redirect temporarily to the products page. Before turning a
// switch on, update that product's copy in public-products-content as the
// comments on its page say (for Launchpad, the install command and its
// install script and software page links). Then set the switch to true when
// its release channel carries a build from current main: its page, links and
// sitemap entry return.

export type PublicProductId = "plus" | "star" | "launchpad" | "rocket";

export const PUBLIC_PRODUCT_AVAILABILITY: Record<PublicProductId, boolean> = {
  plus: true,
  star: true,
  launchpad: false,
  rocket: false,
};

export interface PublicProduct {
  id: PublicProductId;
  name: string;
  // The name after "CoCalc", where the copy has already said CoCalc.
  shortName: string;
  // The page's path segment under /products.
  slug: string;
}

// In the order the public pages list them.
export const PUBLIC_PRODUCTS: readonly PublicProduct[] = [
  {
    id: "plus",
    name: "CoCalc Plus",
    shortName: "Plus",
    slug: "cocalc-plus",
  },
  {
    id: "star",
    name: "CoCalc Star",
    shortName: "Star",
    slug: "cocalc-star",
  },
  {
    id: "launchpad",
    name: "CoCalc Launchpad",
    shortName: "Launchpad",
    slug: "cocalc-launchpad",
  },
  {
    id: "rocket",
    name: "CoCalc Rocket",
    shortName: "Rocket",
    slug: "cocalc-rocket",
  },
];

// The products page, relative to the site's base path. A hidden product's
// page redirects here.
export const PUBLIC_PRODUCTS_PATH = "products";

// Temporary, because a hidden product returns at the same address.
export const HIDDEN_PUBLIC_PRODUCT_REDIRECT_STATUS = 302;

export function isPublicProductShown(id: PublicProductId): boolean {
  return PUBLIC_PRODUCT_AVAILABILITY[id] === true;
}

// Whether a page may describe CoCalc Plus to visitors of this site: while the
// public pages show Plus, and on a CoCalc Plus install, whose pages describe
// the product in use. Both renderers of the feature pages follow this rule
// for the sentences that compare Plus with a hosted project.
export function describesPublicPlus(config?: {
  cocalc_product?: string;
}): boolean {
  return isPublicProductShown("plus") || config?.cocalc_product === "plus";
}

export function getShownPublicProducts(): PublicProduct[] {
  return PUBLIC_PRODUCTS.filter(({ id }) => isPublicProductShown(id));
}

export function getPublicProduct(id: PublicProductId): PublicProduct {
  return PUBLIC_PRODUCTS.find((product) => product.id === id)!;
}

// The route view of a product page, as the route parsers name it.
export function publicProductView(product: PublicProduct): string {
  return `products-${product.slug}`;
}

// The product whose page has this route view, shown or hidden. The exported
// lookups below also read the switches.
function getPublicProductByView(view?: string): PublicProduct | undefined {
  return PUBLIC_PRODUCTS.find((product) => publicProductView(product) === view);
}

// The page of a product the public pages present.
export function getShownPublicProductByView(
  view?: string,
): PublicProduct | undefined {
  const product = getPublicProductByView(view);
  return product != null && isPublicProductShown(product.id)
    ? product
    : undefined;
}

// Where a route redirects to, relative to the site's base path: the products
// page for a hidden product's page, nothing for every other route.
export function getHiddenPublicProductRedirect(
  view?: string,
): string | undefined {
  const product = getPublicProductByView(view);
  return product != null && !isPublicProductShown(product.id)
    ? PUBLIC_PRODUCTS_PATH
    : undefined;
}

// The names of the shown products among `ids`, in the order of `ids`.
export function shownPublicProductNames(
  ids: readonly PublicProductId[],
  { short = false }: { short?: boolean } = {},
): string[] {
  return ids
    .filter((id) => isPublicProductShown(id))
    .map((id) => {
      const product = getPublicProduct(id);
      return short ? product.shortName : product.name;
    });
}
