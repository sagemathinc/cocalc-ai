/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { DocsEntry } from "../types";
import { ADMIN_ENTRIES } from "./admin";
import { AI_ENTRIES } from "./ai";
import { AUTOMATION_ENTRIES } from "./automation";
import { COLLABORATION_ENTRIES } from "./collaboration";
import { DOCUMENTATION_ENTRIES } from "./docs";
import { FILES_ENTRIES } from "./files";
import { HOSTS_ENTRIES } from "./hosts";
import { JUPYTER_ENTRIES } from "./jupyter";
import { PROJECTS_ENTRIES } from "./projects";
import { TEACHING_ENTRIES } from "./teaching";
import { TERMINAL_ENTRIES } from "./terminal";
import { TROUBLESHOOTING_ENTRIES } from "./troubleshooting";

const ENTRY_GROUPS: DocsEntry[] = [
  ...ADMIN_ENTRIES,
  ...AI_ENTRIES,
  ...AUTOMATION_ENTRIES,
  ...COLLABORATION_ENTRIES,
  ...DOCUMENTATION_ENTRIES,
  ...FILES_ENTRIES,
  ...HOSTS_ENTRIES,
  ...JUPYTER_ENTRIES,
  ...PROJECTS_ENTRIES,
  ...TEACHING_ENTRIES,
  ...TERMINAL_ENTRIES,
  ...TROUBLESHOOTING_ENTRIES,
];

const ENTRY_BY_ID = new Map(ENTRY_GROUPS.map((entry) => [entry.id, entry]));

const DOCS_ENTRY_IDS = [
  "admin.overview",
  "admin.news.open",
  "admin.site-settings.open",
  "admin.users.open",
  "admin.cocalc-cli",
  "admin.bay-ops.open",
  "admin.rootfs.open",
  "admin.project-backup-shards.open",
  "admin.registration-tokens.open",
  "admin.membership-tiers.open",
  "admin.managed-egress.open",
  "admin.sso.open",
  "projects.create-project",
  "settings.environment.secrets",
  "ai.connect-credentials",
  "cli.use-cocalc-cli",
  "api.http-api",
  "project.terminal.open",
  "terminal.use-terminal",
  "files.project-files",
  "files.explorer",
  "files.markdown",
  "files.slides",
  "files.whiteboard",
  "projects.project-list",
  "projects.tasks",
  "project.jupyter.create",
  "jupyter.use-jupyter",
  "troubleshooting.jupyter-kernel-terminated",
  "jupyter.custom-kernels",
  "python.use-python",
  "latex.build-papers",
  "editors.r-markdown",
  "settings.runtime.rootfs",
  "troubleshooting.memory",
  "troubleshooting.connectivity",
  "hosts.open",
  "hosts.access.open",
  "hosts.move.open",
  "hosts.lifecycle.open",
  "hosts.spot-recovery.open",
  "hosts.change-rules.open",
  "hosts.reliability.open",
  "hosts.runtime.open",
  "hosts.storage.open",
  "hosts.scratch.open",
  "hosts.logs.open",
  "settings.people.collaborators",
  "collaboration.chat",
  "collaboration.mentions",
  "file.timetravel.open",
  "files.git",
  "teaching.course-workflow",
  "course.assignment.create",
  "teaching.nbgrader",
  "project.codex.open",
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
