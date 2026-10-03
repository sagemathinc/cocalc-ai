/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  getPublicFeaturePage,
  type PublicFeatureSection,
} from "./public-feature-pages";
import { isPublicCocalcAiSite } from "./public-home-content";
import type { PublicRouteMetadataConfig } from "./public-site-metadata";

// Words of the AI Agents page (/features/ai) beyond its feature record. The
// React page and the crawler fallback in hub/servers/app/public-prerender.ts
// both render these strings and the record's sections, so the two stay word
// for word the same.

export const PUBLIC_AI_CLAUDE_HEADLINE =
  "Codex and Claude Code, side by side in one project.";

// The headline names Claude Code only where Home's first screen does; other
// sites keep the record's tagline, which does not name it.
export function getPublicAiHeadline(
  config?: PublicRouteMetadataConfig,
): string {
  return isPublicCocalcAiSite(config)
    ? PUBLIC_AI_CLAUDE_HEADLINE
    : getPublicFeaturePage("ai")!.tagline;
}

export const PUBLIC_AI_INTRO =
  "Use integrated Codex or terminal-based agents beside the same project files, live notebooks, Linux terminals, applications, and collaborators. Inspect the work as it happens, open what the agent saves, and continue from the same context.";

export const PUBLIC_AI_MENTIONS_LINE =
  "Human @mentions notify collaborators; they do not invoke models.";

// A Launchpad or Rocket site, once its configuration says so. CoCalc Plus runs
// one local project without collaborators, and before the configuration
// arrives the product is not known.
function isKnownHostedSite(
  config?: Pick<PublicRouteMetadataConfig, "cocalc_product">,
): boolean {
  return (
    config?.cocalc_product === "launchpad" ||
    config?.cocalc_product === "rocket"
  );
}

// The page's agent cards: the AI record's sections, and on hosted sites the
// line about @mentions after the first card's paragraph.
export function getPublicAiCards(
  config?: Pick<PublicRouteMetadataConfig, "cocalc_product">,
): readonly PublicFeatureSection[] {
  const [first, ...rest] = getPublicFeaturePage("ai")!.sections!;
  if (!isKnownHostedSite(config)) {
    return [first, ...rest];
  }
  return [
    {
      ...first,
      paragraphs: [...(first.paragraphs ?? []), PUBLIC_AI_MENTIONS_LINE],
    },
    ...rest,
  ];
}
