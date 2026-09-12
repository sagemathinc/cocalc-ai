/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { DocsEntry } from "../types";
import { ACCOUNT_ENTRIES } from "./account";
import { ADMIN_ENTRIES } from "./admin";
import { AI_ENTRIES } from "./ai";
import { AUTOMATION_ENTRIES } from "./automation";
import { COLLABORATION_ENTRIES } from "./collaboration";
import { DOCUMENTATION_ENTRIES } from "./docs";
import { FILES_ENTRIES } from "./files";
import { HOSTS_ENTRIES } from "./hosts";
import { JUPYTER_ENTRIES } from "./jupyter";
import { MIGRATION_ENTRIES } from "./migration";
import { PROJECTS_ENTRIES } from "./projects";
import { SELF_HOSTING_ENTRIES } from "./self-hosting";
import { TEACHING_ENTRIES } from "./teaching";
import { TERMINAL_ENTRIES } from "./terminal";
import { TROUBLESHOOTING_ENTRIES } from "./troubleshooting";

const ENTRY_GROUPS: DocsEntry[] = [
  ...ACCOUNT_ENTRIES,
  ...ADMIN_ENTRIES,
  ...AI_ENTRIES,
  ...AUTOMATION_ENTRIES,
  ...COLLABORATION_ENTRIES,
  ...DOCUMENTATION_ENTRIES,
  ...FILES_ENTRIES,
  ...HOSTS_ENTRIES,
  ...JUPYTER_ENTRIES,
  ...MIGRATION_ENTRIES,
  ...PROJECTS_ENTRIES,
  ...SELF_HOSTING_ENTRIES,
  ...TEACHING_ENTRIES,
  ...TERMINAL_ENTRIES,
  ...TROUBLESHOOTING_ENTRIES,
];

const ENTRY_BY_ID = new Map(ENTRY_GROUPS.map((entry) => [entry.id, entry]));

const DOCS_ENTRY_IDS = [
  "account.settings",
  "account.two-factor-authentication",
  "billing.settings",
  "account.migrating-from-cocalc-com",
  "admin.overview",
  "admin.news",
  "admin.site-settings",
  "admin.users",
  "admin.cocalc-cli",
  "admin.accounts-receivable",
  "admin.crm-ui",
  "admin.crm",
  "admin.crm-outreach",
  "admin.crm-outreach-ui",
  "admin.cocalc-software",
  "admin.bay-ops",
  "admin.rootfs",
  "admin.project-backup-shards",
  "admin.registration-tokens",
  "admin.signup-emergency-controls",
  "admin.membership-licenses",
  "admin.managed-egress",
  "admin.sso",
  "projects.create-project",
  "projects.research-handoff",
  "projects.project-secrets",
  "ai.connect-credentials",
  "cli.use-cocalc-cli",
  "cli.getting-started",
  "cli.authentication-and-targets",
  "cli.command-reference",
  "cli.scripting-and-results",
  "cli.collaborative-text",
  "cli.notebook-workflows",
  "cli.browser-workflows",
  "cli.scheduled-agents",
  "cli.workspaces-and-notices",
  "cli.builds-and-versions",
  "api.http-api",
  "projects.open-terminal",
  "terminal.use-terminal",
  "terminal.graphical-applications",
  "terminal.ssh-access",
  "files.project-files",
  "files.explorer",
  "files.markdown",
  "files.slides",
  "files.whiteboard",
  "projects.project-list",
  "projects.virtual-machines",
  "projects.publish-files",
  "projects.tasks",
  "jupyter.create-notebook",
  "jupyter.use-jupyter",
  "jupyter.studio-view",
  "jupyter.remote-kernels",
  "troubleshooting.jupyter-kernel-terminated",
  "jupyter.custom-kernels",
  "jupyter.octave-kernel",
  "python.use-python",
  "latex.build-papers",
  "editors.r-markdown",
  "projects.runtime-image",
  "projects.rstudio-project",
  "projects.publish-rootfs",
  "self-hosting.cocalc-star",
  "self-hosting.cocalc-star-local-vm",
  "self-hosting.install-chromium",
  "self-hosting.reverse-ssh-access",
  "troubleshooting.project-start",
  "troubleshooting.memory",
  "troubleshooting.connectivity",
  "hosts.choose-compute",
  "hosts.project-hosts",
  "hosts.access-and-ram",
  "hosts.move-projects",
  "hosts.lifecycle",
  "hosts.spot-recovery",
  "hosts.change-rules",
  "hosts.reliability",
  "hosts.software-lifecycle",
  "hosts.storage",
  "hosts.shared-scratch",
  "hosts.logs",
  "hosts.exam-scratchpads",
  "projects.collaborators",
  "collaboration.chat",
  "collaboration.mentions",
  "files.timetravel",
  "files.git",
  "teaching.course-workflow",
  "teaching.student-pay",
  "teaching.restrict-student-projects",
  "teaching.shared-project",
  "teaching.student-project-rootfs",
  "teaching.create-assignment",
  "teaching.nbgrader",
  "ai.codex-chat",
  "ai.codex-settings",
  "ai.codex-conversations",
  "ai.codex-goals",
  "ai.codex-automation",
  "ai.codex-notifications",
  "ai.editor-agent",
  "docs.browser",
  "docs.executable-actions",
  "docs.browser-automation",
] as const;

// CoCalc Plus runs exactly one local project, directly on the user's machine,
// without accounts, admins, collaborators, project hosts, or sandbox images.
// Keep its in-project docs flyout focused on workflows that make sense there.
const DOCS_PLUS_ENTRY_IDS = new Set<string>([
  "projects.open-terminal",
  "terminal.use-terminal",
  "terminal.graphical-applications",
  "files.project-files",
  "files.explorer",
  "files.markdown",
  "files.slides",
  "files.whiteboard",
  "projects.tasks",
  "jupyter.create-notebook",
  "jupyter.use-jupyter",
  "jupyter.studio-view",
  "troubleshooting.jupyter-kernel-terminated",
  "jupyter.custom-kernels",
  "python.use-python",
  "latex.build-papers",
  "editors.r-markdown",
  "troubleshooting.memory",
  "files.timetravel",
  "files.git",
]);

function orderedEntry(id: string): DocsEntry {
  const entry = ENTRY_BY_ID.get(id);
  if (entry == null) {
    throw Error(`Unknown docs entry id: ${id}`);
  }
  return entry;
}

export function isPlusDocsEntryId(id: string): boolean {
  return DOCS_PLUS_ENTRY_IDS.has(id);
}

export const DOCS_ENTRIES: DocsEntry[] = DOCS_ENTRY_IDS.map(orderedEntry);
