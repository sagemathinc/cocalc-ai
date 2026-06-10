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
  ...PROJECTS_ENTRIES,
  ...SELF_HOSTING_ENTRIES,
  ...TEACHING_ENTRIES,
  ...TERMINAL_ENTRIES,
  ...TROUBLESHOOTING_ENTRIES,
];

const ENTRY_BY_ID = new Map(ENTRY_GROUPS.map((entry) => [entry.id, entry]));

const DOCS_ENTRY_IDS = [
  "account.settings",
  "billing.settings",
  "admin.overview",
  "admin.news",
  "admin.site-settings",
  "admin.users",
  "admin.cocalc-cli",
  "admin.bay-ops",
  "admin.rootfs",
  "admin.project-backup-shards",
  "admin.registration-tokens",
  "admin.signup-emergency-controls",
  "admin.membership-licenses",
  "admin.managed-egress",
  "admin.sso",
  "projects.create-project",
  "projects.project-secrets",
  "ai.connect-credentials",
  "cli.use-cocalc-cli",
  "api.http-api",
  "projects.open-terminal",
  "terminal.use-terminal",
  "files.project-files",
  "files.explorer",
  "files.markdown",
  "files.slides",
  "files.whiteboard",
  "projects.project-list",
  "projects.tasks",
  "jupyter.create-notebook",
  "jupyter.use-jupyter",
  "troubleshooting.jupyter-kernel-terminated",
  "jupyter.custom-kernels",
  "python.use-python",
  "latex.build-papers",
  "editors.r-markdown",
  "projects.runtime-image",
  "self-hosting.cocalc-star",
  "self-hosting.cocalc-star-local-vm",
  "self-hosting.install-chromium",
  "self-hosting.reverse-ssh-access",
  "troubleshooting.memory",
  "troubleshooting.connectivity",
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
  "projects.collaborators",
  "collaboration.chat",
  "collaboration.mentions",
  "files.timetravel",
  "files.git",
  "teaching.course-workflow",
  "teaching.create-assignment",
  "teaching.nbgrader",
  "ai.codex-chat",
  "docs.browser",
  "docs.executable-actions",
  "docs.browser-automation",
] as const;

function orderedEntry(id: string): DocsEntry {
  const entry = ENTRY_BY_ID.get(id);
  if (entry == null) {
    throw Error(`Unknown docs entry id: ${id}`);
  }
  return entry;
}

export const DOCS_ENTRIES: DocsEntry[] = DOCS_ENTRY_IDS.map(orderedEntry);
