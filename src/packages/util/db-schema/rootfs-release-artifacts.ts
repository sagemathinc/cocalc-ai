/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "rootfs_release_artifacts",
  rules: {
    primary_key: "artifact_id",
    pg_indexes: ["release_id", "content_key", "backend", "region", "status"],
  },
  fields: {
    artifact_id: {
      type: "uuid",
      desc: "Stable identifier for this stored RootFS artifact replica.",
    },
    release_id: {
      type: "uuid",
      desc: "RootFS release that this artifact replica belongs to.",
    },
    content_key: {
      type: "string",
      desc: "Logical content key for the release represented by this artifact.",
    },
    backend: {
      type: "string",
      desc: "Storage backend for this artifact replica (r2 or rest).",
    },
    region: {
      type: "string",
      desc: "Replica region hint, e.g. wnam/apac.",
    },
    bucket_id: {
      type: "uuid",
      desc: "Bucket row used for this artifact replica when backend is object storage.",
    },
    bucket_name: {
      type: "string",
      desc: "Provider bucket name for this artifact replica.",
    },
    bucket_purpose: {
      type: "string",
      desc: "Purpose of the bucket row, e.g. project-backups.",
    },
    artifact_kind: {
      type: "string",
      desc: "Artifact kind for this replica (currently full).",
    },
    artifact_format: {
      type: "string",
      desc: "Artifact format for this replica (currently rustic).",
    },
    artifact_path: {
      type: "string",
      desc: "Backend-relative object key or path for this artifact replica.",
    },
    artifact_sha256: {
      type: "string",
      desc: "SHA256 of the exact stored artifact bytes.",
    },
    artifact_bytes: {
      type: "number",
      desc: "Stored artifact size in bytes.",
    },
    status: {
      type: "string",
      desc: "Replica status (pending, ready, failed, deleted).",
    },
    replicated_from_artifact_id: {
      type: "uuid",
      desc: "Optional parent artifact replica that this copy was replicated from.",
    },
    error: {
      type: "string",
      desc: "Most recent error for this artifact replica, if any.",
    },
    created: {
      type: "timestamp",
      desc: "When this artifact replica row was created.",
    },
    updated: {
      type: "timestamp",
      desc: "When this artifact replica row was last updated.",
    },
  },
});
