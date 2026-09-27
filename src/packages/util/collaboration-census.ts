/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
export interface CollaborationDiscoveryReport {
  run_id: string;
  sequence: number;
  coverage: "indexing" | "partial" | "complete";
  traversal_complete: boolean;
  directories: number;
  completed_directories: number;
  entries: number;
  candidates: number;
  pending_candidates: number;
  excluded_entries: number;
  skipped_symlinks: number;
  blocked_directories: number;
  errors: number;
  source_pending: number;
  source_errors: number;
}
export interface CollaborationDiscoveryState {
  status: "pending" | "unavailable" | "indexing" | "partial" | "complete";
  report?: CollaborationDiscoveryReport;
  updated_at?: number;
}
export interface CollaborationDiscoveryWrite {
  project_id: string;
  host_id?: string;
  /** Immutable first-report CAS, reused after a lost acknowledgement. */
  expected_run_id: string | null;
  report: CollaborationDiscoveryReport;
}
export function validateDiscoveryReport(
  input: CollaborationDiscoveryReport,
): CollaborationDiscoveryReport {
  if (
    !input ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.run_id) ||
    !["indexing", "partial", "complete"].includes(input.coverage) ||
    typeof input.traversal_complete !== "boolean"
  )
    throw Error("invalid collaboration discovery report");
  const output = {
    run_id: input.run_id,
    coverage: input.coverage,
    traversal_complete: input.traversal_complete,
  } as CollaborationDiscoveryReport;
  for (const key of [
    "sequence",
    "directories",
    "completed_directories",
    "entries",
    "candidates",
    "pending_candidates",
    "excluded_entries",
    "skipped_symlinks",
    "blocked_directories",
    "errors",
    "source_pending",
    "source_errors",
  ] as const) {
    if (
      !Number.isSafeInteger(input[key]) ||
      input[key] < (key === "sequence" ? 1 : 0) ||
      input[key] > 1_000_000_000
    )
      throw Error("invalid collaboration discovery count");
    output[key] = input[key];
  }
  if (
    output.completed_directories > output.directories ||
    output.pending_candidates > output.candidates ||
    output.blocked_directories > output.directories ||
    (output.traversal_complete &&
      output.completed_directories !== output.directories)
  )
    throw Error("inconsistent collaboration discovery counts");
  if (
    output.coverage === "complete" &&
    (!output.traversal_complete ||
      output.pending_candidates ||
      output.source_pending ||
      output.source_errors ||
      output.errors ||
      output.blocked_directories ||
      output.excluded_entries ||
      output.skipped_symlinks)
  )
    throw Error("incomplete collaboration discovery cannot be marked complete");
  return output;
}

export function discoveryCoverage(state: CollaborationDiscoveryState): {
  coverage: "indexing" | "partial";
  coverage_message: string;
} {
  const report = state.report;
  const progress = report
    ? ` ${report.completed_directories} of ${report.directories} discovered directories visited; ${report.candidates} chat sources found.`
    : "";
  const explanation =
    state.status === "pending"
      ? "Historical chat discovery is pending."
      : state.status === "unavailable"
        ? "Historical chat discovery is unavailable or its worker status is stale. Last indexed work is retained."
        : state.status === "indexing"
          ? "Historical chat discovery or source indexing is in progress."
          : state.status === "complete"
            ? "The latest scoped historical chat census and source handoff finished."
            : "Historical chat coverage is partial: some paths were excluded, inaccessible, over capacity, or still need source reconciliation.";
  return {
    coverage:
      state.status === "pending" || state.status === "indexing"
        ? "indexing"
        : "partial",
    coverage_message: `${explanation}${progress} Archived history and bounded relationship summaries may still be incomplete.`,
  };
}
