/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { DocsEntry } from "../types";
import { docsIcon } from "../helpers";
import {
  COCALC_STAR_BODY,
  COCALC_STAR_LOCAL_VM_BODY,
  INSTALL_CHROMIUM_BODY,
  REVERSE_SSH_ACCESS_BODY,
} from "../content/self-hosting";

export const SELF_HOSTING_ENTRIES: DocsEntry[] = [
  {
    audiences: ["agents", "instructors", "researchers", "teams"],
    body: COCALC_STAR_BODY.trim(),
    category: "Self Hosting",
    id: "self-hosting.cocalc-star",
    image: docsIcon(
      "/public/docs/project-hosts-684faa4c.webp",
      "A CoCalc Star site running projects in one Docker container",
    ),
    lastReviewed: "2026-09-11",
    searchKeywords:
      "public VM HTTPS cloud sslip.io Let's Encrypt connections data locations retained state maintenance backup configuration rollback",
    slug: "self-hosting/cocalc-star",
    status: "ready",
    summary:
      "Install CoCalc Star with one Docker command on macOS, Windows, or Linux; create the first admin; upgrade, back up, and remove it.",
    title: "Install CoCalc Star",
  },
  {
    audiences: ["agents", "researchers", "teams"],
    body: COCALC_STAR_LOCAL_VM_BODY.trim(),
    category: "Self Hosting",
    id: "self-hosting.cocalc-star-local-vm",
    image: docsIcon(
      "/public/docs/project-hosts-684faa4c.webp",
      "CoCalc Star running on a laptop or workstation with Docker Desktop",
    ),
    lastReviewed: "2026-06-07",
    slug: "self-hosting/cocalc-star-local-vm",
    status: "ready",
    summary:
      "Run CoCalc Star on your own computer with Docker Desktop for private, fast, offline-friendly work.",
    title: "CoCalc Star on your own computer",
  },
  {
    audiences: ["agents", "researchers", "teams"],
    body: INSTALL_CHROMIUM_BODY.trim(),
    category: "Self Hosting",
    id: "self-hosting.install-chromium",
    image: docsIcon(
      "/public/docs/project-hosts-684faa4c.webp",
      "A server terminal installing Chromium for browser automation",
    ),
    lastReviewed: "2026-06-10",
    noActionReason:
      "System install recipe; the useful action is running the shown apt commands on the target Ubuntu host.",
    searchKeywords:
      "how to install Chromium Ubuntu snap chromium-browser xtradeb ppa podman container headless chromedriver",
    slug: "self-hosting/install-chromium",
    status: "ready",
    summary:
      "Install real apt-managed Chromium on Ubuntu from ppa:xtradeb/apps and prevent Ubuntu's snap transition package from returning.",
    title: "How to install Chromium",
  },
  {
    audiences: ["agents", "researchers", "teams"],
    body: REVERSE_SSH_ACCESS_BODY.trim(),
    category: "Self Hosting",
    id: "self-hosting.reverse-ssh-access",
    image: docsIcon(
      "/public/docs/project-hosts-684faa4c.webp",
      "A temporary reverse SSH tunnel from a CoCalc project to a local computer",
    ),
    lastReviewed: "2026-06-07",
    slug: "self-hosting/reverse-ssh-access",
    status: "ready",
    summary:
      "Temporarily let a trusted CoCalc project SSH back to your computer through a reverse SSH tunnel.",
    title: "Temporary SSH access to your computer",
  },
];
