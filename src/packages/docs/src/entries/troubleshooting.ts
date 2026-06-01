/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { DocsEntry } from "../types";
import { docsIcon } from "../helpers";
import {
  CONNECTIVITY_TROUBLESHOOTING_BODY,
  JUPYTER_KERNEL_TERMINATED_BODY,
  MEMORY_TROUBLESHOOTING_BODY,
} from "../content";

export const TROUBLESHOOTING_ENTRIES: DocsEntry[] = [
  {
    audiences: ["agents", "instructors", "researchers", "students", "teams"],
    body: JUPYTER_KERNEL_TERMINATED_BODY.trim(),
    category: "Troubleshooting",
    id: "troubleshooting.jupyter-kernel-terminated",
    image: docsIcon(
      "/public/docs/memory-troubleshooting-7f40cd1d.webp",
      "A memory gauge warning about a stressed notebook kernel",
    ),
    lastReviewed: "2026-05-25",
    noActionReason:
      "Troubleshooting page; the correct destination depends on the observed failure mode and current project state.",
    slug: "troubleshooting/jupyter-kernel-terminated",
    status: "ready",
    summary:
      "Recover from Jupyter kernels that crash, restart, or fail to start.",
    title: "Jupyter kernel terminated",
  },
  {
    audiences: ["agents", "instructors", "researchers", "students", "teams"],
    body: MEMORY_TROUBLESHOOTING_BODY.trim(),
    category: "Troubleshooting",
    id: "troubleshooting.memory",
    image: docsIcon(
      "/public/docs/memory-troubleshooting-7f40cd1d.webp",
      "A memory gauge warning about a stressed notebook kernel",
    ),
    lastReviewed: "2026-05-24",
    noActionReason:
      "Troubleshooting page; memory diagnosis may involve notebooks, terminals, logs, project settings, or host configuration.",
    slug: "troubleshooting/memory",
    status: "ready",
    summary:
      "Diagnose low-memory warnings, out-of-memory kills, and notebook kernel restarts.",
    title: "Low memory and out-of-memory crashes",
  },
  {
    audiences: ["agents", "instructors", "researchers", "students", "teams"],
    body: CONNECTIVITY_TROUBLESHOOTING_BODY.trim(),
    category: "Troubleshooting",
    id: "troubleshooting.connectivity",
    image: docsIcon(
      "/public/docs/connectivity-eaca154f.webp",
      "A browser reconnecting to CoCalc services",
    ),
    lastReviewed: "2026-05-25",
    noActionReason:
      "Troubleshooting page; connectivity diagnosis depends on browser, network, auth, and project state.",
    slug: "troubleshooting/connectivity",
    status: "ready",
    summary:
      "Diagnose sign-in, websocket, stale browser state, and network connection problems.",
    title: "Connectivity and browser troubleshooting",
  },
];
