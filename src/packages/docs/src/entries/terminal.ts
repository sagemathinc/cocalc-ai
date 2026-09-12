/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { DocsEntry } from "../types";
import { docsIcon, projectActionParameters } from "../helpers";
import {
  GRAPHICAL_APPLICATIONS_BODY,
  SSH_ACCESS_BODY,
  USE_TERMINAL_BODY,
} from "../content";

export const TERMINAL_ENTRIES: DocsEntry[] = [
  {
    audiences: ["researchers", "students", "teams"],
    body: GRAPHICAL_APPLICATIONS_BODY.trim(),
    category: "Terminal",
    id: "terminal.graphical-applications",
    lastReviewed: "2026-08-24",
    searchKeywords:
      "X11 X Window Wayland Xwayland Blit GUI desktop DISPLAY graphical applications Chromium GIMP Inkscape IDLE audio sound PipeWire pygame modal dialog popup",
    slug: "terminal/graphical-applications",
    status: "ready",
    summary:
      "Launch Wayland and X11 applications, switch their windows, and connect terminals or notebooks to the graphical session.",
    title: "Run graphical Linux applications",
  },
  {
    audiences: ["researchers", "students", "teams"],
    body: SSH_ACCESS_BODY.trim(),
    category: "Terminal",
    id: "terminal.ssh-access",
    image: docsIcon(
      "/public/docs/ssh-access-32a43270.webp",
      "Secure SSH routes from a laptop and course project to CoCalc projects",
    ),
    lastReviewed: "2026-09-11",
    searchKeywords:
      "SSH SFTP SCP rsync OpenSSH Windows PowerShell upload download ProxyCommand",
    slug: "terminal/ssh-access",
    status: "ready",
    summary:
      "Connect to cocalc.ai projects from a computer or another CoCalc project using SSH.",
    title: "SSH access to projects",
  },
  {
    actions: [
      {
        description: "Open a terminal in the active project.",
        executable: true,
        id: "terminal.open",
        label: "Open terminal",
        parameters: projectActionParameters(),
      },
    ],
    audiences: ["agents", "researchers", "students", "teams"],
    body: USE_TERMINAL_BODY.trim(),
    category: "Terminal",
    id: "terminal.use-terminal",
    image: docsIcon(
      "/public/docs/terminal-56905fa2.webp",
      "Hand-drawn terminal opening project files",
    ),
    lastReviewed: "2026-05-25",
    slug: "terminal/use-terminal",
    status: "ready",
    summary:
      "Use persistent collaborative Linux shell sessions inside CoCalc projects.",
    title: "Use terminals",
  },
];
