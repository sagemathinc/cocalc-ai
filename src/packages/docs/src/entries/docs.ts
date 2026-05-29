/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { DocsEntry } from "../types";
import { docsIcon } from "../helpers";
import {
  BROWSER_AUTOMATION_BODY,
  DOCS_ACTIONS_BODY,
  DOCS_BROWSER_BODY,
} from "../content";

export const DOCUMENTATION_ENTRIES: DocsEntry[] = [
  {
    audiences: ["agents", "instructors", "researchers", "students", "teams"],
    body: DOCS_BROWSER_BODY.trim(),
    category: "Docs",
    id: "docs.browser",
    image: docsIcon(
      "/public/docs/docs-browser-74a65d58.webp",
      "A searchable docs browser beside a project folder",
    ),
    lastReviewed: "2026-05-24",
    slug: "documentation/browser",
    status: "ready",
    summary:
      "Search version-matched CoCalc-ai docs from the public site or inside a project.",
    title: "Use the docs browser",
  },
  {
    audiences: ["agents", "teams"],
    body: DOCS_ACTIONS_BODY.trim(),
    category: "Docs",
    id: "docs.executable-actions",
    image: docsIcon(
      "/public/docs/executable-docs-actions-195b983b.webp",
      "Docs actions launching settings, terminal, and notebook panels",
    ),
    lastReviewed: "2026-05-24",
    slug: "documentation/executable-actions",
    status: "ready",
    summary:
      "Use stable docs action ids to open the right UI from docs or Codex.",
    title: "Use executable docs actions",
  },
  {
    audiences: ["agents", "teams"],
    body: BROWSER_AUTOMATION_BODY.trim(),
    category: "Docs",
    id: "docs.browser-automation",
    image: docsIcon(
      "/public/docs/browser-automation-5dc255b9.webp",
      "Browser automation inspecting a project page with a checklist",
    ),
    lastReviewed: "2026-05-24",
    slug: "documentation/browser-automation",
    status: "ready",
    summary:
      "Use scoped browser-session automation to inspect UI and verify docs.",
    title: "Use browser-session automation",
  },
];
