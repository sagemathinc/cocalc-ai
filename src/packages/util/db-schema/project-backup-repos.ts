/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "project_backup_repos",
  rules: {
    primary_key: "id",
    pg_indexes: ["region", "status", "bucket_id"],
    pg_unique_indexes: ["(bucket_id,root)"],
  },
  fields: {
    id: {
      type: "uuid",
      desc: "Internal id of the shared project-backup repository assignment target.",
    },
    region: {
      type: "string",
      desc: "Region this repository serves, e.g. wnam or apac.",
    },
    bucket_id: {
      type: "uuid",
      desc: "Bucket row backing this rustic repository.",
    },
    root: {
      type: "string",
      desc: "Root prefix inside the bucket for this repository.",
    },
    secret: {
      type: "string",
      desc: "Encrypted shared rustic password for this repository.",
    },
    status: {
      type: "string",
      desc: "Repository assignment status, e.g. active, draining, or disabled.",
    },
    created: {
      type: "timestamp",
      desc: "When this repository row was created.",
    },
    updated: {
      type: "timestamp",
      desc: "When this repository row was last updated.",
    },
  },
});
