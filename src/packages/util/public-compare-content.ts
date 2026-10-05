/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  getPublicFeaturePage,
  type PublicFeatureSection,
} from "./public-feature-pages";
import { isCanonicalPublicSiteHost } from "./public-site-policy";

// The Compare page (/features/compare). The React page and the crawler
// fallback in hub/servers/app/public-prerender.ts both render these strings,
// so the two stay word for word the same.

export interface PublicCompareConfig {
  cocalc_product?: string;
  dns?: string;
}

// The record's collaboration bullet, as every site may show it.
export const PUBLIC_COMPARE_COLLABORATION_BULLET =
  "Collaborators need live work and history in the same project";

// cocalc.ai projects have snapshots and backups. Elsewhere they depend on
// the site's project runtime and backup setup, so only cocalc.ai names them.
export const PUBLIC_COMPARE_COCALC_AI_COLLABORATION_BULLET =
  "Collaborators need live work, history, snapshots, and backups in the same project";

// cocalc.ai is Launchpad on the canonical host. `config.dns` is the request
// host on both sides: the crawler fallback reads it from the request, and
// /customize sets it from the Host header for the browser.
function isCocalcAi(config?: PublicCompareConfig): boolean {
  return (
    config?.cocalc_product === "launchpad" &&
    isCanonicalPublicSiteHost(config.dns)
  );
}

// The Compare record's sections for this site. CoCalc Plus is for one person
// and has no collaborators, so it drops the collaboration bullet.
export function getPublicCompareSections(
  config?: PublicCompareConfig,
): PublicFeatureSection[] {
  const sections = getPublicFeaturePage("compare")?.sections ?? [];
  const collaboration: string[] =
    config?.cocalc_product === "plus"
      ? []
      : isCocalcAi(config)
        ? [PUBLIC_COMPARE_COCALC_AI_COLLABORATION_BULLET]
        : [PUBLIC_COMPARE_COLLABORATION_BULLET];
  return sections.map((section) =>
    section.bullets == null
      ? section
      : {
          ...section,
          bullets: section.bullets.flatMap((bullet) =>
            bullet === PUBLIC_COMPARE_COLLABORATION_BULLET
              ? collaboration
              : [bullet],
          ),
        },
  );
}
