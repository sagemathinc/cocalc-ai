/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Claude Code ships in the project tools bundle, like codex: every host has
// it after its tools are installed, and every project sees it read-only under
// /opt/cocalc/bin2 (so `claude` is also on users' PATH).

import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { join } from "node:path";
import { CLAUDE_CODE_TOOLS_DIR } from "@cocalc/util/ai/qualified-harnesses";

const DEFAULT_TOOLS_CURRENT = "/opt/cocalc/tools/current";

export const CLAUDE_CODE_MISSING =
  "Claude Code is not installed on this project host yet. It is part of the host's tools; upgrade the host software and try again.";

/**
 * Host path of the installed Claude Code tree, resolved to a concrete tools
 * version so a container started now keeps using it (and tools retention can
 * see it) even if the tools are upgraded later.
 */
export async function claudeCodeToolsDir(): Promise<string> {
  const tools = process.env.COCALC_PROJECT_TOOLS ?? DEFAULT_TOOLS_CURRENT;
  try {
    const dir = await realpath(join(tools, CLAUDE_CODE_TOOLS_DIR));
    await access(join(dir, "bin", "claude-agent-acp"), constants.X_OK);
    await access(join(dir, "bin", "claude"), constants.X_OK);
    return dir;
  } catch {
    throw Error(CLAUDE_CODE_MISSING);
  }
}

/** The native `claude` CLI on the host, e.g. for subscription sign-in. */
export async function claudeCodeCliPath(): Promise<string> {
  return join(await claudeCodeToolsDir(), "bin", "claude");
}
