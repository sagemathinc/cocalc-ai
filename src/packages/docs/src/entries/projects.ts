/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { DocsEntry } from "../types";
import { docsIcon, projectActionParameters } from "../helpers";
import {
  COLLABORATORS_BODY,
  CREATE_PROJECT_BODY,
  OPEN_TERMINAL_BODY,
  PROJECT_LIST_BODY,
  PROJECT_SECRETS_BODY,
  ROOTFS_BODY,
  TASKS_BODY,
} from "../content";

export const PROJECTS_ENTRIES: DocsEntry[] = [
  {
    audiences: ["agents", "instructors", "researchers", "students", "teams"],
    body: CREATE_PROJECT_BODY.trim(),
    category: "Projects",
    id: "projects.create-project",
    image: docsIcon(
      "/public/docs/create-project-5b221552.webp",
      "A new CoCalc project folder with notebook, terminal, and chat tools",
    ),
    lastReviewed: "2026-05-24",
    slug: "projects/create-project",
    status: "ready",
    summary:
      "Create a durable Linux workspace for files, notebooks, terminals, chat, and agents.",
    title: "Create a project",
  },
  {
    actions: [
      {
        description:
          "Open the project Settings -> Environment -> Secrets panel.",
        executable: true,
        id: "settings.environment.secrets",
        label: "Open project secrets",
        parameters: projectActionParameters(),
      },
    ],
    audiences: ["agents", "researchers", "students", "teams"],
    body: PROJECT_SECRETS_BODY.trim(),
    category: "Projects",
    id: "projects.project-secrets",
    image: docsIcon(
      "/public/docs/project-secrets-ea9872ae.webp",
      "Project secrets mounted as protected read-only files",
    ),
    lastReviewed: "2026-05-24",
    slug: "projects/project-secrets",
    status: "ready",
    summary:
      "Store API keys and credentials as encrypted, read-only files mounted into the running project.",
    title: "Project secrets",
  },
  {
    actions: [
      {
        description: "Open a terminal in the active project.",
        executable: true,
        id: "project.terminal.open",
        label: "Open terminal",
        parameters: projectActionParameters(),
      },
    ],
    audiences: ["agents", "researchers", "students", "teams"],
    body: OPEN_TERMINAL_BODY.trim(),
    category: "Projects",
    id: "projects.open-terminal",
    image: docsIcon(
      "/public/docs/open-terminal-5c56d2b5.webp",
      "A project folder opening a durable terminal session",
    ),
    lastReviewed: "2026-05-24",
    slug: "projects/open-terminal",
    status: "ready",
    summary:
      "Use durable collaborative terminals backed by real project Linux processes.",
    title: "Open a terminal",
  },
  {
    audiences: ["agents", "instructors", "researchers", "students", "teams"],
    body: PROJECT_LIST_BODY.trim(),
    category: "Projects",
    id: "projects.project-list",
    image: docsIcon(
      "/public/docs/create-project-5b221552.webp",
      "A projects page with recent work and a create-project control",
    ),
    lastReviewed: "2026-05-25",
    slug: "projects/project-list",
    status: "ready",
    summary:
      "Find, open, create, and organize the CoCalc projects you can access.",
    title: "Use the projects page",
  },
  {
    audiences: ["agents", "instructors", "researchers", "students", "teams"],
    body: TASKS_BODY.trim(),
    category: "Projects",
    id: "projects.tasks",
    image: docsIcon(
      "/public/docs/tasks-07a6952f.webp",
      "A project task list with checked items, tags, and progress",
    ),
    lastReviewed: "2026-05-25",
    slug: "projects/tasks",
    status: "ready",
    summary:
      "Use task files for shared checklists, project plans, and durable TODO lists.",
    title: "Use task files",
  },
  {
    actions: [
      {
        description: "Open project Settings -> Environment -> Runtime Image.",
        executable: true,
        id: "settings.runtime.rootfs",
        label: "Open runtime image",
        parameters: projectActionParameters(),
      },
    ],
    audiences: ["agents", "instructors", "researchers", "teams"],
    body: ROOTFS_BODY.trim(),
    category: "Projects",
    id: "projects.runtime-image",
    image: docsIcon(
      "/public/docs/runtime-image-09add8c9.webp",
      "A layered runtime image that defines a project's software stack",
    ),
    lastReviewed: "2026-05-24",
    slug: "projects/runtime-image",
    status: "ready",
    summary:
      "Choose, customize, and reuse the Linux software stack for a project.",
    title: "Runtime images and RootFS",
  },
  {
    actions: [
      {
        description: "Open project Settings -> People.",
        executable: true,
        id: "settings.people.collaborators",
        label: "Manage collaborators",
        parameters: projectActionParameters(),
      },
    ],
    audiences: ["instructors", "researchers", "students", "teams"],
    body: COLLABORATORS_BODY.trim(),
    category: "Projects",
    id: "projects.collaborators",
    image: docsIcon(
      "/public/docs/collaborators-8ce1955f.webp",
      "Collaborators sharing a project folder with realtime cursors",
    ),
    lastReviewed: "2026-05-24",
    slug: "projects/collaborators",
    status: "ready",
    summary:
      "Invite people into a shared project with realtime files, notebooks, terminals, and chat.",
    title: "Add project collaborators",
  },
];
