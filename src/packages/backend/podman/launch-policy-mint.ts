/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Minting launch policies. Only the launch gate
// (project-runner/run/podman-launch.ts) may import this; a structural test
// enforces it.

import {
  __mintToken,
  PodmanLaunchPolicy,
  type PodmanLaunchKind,
  type PodmanLaunchVerb,
} from "./launch-policy";

export function mintPodmanLaunchPolicy(opts: {
  kind: PodmanLaunchKind;
  verb: PodmanLaunchVerb;
  usernsArgs: readonly string[];
  container?: string;
}): PodmanLaunchPolicy {
  return new PodmanLaunchPolicy(__mintToken, opts);
}
