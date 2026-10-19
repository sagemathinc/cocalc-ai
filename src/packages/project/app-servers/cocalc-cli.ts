/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// App specs (e.g. the shared browser of a .browser file) run the CoCalc CLI
// as `exec: "cocalc"`. Users can put anything on the project's PATH (an old
// standalone CLI in ~/.local/bin, say), so run the CLI this runtime selected
// instead of looking it up.

import { existsSync } from "node:fs";
import { win32 } from "node:path";

export const COCALC_CLI_EXEC = "cocalc";
export const BUNDLED_NODE = "/opt/cocalc/bin/node";
export const BUNDLED_COCALC_CLI_JS = "/opt/cocalc/bin2/cocalc-cli.js";
// Wrappers around BUNDLED_COCALC_CLI_JS that run `node` from the PATH.
const BUNDLED_COCALC_CLI_WRAPPERS = new Set([
  "/opt/cocalc/bin2/cocalc",
  "/opt/cocalc/bin2/cocalc-cli",
]);

export interface AppCommand {
  exec: string;
  args: string[];
}

export function resolveAppCommand(
  command: AppCommand,
  opts: {
    env?: NodeJS.ProcessEnv;
    exists?: (path: string) => boolean;
    execPath?: string;
  } = {},
): AppCommand {
  if (command.exec !== COCALC_CLI_EXEC) return command;
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  const execPath = opts.execPath ?? process.execPath;
  const bundled =
    exists(BUNDLED_NODE) && exists(BUNDLED_COCALC_CLI_JS)
      ? { exec: BUNDLED_NODE, args: [BUNDLED_COCALC_CLI_JS, ...command.args] }
      : undefined;
  // An explicit selection wins (CoCalc Lite sets its own CLI, also when it
  // runs inside a CoCalc project).
  const configured = `${env.COCALC_CLI_BIN ?? ""}`.trim();
  if (configured && exists(configured)) {
    if (BUNDLED_COCALC_CLI_WRAPPERS.has(configured) && bundled) return bundled;
    // Windows cannot run a shebang script, so run a JavaScript CLI with this
    // node, as Lite's worker launch does. Only if it is node: in a SEA build
    // process.execPath is the SEA binary, which acts as node only when
    // invoked as `node`; there the script runs by its shebang.
    if (/\.[cm]?js$/i.test(configured) && isNodeExecutable(execPath)) {
      return { exec: execPath, args: [configured, ...command.args] };
    }
    return { exec: configured, args: command.args };
  }
  return bundled ?? command;
}

function isNodeExecutable(path: string): boolean {
  // win32.basename splits on both / and \.
  return /^node(\.exe)?$/i.test(win32.basename(path));
}

// Why a service exited before it was ready, in words a user can act on.
export function appStartFailure({
  exec,
  spawnError,
  exit,
}: {
  exec: string;
  spawnError?: unknown;
  exit?: { code: number | null; signal: NodeJS.Signals | null };
}): string | undefined {
  if (spawnError != null) {
    const code = (spawnError as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return exec === COCALC_CLI_EXEC
        ? `the CoCalc CLI was not found (neither ${BUNDLED_COCALC_CLI_JS} nor 'cocalc' on PATH)`
        : `command not found: ${exec}`;
    }
    return `could not start ${exec}: ${(spawnError as Error)?.message ?? spawnError}`;
  }
  if (exit != null) {
    return exit.signal
      ? `${exec} was killed by ${exit.signal}`
      : `${exec} exited with code ${exit.code}`;
  }
}
