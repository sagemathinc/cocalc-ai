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
  "Describe what you want, and an agent builds it in a project with your files and software. Review the result beside the conversation, then refine it or take over yourself.";

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

// The section after the hero: how working with an agent goes. Both renderings
// (see above) use these strings.
export const PUBLIC_HOME_AGENT_TITLE = "From an idea to something you can use.";

export const PUBLIC_HOME_AGENT_BODY =
  "Use the integrated Codex agent or Claude Code, or run other command-line agents in project terminals, all with the files, tools, and running services your collaborators already use. Claude Code is an experimental preview on sites that enable it and works with your personal Claude Pro or Max subscription.";

export const PUBLIC_HOME_AGENT_STEPS = [
  {
    body: "Say what you want and point the agent at your files. It works in the project, with the software installed there.",
    title: "Describe the outcome",
  },
  {
    body: "Open the app, report, or chart the agent saves, beside the conversation. Ask what it did and why.",
    title: "Review the result",
  },
  {
    body: "Ask for another version, or open the files, notebooks, and terminals and continue yourself.",
    title: "Refine or take over",
  },
] as const;

// Starter tasks in the Agents guide. The Agents workspace is part of the
// hosted products, so CoCalc Plus does not link them.
export const PUBLIC_HOME_AGENT_TASKS = [
  {
    href: "docs/ai/my-agents#turn-a-recurring-task-into-an-app",
    label: "Try an app task",
  },
  {
    href: "docs/ai/my-agents#investigate-a-change-in-your-data",
    label: "Try an analysis task",
  },
] as const;

export const PUBLIC_HOME_AGENT_LINKS = [
  { href: "features/ai", label: "See agent workflows" },
  { href: "features/compare", label: "Compare with agent sandboxes" },
] as const;

export function getPublicHomeAgentLinks(
  config?: PublicRouteMetadataConfig,
): ReadonlyArray<{ href: string; label: string }> {
  if (config?.cocalc_product === "plus") return PUBLIC_HOME_AGENT_LINKS;
  return [PUBLIC_HOME_AGENT_LINKS[0], ...PUBLIC_HOME_AGENT_TASKS];
}

// The hero image: the Agents workspace, with a published result open beside
// the conversation. CoCalc Plus has no Agents workspace, so it shows a
// project notebook instead.
export function getPublicHomeHeroImage(config?: PublicRouteMetadataConfig): {
  alt: string;
  height: number;
  src: string;
  width: number;
} {
  if (config?.cocalc_product === "plus") {
    return {
      alt: "A saved CoCalc Jupyter notebook with synthetic runtime results and TimeTravel and Agent controls",
      height: 650,
      src: "/public/landing/project-notebook-20260916.jpg",
      width: 1050,
    };
  }
  return {
    alt: "An agent conversation in CoCalc beside the dispatch reliability review it published, a dashboard of charts the reader can open, download, or comment on",
    height: 630,
    src: "/public/docs/agents-workspace-dispatch-review-20260924.jpg",
    width: 1180,
  };
}

// The default CoCalc brand: no custom logo, and the marketing site name is
// CoCalc (the default Launchpad brand maps to it).
function usesDefaultPublicBrand(config?: PublicRouteMetadataConfig): boolean {
  return (
    !config?.logo_square?.trim() &&
    getPublicMarketingSiteName(config) === SITE_NAME
  );
}

// cocalc.ai itself: the default CoCalc brand on the canonical host, never
// CoCalc Plus. Copy that uses this test names Claude Code, or CoCalc.ai as
// the sign-up destination, only where this is true.
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
