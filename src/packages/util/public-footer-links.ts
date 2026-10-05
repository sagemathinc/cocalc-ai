/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The fixed page links of the public footer. The React footer and the crawler
// fallback in hub/servers/app/public-prerender.ts both render these, so the
// initial HTML links the same pages, by the same names, as the footer people
// see. Links that depend on site settings or on JavaScript (Status, Contact,
// Policies, Cookies) are only in the React footer.

export interface PublicFooterLink {
  label: string;
  // Relative to the site's base path.
  path: string;
}

export const PUBLIC_FOOTER_PLATFORM_LINKS: readonly PublicFooterLink[] = [
  { label: "Features", path: "features" },
  { label: "Products", path: "products" },
  { label: "Pricing", path: "pricing" },
];

export const PUBLIC_FOOTER_RESOURCES_LINKS: readonly PublicFooterLink[] = [
  { label: "Documentation", path: "docs" },
  { label: "Guides", path: "guides" },
  { label: "Support", path: "support" },
];

export const PUBLIC_FOOTER_COMPANY_LINKS: readonly PublicFooterLink[] = [
  { label: "About", path: "about" },
  { label: "News", path: "news" },
];
