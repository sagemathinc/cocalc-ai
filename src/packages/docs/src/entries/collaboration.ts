/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { DocsEntry } from "../types";
import { docsIcon, projectActionParameters } from "../helpers";
import { CHAT_BODY, MENTIONS_BODY } from "../content";

export const COLLABORATION_ENTRIES: DocsEntry[] = [
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
    lastReviewed: "2026-05-25",
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
    slug: "collaboration/mentions",
    status: "ready",
    summary:
      "Notify collaborators with @mentions and return to the relevant project context.",
    title: "Use mentions",
  },
];
