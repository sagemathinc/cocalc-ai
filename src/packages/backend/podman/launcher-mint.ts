/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Making podman launchers. Only project-runner/run/podman.ts may import this;
// a structural test enforces it.

import { __launcherToken, PodmanLauncher } from "./launch-policy";

export function mintPodmanLauncher(
  command: string,
  argsPrefix: readonly string[],
): PodmanLauncher {
  return new PodmanLauncher(__launcherToken, command, argsPrefix);
}
