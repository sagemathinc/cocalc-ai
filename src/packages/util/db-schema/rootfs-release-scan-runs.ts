/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "rootfs_release_scan_runs",
  rules: {
    primary_key: "scan_run_id",
    pg_indexes: [
      "release_id",
      "requested_by",
      "host_id",
      "tool",
      "status",
      "requested_at",
      "started_at",
      "completed_at",
      "report_retention_until",
    ],
  },
  fields: {
    scan_run_id: {
      type: "uuid",
      desc: "Stable identifier for this RootFS release vulnerability scan run.",
    },
    release_id: {
      type: "string",
      pg_type: "VARCHAR(128)",
      desc: "Immutable RootFS release scanned by this run.",
    },
    content_key: {
      type: "string",
      desc: "Logical content key for the release at scan time.",
    },
    runtime_image: {
      type: "string",
      desc: "Managed runtime image name for the release at scan time.",
    },
    requested_by: {
      type: "uuid",
      desc: "Admin account that requested the scan, if manually triggered.",
      render: { type: "account" },
    },
    requested_at: {
      type: "timestamp",
      desc: "When this scan was requested.",
    },
    started_at: {
      type: "timestamp",
      desc: "When the project host started executing this scan.",
    },
    completed_at: {
      type: "timestamp",
      desc: "When this scan finished or failed.",
    },
    bay_id: {
      type: "string",
      pg_type: "VARCHAR(64)",
      desc: "Authoritative bay that recorded this scan run.",
    },
    host_id: {
      type: "uuid",
      desc: "Project host selected to execute this scan.",
    },
    tool: {
      type: "string",
      pg_type: "VARCHAR(64)",
      desc: "Scanner tool used for this scan, e.g. trivy.",
    },
    tool_version: {
      type: "string",
      desc: "Scanner version reported by the scan worker.",
    },
    db_version: {
      type: "string",
      desc: "Scanner vulnerability database version or digest.",
    },
    db_updated_at: {
      type: "timestamp",
      desc: "Scanner vulnerability database timestamp, if available.",
    },
    status: {
      type: "string",
      pg_type: "VARCHAR(32)",
      desc: "Scan run status (pending, running, clean, findings, error).",
    },
    severity_counts: {
      type: "map",
      desc: "Counts of findings by severity.",
    },
    summary: {
      type: "map",
      desc: "Compact parsed scan summary shown in the RootFS catalog UI.",
    },
    report_artifact: {
      type: "map",
      desc: "Internal artifact reference for the full scanner JSON report.",
    },
    report_bytes: {
      type: "number",
      desc: "Raw full-report byte size, if retained.",
    },
    report_compressed_bytes: {
      type: "number",
      desc: "Compressed full-report byte size, if retained.",
    },
    report_sha256: {
      type: "string",
      desc: "SHA256 of the retained raw or compressed report artifact.",
    },
    report_retention_until: {
      type: "timestamp",
      desc: "When the full report artifact may be garbage-collected.",
    },
    error: {
      type: "string",
      desc: "Compact scanner or execution error message.",
    },
    error_code: {
      type: "string",
      pg_type: "VARCHAR(64)",
      desc: "Stable scanner or execution error code.",
    },
    created_at: {
      type: "timestamp",
      desc: "When this row was created.",
    },
    updated_at: {
      type: "timestamp",
      desc: "When this row was last updated.",
    },
  },
});
