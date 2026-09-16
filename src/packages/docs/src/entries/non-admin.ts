/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { DocsEntry } from "../types";
import { ACCOUNT_ENTRIES } from "./account";
import { AI_ENTRIES } from "./ai";
import { AUTOMATION_ENTRIES } from "./automation";
import { COLLABORATION_ENTRIES } from "./collaboration";
import { DOCUMENTATION_ENTRIES } from "./docs";
import { FILES_ENTRIES } from "./files";
import { HOSTS_ENTRIES } from "./hosts";
import { JUPYTER_ENTRIES } from "./jupyter";
import { MIGRATION_ENTRIES } from "./migration";
import { PROJECTS_ENTRIES } from "./projects";
import { RESEARCH_ENTRIES } from "./research";
import { SELF_HOSTING_ENTRIES } from "./self-hosting";
import { TEACHING_ENTRIES } from "./teaching";
import { TERMINAL_ENTRIES } from "./terminal";
import { TROUBLESHOOTING_ENTRIES } from "./troubleshooting";

export const NON_ADMIN_ENTRIES: DocsEntry[] = [
  ...ACCOUNT_ENTRIES,
  ...AI_ENTRIES,
  ...AUTOMATION_ENTRIES,
  ...COLLABORATION_ENTRIES,
  ...DOCUMENTATION_ENTRIES,
  ...FILES_ENTRIES,
  ...HOSTS_ENTRIES,
  ...JUPYTER_ENTRIES,
  ...MIGRATION_ENTRIES,
  ...PROJECTS_ENTRIES,
  ...RESEARCH_ENTRIES,
  ...SELF_HOSTING_ENTRIES,
  ...TEACHING_ENTRIES,
  ...TERMINAL_ENTRIES,
  ...TROUBLESHOOTING_ENTRIES,
];
