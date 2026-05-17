/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "rootfs_release_scan_reports",
  rules: {
    primary_key: "report_id",
    pg_indexes: ["scan_run_id", "release_id", "retention_until", "created_at"],
  },
  fields: {
    report_id: {
      type: "uuid",
      desc: "Stable identifier for a retained scanner report artifact.",
    },
    scan_run_id: {
      type: "uuid",
      desc: "RootFS scan run that produced this report.",
    },
    release_id: {
      type: "uuid",
      desc: "RootFS release that was scanned.",
    },
    format: {
      type: "string",
      pg_type: "VARCHAR(64)",
      desc: "Scanner report format, e.g. trivy-json.",
    },
    report_json: {
      type: "map",
      desc: "Full scanner JSON report retained for admin/SOC-2 evidence.",
    },
    report_bytes: {
      type: "number",
      desc: "Raw scanner report byte size.",
    },
    report_sha256: {
      type: "string",
      desc: "SHA256 of the raw scanner report bytes.",
    },
    retention_until: {
      type: "timestamp",
      desc: "When this retained report may be deleted.",
    },
    created_at: {
      type: "timestamp",
      desc: "When this report row was created.",
    },
  },
});
