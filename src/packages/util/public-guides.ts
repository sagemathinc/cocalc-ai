/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { FIELD_GUIDES_URL } from "./theme";

const GUIDE_BASE = FIELD_GUIDES_URL.replace(/\/$/, "");

function fieldGuidePath(slug: string): string {
  return `${GUIDE_BASE}/${slug}/`;
}

export const PUBLIC_FEATURED_GUIDES = [
  {
    body: "Use Codex agent chat beside project files, notebooks, terminals, screenshots, patches, and review notes.",
    href: "/docs/ai/codex-chat",
    icon: "robot",
    title: "Codex agent chat",
  },
  {
    body: "Keep durable execution, output, collaboration, TimeTravel, and review close to the notebook.",
    href: fieldGuidePath("jupyter-notebooks"),
    icon: "jupyter",
    title: "Jupyter notebooks",
  },
  {
    body: "Use .term files, shared terminal streams, side chat, Linux tools, and agent-aware command-line work.",
    href: fieldGuidePath("terminal"),
    icon: "terminal",
    title: "Terminal workflows",
  },
] as const;

export const PUBLIC_GUIDE_GROUPS = [
  {
    guides: [
      {
        body: "Polish a paper with LaTeX, notebooks, figures, collaborators, Codex, and project history.",
        href: fieldGuidePath("paper-polishing"),
        icon: "file-pdf",
        title: "From notebook to paper",
      },
      {
        body: "Choose and use CoCalc for LaTeX projects that depend on figures, code, review, and collaborators.",
        href: fieldGuidePath("cocalc-for-latex"),
        icon: "tex",
        title: "LaTeX projects",
      },
      {
        body: "Move from notebook exploration to scripts, packages, debugging, and figures in papers.",
        href: fieldGuidePath("python-workflow"),
        icon: "python",
        title: "Python in CoCalc",
      },
      {
        body: "Manage messy computation with logs, retries, partial outputs, summaries, and recovery.",
        href: fieldGuidePath("research-computation"),
        icon: "line-chart",
        title: "Research runs",
      },
    ],
    intro:
      "Papers, notebooks, code-backed figures, and long-running research work.",
    title: "Research and writing",
  },
  {
    guides: [
      {
        body: "Install packages and make a project environment work from the terminal.",
        href: fieldGuidePath("software-install"),
        icon: "download",
        title: "Installing software",
      },
      {
        body: "Use GitHub issues, pull requests, releases, and reviews from a CoCalc project.",
        href: fieldGuidePath("github-workflow"),
        icon: "github",
        title: "GitHub workflow",
      },
      {
        body: "Inspect agent commits, ask line-level questions, and keep code review accountable.",
        href: fieldGuidePath("git-review-workflow"),
        icon: "git",
        title: "Reviewing agent commits",
      },
      {
        body: "Prepare reusable software environments for courses, teams, sites, and demonstrations.",
        href: fieldGuidePath("rootfs-management"),
        icon: "servers",
        title: "Reusable runtime images",
      },
    ],
    intro:
      "Software setup, Git workflows, agent review, and repeatable project environments.",
    title: "Runtime and code",
  },
  {
    guides: [
      {
        body: "Install a self-contained one-user CoCalc for a laptop, workstation, or SSH machine.",
        href: fieldGuidePath("cocalc-plus"),
        icon: "laptop",
        title: "CoCalc Plus",
      },
      {
        body: "Understand the small-team self-hosting path and when a larger private deployment is a better fit.",
        href: fieldGuidePath("self-hosting"),
        icon: "server",
        title: "Self-hosting CoCalc",
      },
      {
        body: "Use a durable CoCalc project where people and agents work together over time.",
        href: fieldGuidePath("agent-sandbox-cloud"),
        icon: "robot",
        title: "Durable collaborative projects",
      },
      {
        body: "Learn how project workspaces, compute hosts, and storage fit together.",
        href: fieldGuidePath("how-cocalc-works"),
        icon: "sitemap",
        title: "How CoCalc works",
      },
      {
        body: "Use live student projects, assignments, grading workflows, TimeTravel, and shared environments.",
        href: fieldGuidePath("teaching"),
        icon: "graduation-cap",
        title: "Teaching with CoCalc",
      },
    ],
    intro:
      "Self-hosting, local evaluation, durable collaborative projects, and architecture.",
    title: "Operating paths",
  },
] as const;
