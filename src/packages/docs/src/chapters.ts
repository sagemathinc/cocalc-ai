/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { DocsChapter } from "./types";

export const DOCS_CHAPTERS: DocsChapter[] = [
  {
    category: "Account and billing",
    startEntryId: "account.settings",
    summary:
      "Manage account identity, membership, SSH keys, payment methods, and statements from signed-in account settings.",
    workflows: ["Profile", "SSH keys", "Billing"],
  },
  {
    category: "Admin",
    startEntryId: "admin.overview",
    summary:
      "Operate a CoCalc site: user support, site settings, SSO, licenses, announcements, and bay-level administration.",
    workflows: ["Site setup", "User support", "Operations"],
  },
  {
    category: "Projects",
    startEntryId: "projects.create-project",
    summary:
      "Create projects, choose runtime settings, manage secrets, find work, and open project tools.",
    workflows: ["Create projects", "Configure runtime", "Organize work"],
  },
  {
    category: "AI",
    startEntryId: "ai.codex-chat",
    summary:
      "Use project agents, connect credentials, and keep AI workflows grounded in the files and state of a project.",
    workflows: ["Project agents", "Credentials", "Context"],
  },
  {
    category: "CLI",
    startEntryId: "cli.use-cocalc-cli",
    summary:
      "Automate CoCalc from the terminal with cocalc-cli commands for projects, files, and browser actions.",
    workflows: ["Automation", "Project commands", "Browser actions"],
  },
  {
    category: "API",
    startEntryId: "api.http-api",
    summary:
      "Call CoCalc HTTP APIs with scoped credentials and predictable request patterns.",
    workflows: ["HTTP API", "Tokens", "Integration"],
  },
  {
    category: "Terminal",
    startEntryId: "terminal.use-terminal",
    summary:
      "Run shells inside projects, manage processes, and use terminal sessions as part of reproducible work.",
    workflows: ["Shells", "Processes", "Project tools"],
  },
  {
    category: "Files",
    startEntryId: "files.project-files",
    summary:
      "Work with project files, markdown, slides, whiteboards, TimeTravel, and Git.",
    workflows: ["Editing", "History", "Version control"],
  },
  {
    category: "Jupyter",
    startEntryId: "jupyter.use-jupyter",
    summary:
      "Create notebooks, run kernels, debug kernel failures, and configure custom kernels.",
    workflows: ["Notebooks", "Kernels", "Debugging"],
  },
  {
    category: "Python",
    startEntryId: "python.use-python",
    summary:
      "Use Python in CoCalc projects through notebooks, scripts, terminals, and configured environments.",
    workflows: ["Notebooks", "Scripts", "Environments"],
  },
  {
    category: "LaTeX",
    startEntryId: "latex.build-papers",
    summary:
      "Write, build, preview, and collaborate on LaTeX documents in CoCalc.",
    workflows: ["Writing", "Builds", "Collaboration"],
  },
  {
    category: "R",
    startEntryId: "editors.r-markdown",
    summary:
      "Use R and R Markdown for analysis, reports, and reproducible project work.",
    workflows: ["R Markdown", "Analysis", "Reports"],
  },
  {
    category: "Troubleshooting",
    startEntryId: "troubleshooting.connectivity",
    summary:
      "Diagnose common project, connectivity, memory, and notebook kernel problems.",
    workflows: ["Connectivity", "Memory", "Kernels"],
  },
  {
    category: "Project hosts",
    startEntryId: "hosts.project-hosts",
    summary:
      "Understand dedicated hosts, access and RAM policy, lifecycle operations, storage, scratch disks, and reliability.",
    workflows: ["Host setup", "Lifecycle", "Storage"],
  },
  {
    category: "Self Hosting",
    startEntryId: "self-hosting.cocalc-star",
    summary:
      "Run CoCalc Star, install supporting system tools, or use temporary reverse SSH for trusted debugging.",
    workflows: ["CoCalc Star", "Local VM", "Install recipes"],
  },
  {
    category: "Collaboration",
    startEntryId: "collaboration.chat",
    summary:
      "Invite collaborators, communicate in projects, use mentions, and review shared work safely.",
    workflows: ["People", "Chat", "Review"],
  },
  {
    category: "Teaching",
    startEntryId: "teaching.course-workflow",
    summary:
      "Run courses with assignments, student projects, notebooks, and grading workflows.",
    workflows: ["Courses", "Student pay", "Assignments", "Grading"],
  },
  {
    category: "Docs",
    startEntryId: "docs.browser",
    summary:
      "Use the documentation browser, executable actions, browser automation, printing, and learning progress tools.",
    workflows: ["Browse docs", "Actions", "Progress"],
  },
];
