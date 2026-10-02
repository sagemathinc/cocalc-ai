/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  getPublicMarketingSiteName,
  type PublicRouteMetadataConfig,
} from "./public-site-metadata";
import { isCanonicalPublicSiteHost } from "./public-site-policy";
import { SITE_NAME } from "./theme";

// First screen of the public Home page. The React page and the crawler
// fallback in hub/servers/app/public-prerender.ts both render these strings,
// so the two stay word for word the same.

export const PUBLIC_HOME_EYEBROW = "CoCalc";

export const PUBLIC_HOME_HEADLINE = "Build and use software with AI.";

export const PUBLIC_HOME_INTRO =
  "Agents work in a shared project with your files, software, and collaborators. Open what they save, or take over the work yourself.";

export const PUBLIC_HOME_SECONDARY_CTA = {
  href: "features/ai",
  label: "See how it works",
} as const;

export const PUBLIC_HOME_AGENTS_HIGHLIGHT =
  "Codex and Claude Code in one project";

export const PUBLIC_HOME_COLLABORATION_HIGHLIGHT =
  "Collaborators see edits live";

export const PUBLIC_HOME_HIGHLIGHTS = [
  PUBLIC_HOME_AGENTS_HIGHLIGHT,
  PUBLIC_HOME_COLLABORATION_HIGHLIGHT,
  "Restore earlier versions",
] as const;

// The default CoCalc brand: no custom logo, and the marketing site name is
// CoCalc (the default Launchpad brand maps to it).
function usesDefaultPublicBrand(config?: PublicRouteMetadataConfig): boolean {
  return (
    !config?.logo_square?.trim() &&
    getPublicMarketingSiteName(config) === SITE_NAME
  );
}

// cocalc.ai itself: the default CoCalc brand on the canonical host, never
// CoCalc Plus. Copy that uses this test (Home's agents highlight and the
// Features index first screen) names Claude Code, or CoCalc.ai as the sign-up
// destination, only where this is true.
// `config.dns` is the request host on both sides: the crawler
// fallback reads it from the request, and /customize sets it from the Host
// header for the browser.
export function isPublicCocalcAiSite(
  config?: PublicRouteMetadataConfig,
): boolean {
  return (
    config?.cocalc_product !== "plus" &&
    usesDefaultPublicBrand(config) &&
    isCanonicalPublicSiteHost(config?.dns)
  );
}

// CoCalc Plus is the local, one-user runtime, as the Products and Pricing
// pages say for the same product. It has no collaborators, so it also drops
// the collaboration highlight and keeps only the version history one.
//
// The highlight that names Claude Code shows only on cocalc.ai (above). Other
// hosted sites get the other two highlights; Plus does not offer collaboration.
export function getPublicHomeHighlights(
  config?: PublicRouteMetadataConfig,
): readonly string[] {
  if (config?.cocalc_product === "plus") {
    return PUBLIC_HOME_HIGHLIGHTS.filter(
      (highlight) =>
        highlight !== PUBLIC_HOME_AGENTS_HIGHLIGHT &&
        highlight !== PUBLIC_HOME_COLLABORATION_HIGHLIGHT,
    );
  }
  if (isPublicCocalcAiSite(config)) {
    return PUBLIC_HOME_HIGHLIGHTS;
  }
  return PUBLIC_HOME_HIGHLIGHTS.filter(
    (highlight) => highlight !== PUBLIC_HOME_AGENTS_HIGHLIGHT,
  );
}

export const PUBLIC_HOME_TRUST_LINE =
  "Developed by SageMath, Inc. · Collaborative computing online since 2013";
