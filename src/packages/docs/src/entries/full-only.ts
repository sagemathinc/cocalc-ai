/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Articles in the full documentation that Essential Docs leaves out. The
// Essential entrypoint never imports this module, so their bodies stay out of
// its bundle and its size budget.
import type { DocsEntry } from "../types";
import { COLLABORATOR_TRUST_BODY } from "../content/collaborator-trust";

export const FULL_ONLY_ENTRIES: DocsEntry[] = [
  {
    audiences: ["agents", "instructors", "researchers", "students", "teams"],
    body: COLLABORATOR_TRUST_BODY.trim(),
    category: "Projects",
    id: "projects.collaborator-trust",
    lastReviewed: "2026-11-17",
    noActionReason:
      "This explains what sharing a project means before you add someone; nothing to start here.",
    searchKeywords:
      "collaborator trust security shared project same user files processes secrets ssh keys agents hooks MCP subscription remove rotate",
    slug: "projects/collaborator-trust",
    status: "ready",
    summary:
      "What a collaborator can see and do in a shared project, what stays out of it, and simple rules for whom to add.",
    title: "Collaborators and what they can do",
  },
];
