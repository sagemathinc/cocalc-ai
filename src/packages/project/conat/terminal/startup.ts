/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const HARD_RESET = "reset";

const PROJECT_HISTORY_CLEANUP = "history -d $(history 1);\n";

const PROJECT_INIT_WITH_RESET = `${HARD_RESET}; ${PROJECT_HISTORY_CLEANUP}`;

export function getProjectInitCommand(opts: {
  hasTerminalInitFile: boolean;
}): string {
  if (opts.hasTerminalInitFile) {
    // Preserve visible output from the terminal-specific init file.
    return PROJECT_HISTORY_CLEANUP;
  }
  return PROJECT_INIT_WITH_RESET;
}
