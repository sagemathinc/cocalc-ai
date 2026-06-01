/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { DocsEntry } from "../types";
import { docsIcon } from "../helpers";
import { COCALC_CLI_BODY, HTTP_API_BODY } from "../content";

export const AUTOMATION_ENTRIES: DocsEntry[] = [
  {
    audiences: ["agents", "researchers", "teams"],
    body: COCALC_CLI_BODY.trim(),
    category: "CLI",
    id: "cli.use-cocalc-cli",
    image: docsIcon(
      "/public/docs/cocalc-cli-862b8d4e.webp",
      "A terminal automating project docs, notebooks, and browser tasks",
    ),
    lastReviewed: "2026-05-24",
    slug: "cli/use-cocalc-cli",
    status: "ready",
    summary:
      "Use the CoCalc CLI for authenticated docs, browser, notebook, and project automation.",
    title: "Use the CoCalc CLI for automation",
  },
  {
    audiences: ["agents", "researchers", "teams"],
    body: HTTP_API_BODY.trim(),
    category: "API",
    id: "api.http-api",
    image: docsIcon(
      "/public/docs/http-api-5067e8ed.webp",
      "A guarded HTTP API gateway with keys and connected endpoints",
    ),
    lastReviewed: "2026-05-24",
    slug: "api/http-api",
    status: "ready",
    summary:
      "Use the limited CoCalc HTTP API carefully, and prefer cocalc-cli for most automation.",
    title: "CoCalc HTTP API and API keys",
  },
];
