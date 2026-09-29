/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { Counter, Histogram } from "prom-client";

// Fixed labels only: never attach account/project IDs, paths, or error messages.
export const indexingWork = new Counter({
  name: "cocalc_people_indexing_work_total",
  help: "Logical indexing work, not transport RPC or SQL statement counts",
  labelNames: ["kind"] as const,
});
export const indexingPages = new Counter({
  name: "cocalc_people_indexing_pages_total",
  help: "Projection attempts by final outcome",
  labelNames: ["outcome"] as const,
});
export const indexingPageSeconds = new Histogram({
  name: "cocalc_people_indexing_page_seconds",
  help: "Owner fetch and home apply latency including failed attempts",
  buckets: [0.005, 0.025, 0.1, 0.5, 1, 2, 5, 15, 60],
});
export const indexingPageBytes = new Counter({
  name: "cocalc_people_indexing_page_bytes_total",
  help: "Logical serialized per-account projection bytes before apply, including rejected pages",
});

export const indexingOwnerFetches = new Counter({
  name: "cocalc_people_indexing_owner_fetches_total",
  help: "Owner fetch invocations by mode and outcome; excludes internal routing retries",
  labelNames: ["mode", "outcome"] as const,
});
export const indexingOwnerResponseBytes = new Counter({
  name: "cocalc_people_indexing_owner_response_bytes_total",
  help: "Serialized owner response payload bytes once per fetch, excluding transport framing",
  labelNames: ["mode"] as const,
});

/** Instrument the fetch boundary, not the per-recipient reconstructed page. */
export async function measureOwnerProjectionFetch<T>(
  mode: "shared" | "individual",
  fetch: () => Promise<T>,
): Promise<T> {
  indexingOwnerFetches.inc({ mode, outcome: "attempted" });
  let result: T;
  try {
    result = await fetch();
  } catch (err) {
    indexingOwnerFetches.inc({ mode, outcome: "failed" });
    throw err;
  }
  indexingOwnerResponseBytes.inc(
    { mode },
    Buffer.byteLength(JSON.stringify(result)),
  );
  indexingOwnerFetches.inc({ mode, outcome: "received" });
  return result;
}
