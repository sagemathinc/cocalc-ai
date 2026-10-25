/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  getPublicMarketingSiteName,
  type PublicRouteMetadataConfig,
} from "./public-site-metadata";
import {
  isCanonicalPublicSiteHost,
  isCocalcAiLaunchpad,
  PUBLIC_SIGN_UP_LABEL,
} from "./public-site-policy";
import { getPublicFeaturePage } from "./public-feature-pages";
import {
  getPublicHomeDeploymentChoice,
  PUBLIC_PRODUCTS_PAGE_LINK,
} from "./public-products-content";
import { getPublicPolicyPages } from "./public-site-metadata";
import { SITE_NAME } from "./theme";

// Home-specific content shared by the native page and anonymous initial HTML.
// Layout remains in frontend/public/home; this is not a general page renderer.
export const PUBLIC_HOME_HEADLINE = "Build and use software with AI.";
export const PUBLIC_HOME_INTRO =
  "Describe what you want to accomplish. Work with an agent to build applications, use software or analyze information, then review and refine the results beside the conversation.";
export const PUBLIC_HOME_SECTION_TITLES = {
  process: "From an idea to something you can use.",
  platform: "Keep the work moving together.",
  outcomes: "Choose the kind of result you need.",
  evaluation: "Find the right setup for your work.",
  deployment: "Choose how to run CoCalc.",
  final: "What would you like to accomplish?",
} as const;

export const PUBLIC_HOME_OUTCOMES_INTRO =
  "Start with the outcome you need. Explore the tools behind it when you want to go further.";
export const PUBLIC_HOME_EVALUATION_INTRO =
  "Check the software, access and computing resources your workflow needs.";
export const PUBLIC_HOME_CONTACT = { href: "support", label: "Talk to us" };
export const PUBLIC_HOME_TRUST_LABEL = "Review trust and compliance";

export interface PublicHomeLink {
  href: string;
  label: string;
}
export interface PublicHomeItem {
  title: string;
  body: string;
  link?: PublicHomeLink;
}
export interface PublicHomeConfig extends PublicRouteMetadataConfig {
  is_authenticated?: boolean;
  openai_disabled?: boolean;
}
export interface PublicHomeImage {
  alt: string;
  src: string;
  width: number;
  height: number;
}
export interface PublicHomeContent {
  title: string;
  intro: string;
  primary?: PublicHomeLink;
  secondary: PublicHomeLink;
  image?: PublicHomeImage;
  process: PublicHomeItem[];
  platformTitle: string;
  benefits: PublicHomeItem[];
  outcomes: PublicHomeItem[];
  directories: { title: string; links: PublicHomeLink[] }[];
  agents: { title: string; paragraphs: string[]; links: PublicHomeLink[] };
  deployment?: { body: string; link: PublicHomeLink };
  trustHref?: string;
}

export function getPublicHomeHeroImage(
  config?: PublicRouteMetadataConfig,
): PublicHomeImage {
  if (config?.cocalc_product === "plus") {
    return {
      alt: "A saved CoCalc Jupyter notebook with TimeTravel and Agent controls",
      height: 650,
      src: "/public/landing/project-notebook-20260916.jpg",
      width: 1050,
    };
  }
  return {
    alt: "CoCalc's form for a new agent, asking ‘What should your new agent do?’ above an empty request box.",
    height: 280,
    src: "/public/docs/agent-new-form-20261015.jpg",
    width: 884,
  };
}

export function getPublicHomeContent(
  config?: PublicHomeConfig,
): PublicHomeContent {
  const plus = config?.cocalc_product === "plus";
  const hosted =
    config?.cocalc_product === "launchpad" ||
    config?.cocalc_product === "rocket";
  const knownProduct = plus || hosted;
  const agent = knownProduct && config?.openai_disabled !== true;
  const workspace = hosted && agent;
  const canonical = isCocalcAiLaunchpad(config) && isPublicCocalcAiSite(config);
  const browser =
    hosted && getPublicFeaturePage("web-browser", config ?? {}) != null;
  const compute =
    getPublicFeaturePage("research-compute", config ?? {}) != null;
  const terminal = { href: "features/terminal", label: "Explore the terminal" };
  const primary = !knownProduct
    ? config?.is_authenticated
      ? { href: "projects", label: "Open projects" }
      : isCanonicalPublicSiteHost(config?.dns)
        ? { href: "auth/sign-up", label: PUBLIC_SIGN_UP_LABEL }
        : undefined
    : plus
      ? { href: "projects", label: "Open your project" }
      : config?.is_authenticated
        ? {
            href: agent ? "agents" : "projects",
            label: agent ? "Open your agents" : "Open projects",
          }
        : {
            href: "auth/sign-up",
            label: canonical ? "Start on CoCalc.ai" : PUBLIC_SIGN_UP_LABEL,
          };
  const benefits: PublicHomeItem[] = [];
  if (workspace)
    benefits.push({
      title: "Let agents coordinate",
      body: "Connect agents in Agent Networks so they can exchange messages without you relaying them.",
      link: {
        href: "docs/ai/agent-features#agent-networks",
        label: "Agent Networks",
      },
    });
  if (hosted)
    benefits.push({
      title: "Bring people into the work",
      body: workspace
        ? "Invite colleagues into the same agent conversation and project. Review results together and contribute to the same files."
        : "Work in the same project and see edits as they happen. Review results together and contribute to the same files.",
      link: {
        href: "docs/projects/collaborators",
        label: "Add project collaborators",
      },
    });
  benefits.push({
    title: "Continue and recover your work",
    body:
      "Return to saved work and keep improving it. TimeTravel lets you inspect and recover earlier versions of supported files." +
      (canonical
        ? " CoCalc.ai also provides file recovery from snapshots and backups."
        : ""),
    link: { href: "docs/files/timetravel", label: "History and recovery" },
  });
  const internet = canonical
    ? "a membership with internet access"
    : "internet access enabled for the project";
  const outcomes: PublicHomeItem[] = [
    {
      title: "An application for your work",
      body: workspace
        ? "Turn a recurring task into an app: a planning tool, an interactive report or a dashboard. Ask the agent to change how it looks and works."
        : "Turn a recurring task into an application or a program you can run again. Keep its code and output together as you refine it.",
      link:
        workspace && browser
          ? {
              href: "docs/ai/my-agents#turn-a-recurring-task-into-an-app",
              label: "Try an application task",
            }
          : browser
            ? {
                href: "docs/projects/web-browser",
                label: "Build and test web apps",
              }
            : terminal,
    },
    {
      title: browser
        ? "Use the software your work depends on"
        : "A process you can repeat",
      body: browser
        ? (workspace
            ? "Let an agent use installed programs or work through websites in the project's browser. Take over to sign in when needed. "
            : "Use installed programs and websites in the project's browser. ") +
          `Browsing the web needs ${internet}.`
        : plus
          ? "Work with programs installed on your computer. Use their commands and files to automate a process, with direct access when you need it."
          : "Use installed programs and scripts to carry out a recurring process. Keep the inputs, instructions and results together.",
      link: browser
        ? { href: "features/web-browser", label: "Explore the shared browser" }
        : plus
          ? terminal
          : {
              href: "features/software-environment",
              label: "Explore software environments",
            },
    },
    {
      title: "An analysis you can explore",
      body: workspace
        ? "Compare scenarios, investigate a dataset or run a simulation. Ask an agent for visual results, question the conclusions and try different inputs."
        : "Compare scenarios, investigate a dataset or run a simulation. Review visual results, then change the inputs and continue.",
      link: workspace
        ? {
            href: "docs/ai/my-agents#investigate-a-change-in-your-data",
            label: "Try an analysis task",
          }
        : compute
          ? {
              href: "features/research-compute",
              label: "Explore compute options",
            }
          : { href: "features/python", label: "Explore analysis tools" },
    },
  ];
  if (canonical)
    outcomes.push({
      title: "An environment for someone else",
      body: "Prepare installed software for clients or colleagues to use in their own projects. Publishing a project image requires a membership that includes publishing.",
      link: {
        href: "docs/projects/publish-rootfs",
        label: "Publish project images",
      },
    });
  const implementationLinks: PublicHomeLink[] = [
    { href: "docs", label: "Read the documentation" },
  ];
  if (hosted)
    implementationLinks.push({
      href: "docs/cli/use-cocalc-cli",
      label: "Use the CoCalc CLI",
    });
  if (compute)
    implementationLinks.push({
      href: "docs/hosts/choose-compute",
      label: "Choose computing resources",
    });
  if (workspace)
    implementationLinks.push({
      href: "docs/ai/cocalc-access",
      label: "Give an agent CoCalc access",
    });
  return {
    title: agent ? PUBLIC_HOME_HEADLINE : "Build and use software.",
    intro: workspace
      ? PUBLIC_HOME_INTRO
      : agent
        ? "Describe what you want to build or automate. Work with an agent using the files and software on your computer, then review its changes and continue the conversation."
        : "Build applications, analyze information and work with your files and software.",
    primary,
    secondary: agent
      ? { href: "features/ai", label: "See how agents work" }
      : { href: "features", label: "Explore the tools" },
    image: workspace || plus ? getPublicHomeHeroImage(config) : undefined,
    process: agent
      ? [
          {
            title: "Describe the outcome",
            body: "Explain what you want to accomplish and provide the files or context. The agent works with the software available to it.",
          },
          {
            title: "Review the result",
            body: workspace
              ? "Open a report or visualization beside the conversation. Ask questions about what it shows."
              : "Inspect the output and the changes the agent made. Ask questions about the result.",
          },
          {
            title: "Refine through conversation",
            body: "Change the instructions and ask for another version. Open the underlying files or tools whenever you want direct control.",
          },
        ]
      : [],
    platformTitle: hosted
      ? PUBLIC_HOME_SECTION_TITLES.platform
      : "Keep control of what you create.",
    benefits,
    outcomes,
    directories: [
      {
        title: "Explore the platform",
        links: [
          { href: "features", label: "Browse capabilities" },
          { href: "features/compare", label: "Decide whether CoCalc fits" },
          plus
            ? terminal
            : {
                href: "features/software-environment",
                label: "Find software and tools",
              },
          ...(canonical
            ? [{ href: "pricing", label: "Compare memberships" }]
            : []),
        ],
      },
      { title: "Plan an implementation", links: implementationLinks },
    ],
    agents: {
      title: agent
        ? "Which agents can I use?"
        : "Can I use command-line agents?",
      paragraphs:
        canonical && agent
          ? [
              "Use Codex or Claude with the access available to your account. Connect your own subscription or API key, or use an eligible membership’s included AI allowance.",
            ]
          : plus && agent
            ? [
                "CoCalc Plus includes local Codex support. Connect your own supported subscription or API key.",
                "Other command-line agents can run in a terminal on your computer with the access, software and credentials they require.",
              ]
            : agent
              ? [
                  "Connect the AI access available on your site. Provider choices and membership allowances are configured by your site operator.",
                ]
              : [
                  "In projects with internet access, run command-line agents in project terminals with the tools and credentials they need.",
                ],
      links:
        agent && !plus
          ? [
              {
                href: "docs/ai/connect-credentials",
                label: "Connect AI access",
              },
              ...(canonical
                ? [{ href: "docs/ai/claude-code", label: "Use Claude Code" }]
                : []),
            ]
          : [terminal],
    },
    deployment:
      canonical || plus
        ? {
            body: getPublicHomeDeploymentChoice(),
            link: PUBLIC_PRODUCTS_PAGE_LINK,
          }
        : undefined,
    trustHref:
      getPublicPolicyPages(config) === "sagemathinc"
        ? "policies/trust"
        : undefined,
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
