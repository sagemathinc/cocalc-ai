/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  Host,
  HostRuntimeExceptionSummary,
} from "@cocalc/conat/hub/api/hosts";

export function currentHostRuntimeExceptionSummary(
  host: Host,
): HostRuntimeExceptionSummary | undefined {
  const summary = host.runtime_exception_summary;
  if (!summary || summary.host_override_count <= 0) {
    return undefined;
  }
  return summary;
}

export function hostRuntimeExceptionLabel(
  summary: HostRuntimeExceptionSummary,
): string {
  return summary.host_override_count === 1
    ? "host override"
    : `${summary.host_override_count} overrides`;
}

export function hostRuntimeExceptionDescription(
  summary: HostRuntimeExceptionSummary,
): string {
  return `Host-specific runtime overrides: ${summary.host_override_targets.join(", ")}`;
}
