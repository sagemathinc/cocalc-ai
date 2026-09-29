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
  help: "Serialized owner page bytes received, including rejected pages",
});
