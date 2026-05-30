/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { DocsEntry } from "../types";
import { docsIcon } from "../helpers";
import { USE_TERMINAL_BODY } from "../content";

export const TERMINAL_ENTRIES: DocsEntry[] = [
  {
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
