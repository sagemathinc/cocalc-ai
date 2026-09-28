/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import fs = require("fs");
import { createHash } from "node:crypto";

// Keep the direct fs call and literal path: ncc does not trace TypeScript's
// transpiled named imports here. TypeScript's allowJs also copies the helper.
export const CLAUDE_PROJECT_MCP_SOURCE = fs.readFileSync(
  __dirname + "/claude-project-mcp.cjs",
  "utf8",
);
// A schema change gets a new MCP namespace, including in resumed transcripts
// whose deferred-tool cache may still contain the old project_exec definition.
export const CLAUDE_PROJECT_MCP_NAME = `cocalc_project_${createHash("sha256").update(CLAUDE_PROJECT_MCP_SOURCE).digest("hex").slice(0, 12)}`;
