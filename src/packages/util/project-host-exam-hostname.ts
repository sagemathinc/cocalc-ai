/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The exam hostname of a project host, derived from its public hostname. The
// hub assigns it and the project host recognizes it, so both use this rule:
// a first label "host-<suffix>" becomes "exam-<suffix>", and any other first
// label becomes "exam-<host_id>".
export function examHostnameFromPublicHostname(
  publicHostname: string,
  host_id: string,
): string {
  const labels = publicHostname.split(".");
  const first = labels[0] ?? "";
  labels[0] = first.startsWith("host-")
    ? `exam-${first.slice("host-".length)}`
    : `exam-${host_id}`;
  return labels.join(".");
}
