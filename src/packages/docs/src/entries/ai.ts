/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { DocsEntry } from "../types";
import { docsIcon, projectActionParameters } from "../helpers";
import {
  AI_CREDENTIALS_BODY,
  CODEX_CHAT_BODY,
  CODEX_SETTINGS_BODY,
  CODEX_CONVERSATIONS_BODY,
  CODEX_GOALS_BODY,
  CODEX_AUTOMATION_BODY,
  CODEX_NOTIFICATIONS_BODY,
} from "../content";

export const AI_ENTRIES: DocsEntry[] = [
  {
    audiences: ["agents", "researchers", "students", "teams"],
    body: AI_CREDENTIALS_BODY.trim(),
    category: "AI",
    id: "ai.connect-credentials",
    image: docsIcon(
      "/public/docs/connect-ai-access-522e86e1.webp",
      "AI access connected securely to a CoCalc project",
    ),
    lastReviewed: "2026-09-07",
    noActionReason:
      "Credential setup depends on whether the user is configuring ChatGPT, an OpenAI API key, or project code.",
    slug: "ai/connect-credentials",
    status: "ready",
    summary: "Connect ChatGPT or OpenAI API access for Codex and project code.",
    title: "Connect AI access",
  },
  {
    actions: [
      {
        description: "Open Codex chat in the active project.",
        executable: true,
        id: "project.codex.open",
        label: "Open Codex",
        parameters: projectActionParameters(),
      },
    ],
    audiences: ["agents", "researchers", "students", "teams"],
    body: CODEX_CHAT_BODY.trim(),
    category: "AI",
    id: "ai.codex-chat",
    image: docsIcon(
      "/public/docs/codex-chat-3008e11e.webp",
      "Codex chat working with project files, terminals, and notebooks",
    ),
    lastReviewed: "2026-09-07",
    slug: "ai/codex-chat",
    status: "ready",
    summary:
      "Use Codex inside a durable project workspace with files, terminals, and notebooks.",
    title: "Open Codex chat",
  },
  {
    audiences: ["agents", "researchers", "students", "teams"],
    body: CODEX_SETTINGS_BODY.trim(),
    category: "AI",
    id: "ai.codex-settings",
    image: docsIcon(
      "/public/docs/codex-chat-3008e11e.webp",
      "Codex working in a CoCalc project",
    ),
    lastReviewed: "2026-09-07",
    noActionReason:
      "This workflow uses controls in an existing chat or account; start from the linked Open Codex chat guide.",
    slug: "ai/codex-settings",
    status: "ready",
    summary:
      "Choose access, models, reasoning, speed, defaults, and parallel workers.",
    title: "Configure Codex chats",
  },
  {
    audiences: ["agents", "researchers", "students", "teams"],
    body: CODEX_CONVERSATIONS_BODY.trim(),
    category: "AI",
    id: "ai.codex-conversations",
    image: docsIcon(
      "/public/docs/codex-chat-3008e11e.webp",
      "Codex working in a CoCalc project",
    ),
    lastReviewed: "2026-09-07",
    noActionReason:
      "This workflow uses controls in an existing chat or account; start from the linked Open Codex chat guide.",
    slug: "ai/codex-conversations",
    status: "ready",
    summary:
      "Steer running work, manage queued messages, choose a working directory, and fork context.",
    title: "Guide and fork Codex conversations",
  },
  {
    audiences: ["agents", "researchers", "students", "teams"],
    body: CODEX_GOALS_BODY.trim(),
    category: "AI",
    id: "ai.codex-goals",
    image: docsIcon(
      "/public/docs/codex-chat-3008e11e.webp",
      "Codex working in a CoCalc project",
    ),
    lastReviewed: "2026-09-07",
    noActionReason:
      "This workflow uses controls in an existing chat or account; start from the linked Open Codex chat guide.",
    slug: "ai/codex-goals",
    status: "ready",
    summary:
      "Manage continuing objectives and answer blocking or asynchronous questions.",
    title: "Goals and questions",
  },
  {
    audiences: ["agents", "researchers", "students", "teams"],
    body: CODEX_AUTOMATION_BODY.trim(),
    category: "AI",
    id: "ai.codex-automation",
    image: docsIcon(
      "/public/docs/codex-chat-3008e11e.webp",
      "Codex working in a CoCalc project",
    ),
    lastReviewed: "2026-09-07",
    noActionReason:
      "This workflow uses controls in an existing chat or account; start from the linked Open Codex chat guide.",
    slug: "ai/codex-automation",
    status: "ready",
    summary:
      "Schedule Codex prompts or Bash commands, review runs, and pause automation.",
    title: "Schedule agent work",
  },
  {
    audiences: ["agents", "researchers", "students", "teams"],
    body: CODEX_NOTIFICATIONS_BODY.trim(),
    category: "AI",
    id: "ai.codex-notifications",
    searchKeywords:
      "Stop all active or uncertain completion notifications inbox email toast browser activity sessions",
    image: docsIcon(
      "/public/docs/codex-chat-3008e11e.webp",
      "Codex working in a CoCalc project",
    ),
    lastReviewed: "2026-09-07",
    noActionReason:
      "This workflow uses controls in an existing chat or account; start from the linked Open Codex chat guide.",
    slug: "ai/codex-notifications",
    status: "ready",
    summary:
      "Choose completion notifications and inspect or stop ongoing Codex sessions.",
    title: "Notifications and session activity",
  },
];
