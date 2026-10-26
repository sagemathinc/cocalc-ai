/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  getPublicFeaturePage,
  type PublicFeatureSection,
} from "./public-feature-pages";
import { getPublicCompareDeploymentBullet } from "./public-products-content";
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

// The record's operating-boundary bullet, which names every way to run
// CoCalc. The page shows only the ways the public pages present.
export const PUBLIC_COMPARE_DEPLOYMENT_BULLET =
  "You need a hosted service, a local or single-VM installation, or a customer-operated private deployment path";

// What cocalc.ai keeps for every project, and how it keeps up on hosts that
// many projects share. Shown on cocalc.ai only: elsewhere history and backups
// depend on the site's runtime and backup setup. No schedules or retention
// numbers: those depend on the project's runtime and configured schedules
// (docs/research/recover-work).
export const PUBLIC_COMPARE_HISTORY_TITLE =
  "History and backups in every project";
export const PUBLIC_COMPARE_SCALE_TITLE =
  "Built for many projects on every host";

export const PUBLIC_COMPARE_HISTORY_SECTIONS: PublicFeatureSection[] = [
  {
    title: PUBLIC_COMPARE_HISTORY_TITLE,
    paragraphs: [
      "Every CoCalc.ai project keeps its history with nothing to set up. TimeTravel records earlier versions of each document, scheduled snapshots capture the project's files, and backups stored off the host can include the files, the system environment, and the edit history.",
      "The people and AI agents working in a project can recover work themselves, from Recovery in the project's Files or with the CoCalc CLI. When an agent edits real work, you can see what it changed and bring back an earlier version from TimeTravel, a snapshot, or a backup.",
    ],
    cards: [
      {
        title: "A virtual machine per user",
        body: "Snapshots and backups are possible, but someone has to set them up, watch them, and pay for them on every machine, and restoring usually needs an administrator.",
      },
      {
        title: "Ephemeral agent sandboxes",
        body: "Built for short runs. Some services offer snapshots or persistent volumes; otherwise the environment and its history end with the run, so results have to be saved somewhere else.",
      },
      {
        title: "A CoCalc.ai project",
        body: "History, snapshots, and backups are part of the project from the start, on by default for every project, and restorable by the people and agents who work in it.",
      },
    ],
    links: [
      { href: "/docs/research/recover-work", label: "How recovery works" },
      { href: "/docs/files/timetravel", label: "Use TimeTravel" },
    ],
  },
  {
    title: PUBLIC_COMPARE_SCALE_TITLE,
    paragraphs: [
      "Regular snapshots and backups are simple for one machine. On CoCalc.ai, thousands of projects can share a host, and every one needs its own schedule without slowing down the people working on that host.",
    ],
    bullets: [
      "Snapshots and backups run in separate queues on each host, so a long backup does not hold up snapshots",
      "Maintenance waits while the host's disk is busy, so interactive work comes first",
      "Accounts take turns, so one large account cannot crowd out everyone else",
      "Deleting old snapshots waits while a backup or a project start is running on the host",
    ],
  },
];

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
// and has no collaborators, so it drops the collaboration bullet. The
// operating-boundary bullet names only the products the public pages show.
// cocalc.ai adds its history and backup sections. The browser passes
// `cocalcAi` from isCocalcAiLaunchpadSite, which decides by the page's host
// until /customize arrives, so cocalc.ai doesn't render the page without them
// first (or for good, if /customize fails).
export function getPublicCompareSections(
  config?: PublicCompareConfig,
  { cocalcAi = isCocalcAi(config) }: { cocalcAi?: boolean } = {},
): PublicFeatureSection[] {
  const sections = getPublicFeaturePage("compare")?.sections ?? [];
  const collaboration: string[] =
    config?.cocalc_product === "plus"
      ? []
      : cocalcAi
        ? [PUBLIC_COMPARE_COCALC_AI_COLLABORATION_BULLET]
        : [PUBLIC_COMPARE_COLLABORATION_BULLET];
  const history = cocalcAi ? PUBLIC_COMPARE_HISTORY_SECTIONS : [];
  return [...sections, ...history].map((section) =>
    section.bullets == null
      ? section
      : {
          ...section,
          bullets: section.bullets.flatMap((bullet) =>
            bullet === PUBLIC_COMPARE_COLLABORATION_BULLET
              ? collaboration
              : bullet === PUBLIC_COMPARE_DEPLOYMENT_BULLET
                ? [getPublicCompareDeploymentBullet()]
                : [bullet],
          ),
        },
  );
}
