/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getPublicFeaturePage } from "./public-feature-pages";
import { isPublicCocalcAiSite } from "./public-home-content";
import type { PublicRouteMetadataConfig } from "./public-site-metadata";

// First screen of the Features index (/features). The React page and the
// crawler fallback in hub/servers/app/public-prerender.ts both render these
// strings, so the two stay word for word the same.

export const PUBLIC_FEATURES_EYEBROW = "CoCalc features";

export const PUBLIC_FEATURES_HEADLINE =
  "Agents, software, and compute in one project.";

export const PUBLIC_FEATURES_SECONDARY_CTA = {
  href: "/features/ai",
  label: "Explore AI agents",
} as const;

export interface PublicFeaturesTask {
  body: string; // text between backticks is a command name
  href: string;
  id: "agents" | "software" | "compute" | "cli";
  title: string;
}

type Config = PublicRouteMetadataConfig | undefined;

// What each site offers. CoCalc Plus runs one local project with the software
// installed on the computer, without accounts or runtime images, and hides
// the CLI guides. Research Compute exists only where its feature page does.
// Claude Code and "Start on CoCalc.ai" appear only on cocalc.ai.
function site(config: Config) {
  return {
    cocalcAi: isPublicCocalcAiSite(config),
    compute: getPublicFeaturePage("research-compute", config ?? {}) != null,
    plus: config?.cocalc_product === "plus",
  };
}

export function getPublicFeaturesIntro(config: Config): string {
  const { compute, plus } = site(config);
  if (plus) {
    return "See what you can use in a CoCalc project: Codex agents and the software installed on your computer.";
  }
  const parts = [
    "Codex agents",
    "the CoCalc CLI",
    "installed software",
    ...(compute ? ["compute options"] : []),
  ];
  return `See what you can use in a CoCalc project: ${parts.join(", ")}, and tools such as Jupyter, LaTeX, R, Julia, and SageMath.`;
}

// The sign-up link for signed-out visitors. There is none until the product
// is known (in the browser, until /customize returns), so the label never
// changes after the first render and Plus never shows one.
export function getPublicFeaturesSignUp(
  config: Config,
): { href: string; label: string } | undefined {
  const { cocalcAi, plus } = site(config);
  if (!config?.cocalc_product || plus) return undefined;
  const label = cocalcAi ? "Start on CoCalc.ai" : "Create account";
  return { href: "/auth/sign-up", label };
}

export function getPublicFeaturesTasks(config: Config): PublicFeaturesTask[] {
  const { cocalcAi, compute, plus } = site(config);
  const ask = cocalcAi
    ? "Ask Codex, or Claude Code (experimental preview) with your personal Claude Pro or Max subscription, to build or use software."
    : "Ask Codex to build or use software.";
  const tasks: (PublicFeaturesTask | false)[] = [
    {
      body: `${ask} What it makes stays in the project, where you can open the files and the terminal yourself.`,
      href: "/features/ai",
      id: "agents",
      title: "Work with agents",
    },
    !plus && {
      body: "Use the software in your project's image, and open graphical Linux applications in projects with graphical support installed.",
      href: "/features/linux",
      id: "software",
      title: "Run project software",
    },
    compute && {
      body: "Move a project onto a dedicated machine, or connect a remote Jupyter kernel. See Research Compute for requirements.",
      href: "/features/research-compute",
      id: "compute",
      title: "Choose compute",
    },
    !plus && {
      body: "Script projects, files, and notebooks with the `cocalc` command inside your projects. See Get started with the CoCalc CLI to set it up on your own computer.",
      href: "/docs/cli/getting-started",
      id: "cli",
      title: "Automate with the CoCalc CLI",
    },
  ];
  return tasks.filter((task): task is PublicFeaturesTask => task !== false);
}
