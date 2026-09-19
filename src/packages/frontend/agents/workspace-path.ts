/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export function relativeAgentWorkingDirectory(
  workingDirectory: string | undefined,
  projectHome: string,
): string | undefined {
  const directory = workingDirectory?.trim().replace(/\/+$/, "");
  const home = projectHome.trim().replace(/\/+$/, "");
  if (!directory || !home) return undefined;
  if (directory === home) return "~/";
  if (directory.startsWith(`${home}/`)) {
    return `${directory.slice(home.length + 1)}/`;
  }
  return `${directory}/`;
}
