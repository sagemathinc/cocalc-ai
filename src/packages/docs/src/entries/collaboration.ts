/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { DocsEntry } from "../types";
import { docsIcon, projectActionParameters } from "../helpers";
import { CHAT_BODY, MENTIONS_BODY } from "../content/collaboration";

import { SCAN_FILES_BODY } from "../content/scan-files";

export const COLLABORATION_ENTRIES: DocsEntry[] = [
  {
    audiences: ["agents", "instructors", "researchers", "students", "teams"],
    body: SCAN_FILES_BODY.trim(),
    category: "Collaboration",
    id: "collaboration.scan-files",
    lastReviewed: "2026-09-30",
    noActionReason:
      "Manual scans require the user's project selection and explicit admission.",
    slug: "collaboration/scan-files",
    status: "ready",
    summary:
      "Understand automatic indexing, choose likely changed projects, and run or cancel a manual recovery scan.",
    title: "Index resources and scan project files",
  },
  {
    actions: [
      {
        description: "Create a chat file in the active project.",
        executable: true,
        id: "collaboration.chat.open",
        label: "Create chat",
        parameters: projectActionParameters(),
      },
    ],
    audiences: ["agents", "instructors", "researchers", "students", "teams"],
    body: CHAT_BODY.trim(),
    category: "Collaboration",
    id: "collaboration.chat",
    image: docsIcon(
      "/public/docs/collaborators-8ce1955f.webp",
      "A project chat conversation beside shared project files",
    ),
    lastReviewed: "2026-09-07",
    slug: "collaboration/chat",
    status: "ready",
    summary:
      "Discuss project work with collaborators and AI assistants in durable chat files.",
    title: "Use chat",
  },
  {
    audiences: ["instructors", "researchers", "students", "teams"],
    body: MENTIONS_BODY.trim(),
    category: "Collaboration",
    id: "collaboration.mentions",
    image: docsIcon(
      "/public/docs/collaborators-8ce1955f.webp",
      "A collaborator mention notification linked to project context",
    ),
    lastReviewed: "2026-05-25",
    noActionReason:
      "Mentions are contextual; opening a useful destination requires a specific existing mention or notification.",
    slug: "collaboration/mentions",
    status: "ready",
    summary:
      "Notify collaborators with @mentions and return to the relevant project context.",
    title: "Use mentions",
  },
];
