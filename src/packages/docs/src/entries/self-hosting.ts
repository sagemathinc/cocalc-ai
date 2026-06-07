/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { DocsEntry } from "../types";
import { docsIcon } from "../helpers";
import { COCALC_STAR_BODY, COCALC_STAR_LOCAL_VM_BODY } from "../content";

export const SELF_HOSTING_ENTRIES: DocsEntry[] = [
  {
    audiences: ["agents", "instructors", "researchers", "teams"],
    body: COCALC_STAR_BODY.trim(),
    category: "Self Hosting",
    id: "self-hosting.cocalc-star",
    image: docsIcon(
      "/public/docs/project-hosts-684faa4c.webp",
      "A CoCalc Star server running projects on a public VM",
    ),
    lastReviewed: "2026-06-05",
    slug: "self-hosting/cocalc-star",
    status: "ready",
    summary:
      "Install CoCalc Star on a public Ubuntu VM with automatic HTTPS and a guided first-admin setup.",
    title: "Install CoCalc Star",
  },
  {
    audiences: ["agents", "researchers", "teams"],
    body: COCALC_STAR_LOCAL_VM_BODY.trim(),
    category: "Self Hosting",
    id: "self-hosting.cocalc-star-local-vm",
    image: docsIcon(
      "/public/docs/project-hosts-684faa4c.webp",
      "A local laptop VM running CoCalc Star through localhost port forwarding",
    ),
    lastReviewed: "2026-06-07",
    slug: "self-hosting/cocalc-star-local-vm",
    status: "ready",
    summary:
      "Run CoCalc Star on a local laptop VM using localhost port forwarding instead of public DNS.",
    title: "CoCalc Star on a local VM",
  },
];
