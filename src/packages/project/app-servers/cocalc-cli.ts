/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// App specs (e.g. the shared browser of a .browser file) run the CoCalc CLI
// as `exec: "cocalc"`. Users can put anything on the project's PATH (an old
// standalone CLI in ~/.local/bin, say), so run the CLI this runtime selected
// instead of looking it up.

import { existsSync } from "node:fs";

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
  } = {},
): AppCommand {
  if (command.exec !== COCALC_CLI_EXEC) return command;
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  const bundled =
    exists(BUNDLED_NODE) && exists(BUNDLED_COCALC_CLI_JS)
      ? { exec: BUNDLED_NODE, args: [BUNDLED_COCALC_CLI_JS, ...command.args] }
      : undefined;
  // An explicit selection wins (CoCalc Lite sets its own CLI, also when it
  // runs inside a CoCalc project). It is run the way Lite runs it,
  // COCALC_CLI_CMD="<bin>". Not with process.execPath: in a SEA build that
  // is the SEA binary, which only acts as node when invoked as `node`.
  const configured = `${env.COCALC_CLI_BIN ?? ""}`.trim();
  if (configured && exists(configured)) {
    if (BUNDLED_COCALC_CLI_WRAPPERS.has(configured) && bundled) return bundled;
    return { exec: configured, args: command.args };
  }
  return bundled ?? command;
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
