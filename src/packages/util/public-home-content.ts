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

export const PUBLIC_HOME_HIGHLIGHTS = [
  PUBLIC_HOME_AGENTS_HIGHLIGHT,
  "Collaborators see edits live",
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

// Claude Code runs only on sites that enable it, so the highlight that names
// it shows only under the default CoCalc brand on cocalc.ai. Every other site
// (CoCalc Plus, a self-hosted Launchpad, a custom brand) gets the other two
// highlights. `config.dns` is the request host on both sides: the crawler
// fallback reads it from the request, and /customize sets it from the Host
// header for the browser.
export function getPublicHomeHighlights(
  config?: PublicRouteMetadataConfig,
): readonly string[] {
  if (
    usesDefaultPublicBrand(config) &&
    isCanonicalPublicSiteHost(config?.dns)
  ) {
    return PUBLIC_HOME_HIGHLIGHTS;
  }
  return PUBLIC_HOME_HIGHLIGHTS.filter(
    (highlight) => highlight !== PUBLIC_HOME_AGENTS_HIGHLIGHT,
  );
}

export const PUBLIC_HOME_TRUST_LINE =
  "Developed by SageMath, Inc. · Collaborative computing online since 2013";
