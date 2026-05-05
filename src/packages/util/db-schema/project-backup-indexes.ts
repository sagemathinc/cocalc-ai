/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "project_backup_indexes",
  rules: {
    primary_key: "id",
    pg_indexes: ["project_id", "status", "bucket_id", "host_id"],
    pg_unique_indexes: ["(project_id,backup_id)"],
  },
  fields: {
    id: {
      type: "uuid",
      desc: "Internal id of a persisted backup-index artifact manifest row.",
    },
    project_id: {
      type: "uuid",
      desc: "Project that owns the indexed backup.",
    },
    backup_id: {
      type: "string",
      desc: "Rustic backup snapshot id for the corresponding project backup.",
    },
    backup_time: {
      type: "timestamp",
      desc: "Snapshot time of the corresponding project backup.",
    },
    status: {
      type: "string",
      desc: "Index publication status, e.g. complete or failed.",
    },
    storage_backend: {
      type: "string",
      desc: "Remote storage backend for the index artifact, e.g. r2-object-store.",
    },
    bucket_id: {
      type: "uuid",
      desc: "Bucket row backing the stored index artifact.",
    },
    object_key: {
      type: "string",
      desc: "Object-store key for the compressed sqlite sidecar.",
    },
    compression: {
      type: "string",
      desc: "Compression used for the stored sqlite sidecar.",
    },
    sqlite_bytes: {
      type: "integer",
      desc: "Size of the local sqlite file before compression.",
    },
    object_bytes: {
      type: "integer",
      desc: "Size of the stored object after compression.",
    },
    sha256: {
      type: "string",
      desc: "SHA-256 of the stored compressed object payload.",
    },
    error: {
      type: "string",
      desc: "Last error observed while publishing the index artifact, if any.",
    },
    host_id: {
      type: "uuid",
      desc: "Host that last reported the index publication status.",
    },
    created: {
      type: "timestamp",
      desc: "When this manifest row was created.",
    },
    updated: {
      type: "timestamp",
      desc: "When this manifest row was last updated.",
    },
  },
});
