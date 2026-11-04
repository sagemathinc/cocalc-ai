/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// The project's Claude MCP service (see @cocalc/conat/project/claude-mcp):
// MCP servers from Claude Code's config, run as ordinary project processes.

import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import {
  claudeMcpBaseEnv,
  claudeMcpServer,
  type ClaudeMcpRuntime,
} from "@cocalc/conat/project/claude-mcp";
import { getIdentity } from "./connection";
import { getLogger } from "@cocalc/project/logger";

const logger = getLogger("project:conat:claude-mcp");

// Claude Code's own files stay small; a bigger one is not read.
const MAX_CONFIG_BYTES = 1_000_000;

async function readJson(path: string): Promise<unknown> {
  let handle;
  try {
    handle = await open(path, "r");
    const { size } = await handle.stat();
    if (size > MAX_CONFIG_BYTES) return undefined;
    return JSON.parse(await handle.readFile({ encoding: "utf8" }));
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

export const runtime: ClaudeMcpRuntime = {
  home: process.env.HOME || homedir(),
  readJson,
  spawn: ({ command, args, cwd, env }) =>
    spawn(command, args, {
      cwd,
      env,
      // Its own process group, so stopping it stops what it started too.
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    }),
  killGroup: (pid, signal) => process.kill(-pid, signal),
  baseEnv: () => claudeMcpBaseEnv(),
};

export function init(opts) {
  opts = getIdentity(opts);
  logger.debug("init");
  claudeMcpServer({ ...opts, runtime });
}
