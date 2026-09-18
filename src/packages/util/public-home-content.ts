/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Shared by the public homepage, its initial HTML and its search description.
// Keep operational detail in linked guides, not in a second marketing corpus.
export const PUBLIC_HOME_CONTENT = {
  showExample: true,
  showHosting: true,
  hero: {
    eyebrow: "A workspace for people and AI agents",
    title: "Work with AI. Review the results. Keep building.",
    description:
      "Create reports, explore data or develop applications in one shared workspace. Open the files, check the output and bring other people into the work when you need them.",
    startLabel: "Start on CoCalc.ai",
    startHref: "auth/sign-up",
    returningLabel: "Open projects",
    secondary: { href: "features/ai", label: "Explore AI workflows" },
    example: {
      title: "Explore an idea. See what changes.",
      description:
        "Change demand or solar generation to compare energy use in this Python dashboard running in CoCalc. All data is synthetic.",
      image: "public/landing/energy-dashboard-20260917.jpg",
      alt: "Energy scenario dashboard running in CoCalc, with synthetic demand and solar plots, summary figures and hourly grid use",
      width: 1512,
      height: 1245,
      guide: {
        href: "docs/research/private-dashboard#try-the-energy-scenario-explorer",
        label: "How this example works",
      },
      fullSizeLabel: "View full-size screenshot",
    },
  },
  benefits: {
    eyebrow: "Why CoCalc",
    title: "Work you can open, check and keep building on.",
    cards: [
      {
        title: "Ask for useful work",
        description:
          "Ask an agent to help write code, explore data or build an application, with your files close at hand.",
      },
      {
        title: "Review the result",
        description:
          "Open the files and results to understand the work before you use it.",
      },
      {
        title: "Continue together",
        description:
          "Invite collaborators to review, edit and improve the same work with you.",
      },
    ],
    link: { href: "features/compare", label: "Compare ways to work with AI" },
  },
  workflows: {
    eyebrow: "What will you make?",
    title: "Start with the result you need.",
    cards: [
      {
        title: "Understand a dataset",
        description:
          "Explore data in a notebook, make charts and share your findings.",
        link: {
          href: "features/jupyter-notebook",
          label: "Explore data analysis",
        },
      },
      {
        title: "Build a dashboard",
        description:
          "Turn an analysis into an application you and your collaborators can use.",
        link: {
          href: "docs/research/private-dashboard",
          label: "See the dashboard guide",
        },
      },
      {
        title: "Write a report",
        description:
          "Bring your writing, calculations and references together with your coauthors.",
        link: {
          href: "features/latex-editor",
          label: "Explore collaborative writing",
        },
      },
    ],
    link: { href: "features", label: "Explore all features" },
    fallbackLink: { href: "features/linux", label: "Explore applications" },
  },
  hosting: {
    eyebrow: "Make room for what comes next",
    title: "Start online. Grow when you need to.",
    description:
      "Use CoCalc.ai without installing CoCalc. Compare capacity and hosting options when your needs change.",
    cards: [
      {
        title: "Choose a plan for your work",
        description:
          "Review hosted memberships and available computing resources before choosing what you need.",
        links: [
          { href: "pricing", label: "Compare plans" },
          {
            href: "docs/hosts/choose-compute",
            label: "Choose computing resources",
          },
        ],
      },
      {
        title: "Run CoCalc on your infrastructure",
        description:
          "Explore local and shared deployments, including what your team needs to operate and maintain.",
        links: [{ href: "products", label: "Compare hosting options" }],
      },
    ],
  },
  closing: {
    eyebrow: "Your next step",
    title: "Bring an idea. Start working on it.",
    description:
      "Create an account to get started, or talk with us about what your organization needs.",
    returningDescription:
      "Open a project to pick up your work, or talk with us about what your organization needs.",
    contact: { href: "support", label: "Talk to CoCalc" },
    trustLabel: "Security and trust information",
  },
} as const;

// Plus has one local project and no accounts or collaborators. Link to its
// existing installation page instead of inventing a local sign-up flow.
const PLUS_HOME_CONTENT = {
  ...PUBLIC_HOME_CONTENT,
  showExample: false,
  showHosting: false,
  hero: {
    ...PUBLIC_HOME_CONTENT.hero,
    eyebrow: "CoCalc on your own machine",
    title: "Your files, tools and results, in one place.",
    description:
      "Use CoCalc Plus for a single local project. Work with code, data and documents, inspect your results and pick up where you left off.",
    startLabel: "Explore CoCalc Plus",
    startHref: "products/cocalc-plus#install-cocalc-plus",
    secondary: { href: "docs", label: "Read the documentation" },
  },
  benefits: {
    ...PUBLIC_HOME_CONTENT.benefits,
    title: "Keep your work close at hand.",
    cards: [
      {
        title: "Use your own machine",
        description:
          "Run one local project with your files and computing resources under your control.",
      },
      {
        title: "Inspect the output",
        description: "Open your files, check calculations and compare results.",
      },
      {
        title: "Continue your work",
        description:
          "Keep source files and saved results together for your next session.",
      },
    ],
    link: { href: "products/cocalc-plus", label: "Understand CoCalc Plus" },
  },
  workflows: {
    ...PUBLIC_HOME_CONTENT.workflows,
    cards: [
      {
        title: "Understand a dataset",
        description:
          "Explore data in a notebook and make charts to inspect your findings.",
        link: { href: "docs/jupyter/use-jupyter", label: "Use a notebook" },
      },
      {
        title: "Run your code",
        description:
          "Use the terminal to run scripts and inspect their output.",
        link: { href: "docs/terminal/use-terminal", label: "Use the terminal" },
      },
      {
        title: "Write a report",
        description: "Keep your writing, calculations and references together.",
        link: { href: "features/latex-editor", label: "Explore writing tools" },
      },
    ],
  },
  closing: {
    ...PUBLIC_HOME_CONTENT.closing,
    title: "Get to know your local workspace.",
    description:
      "Explore the setup instructions and documentation for this single-user edition.",
    contact: { href: "docs", label: "Read the documentation" },
  },
} as const;

export function getPublicHomeContent(product?: string) {
  return product === "plus" ? PLUS_HOME_CONTENT : PUBLIC_HOME_CONTENT;
}

// A tiny contract for the two hosted-only links authored on Home. Do not import
// the full docs registry into the initial public bundle. Tests compare this
// contract to the registry so a future visibility change cannot silently drift.
export function isPublicHomeLinkAvailable(
  href: string,
  product?: string,
): boolean {
  const path = href.split("#")[0];
  return (
    product !== "plus" ||
    (path !== "docs/research/private-dashboard" &&
      path !== "docs/hosts/choose-compute")
  );
}
