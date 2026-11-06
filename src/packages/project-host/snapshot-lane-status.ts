/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The scheduled-snapshot lane's status for host metrics. The maintenance
// module registers how to read it, so host metrics doesn't import that module.

import type { HostSnapshotLaneMetrics } from "@cocalc/conat/hub/api/hosts";

let provider: (() => HostSnapshotLaneMetrics | undefined) | undefined;

export function setSnapshotLaneStatusProvider(
  next: (() => HostSnapshotLaneMetrics | undefined) | undefined,
): void {
  provider = next;
}

export function getSnapshotLaneMetrics(): HostSnapshotLaneMetrics | undefined {
  try {
    return provider?.();
  } catch {
    // Metrics must never break the collector.
    return undefined;
  }
}
