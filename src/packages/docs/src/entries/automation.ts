/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { DocsEntry } from "../types";
import { docsIcon } from "../helpers";
import { COCALC_CLI_BODY, HTTP_API_BODY } from "../content";

import {
  CLI_GETTING_STARTED_BODY,
  CLI_AUTHENTICATION_BODY,
  CLI_COMMAND_REFERENCE_BODY,
  CLI_SCRIPTING_BODY,
} from "../content/cli";

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
    lastReviewed: "2026-09-08",
    noActionReason:
      "CLI reference page; the useful action is the command text itself, not opening a browser UI.",
    slug: "cli/use-cocalc-cli",
    status: "ready",
    summary:
      "Use the CoCalc CLI for authenticated docs, browser, notebook, and project automation.",
    title: "Use the CoCalc CLI for automation",
  },
  {
    audiences: ["agents", "researchers", "teams"],
    body: CLI_GETTING_STARTED_BODY.trim(),
    category: "CLI",
    id: "cli.getting-started",
    lastReviewed: "2026-09-08",
    noActionReason:
      "Terminal guide; command examples do not require a browser UI action.",
    searchKeywords:
      "CLI install installation Windows PowerShell Linux macOS login quickstart first command",
    slug: "cli/getting-started",
    status: "ready",
    summary:
      "Install the CLI, sign in on your own computer, and inspect a project step by step.",
    title: "Get started with the CoCalc CLI",
  },
  {
    audiences: ["agents", "researchers", "teams"],
    body: CLI_AUTHENTICATION_BODY.trim(),
    category: "CLI",
    id: "cli.authentication-and-targets",
    lastReviewed: "2026-09-08",
    noActionReason:
      "Terminal guide; command examples do not require a browser UI action.",
    searchKeywords:
      "CLI auth login bootstrap elevate status check profile env COCALC_PROFILE project use unuse .cocalc-project browser target-resolve",
    slug: "cli/authentication-and-targets",
    status: "ready",
    summary:
      "Choose profiles, environment credentials, project context, browser targets, and fresh authentication.",
    title: "CLI authentication and targets",
  },
  {
    audiences: ["agents", "researchers", "teams"],
    body: CLI_COMMAND_REFERENCE_BODY.trim(),
    category: "CLI",
    id: "cli.command-reference",
    lastReviewed: "2026-09-08",
    noActionReason:
      "Terminal guide; command examples do not require a browser UI action.",
    searchKeywords:
      "CLI command reference help project file exec terminal jupyter build chat codex automation tasks api.text exec-api workspaces browser",
    slug: "cli/command-reference",
    status: "ready",
    summary:
      "Navigate command families for files, notebooks, collaborative documents, agents, browsers, and operations.",
    title: "Find the right CLI command",
  },
  {
    audiences: ["agents", "researchers", "teams"],
    body: CLI_SCRIPTING_BODY.trim(),
    category: "CLI",
    id: "cli.scripting-and-results",
    lastReviewed: "2026-09-08",
    noActionReason:
      "Terminal guide; command examples do not require a browser UI action.",
    searchKeywords:
      "CLI JSON output stderr stdout exit_code jq scripting script project exec async job_id op_id op wait timeout cancel",
    slug: "cli/scripting-and-results",
    status: "ready",
    summary:
      "Parse JSON, check remote exit codes, and recover operations and asynchronous execution jobs.",
    title: "Use the CLI in scripts",
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
    noActionReason:
      "API reference page; browser navigation would not verify an API credential or request.",
    slug: "api/http-api",
    status: "ready",
    summary:
      "Use the limited CoCalc HTTP API carefully, and prefer cocalc-cli for most automation.",
    title: "CoCalc HTTP API and API keys",
  },
];
