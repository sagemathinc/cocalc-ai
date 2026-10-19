/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// App specs (e.g. the shared browser of a .browser file) run the CoCalc CLI
// as `exec: "cocalc"`. Users can put anything on the project's PATH (an old
// standalone CLI in ~/.local/bin, say), so run the CLI that ships with this
// project runtime, with this process's node, instead of looking it up.

import { existsSync } from "node:fs";

export const COCALC_CLI_EXEC = "cocalc";
export const BUNDLED_COCALC_CLI_JS = "/opt/cocalc/bin2/cocalc-cli.js";

export interface AppCommand {
  exec: string;
  args: string[];
}

export function resolveAppCommand(
  command: AppCommand,
  opts: {
    env?: NodeJS.ProcessEnv;
    execPath?: string;
    exists?: (path: string) => boolean;
  } = {},
): AppCommand {
  if (command.exec !== COCALC_CLI_EXEC) return command;
  const env = opts.env ?? process.env;
  const execPath = opts.execPath ?? process.execPath;
  const exists = opts.exists ?? existsSync;
  const candidates = [BUNDLED_COCALC_CLI_JS];
  // CoCalc Lite has no /opt/cocalc/bin2 and sets COCALC_CLI_BIN to its own.
  const configured = `${env.COCALC_CLI_BIN ?? ""}`.trim();
  if (configured) candidates.push(configured);
  for (const path of candidates) {
    if (!exists(path)) continue;
    return path.endsWith(".js")
      ? { exec: execPath, args: [path, ...command.args] }
      : { exec: path, args: command.args };
  }
  return command;
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
