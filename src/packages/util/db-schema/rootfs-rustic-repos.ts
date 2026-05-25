/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "rootfs_rustic_repos",
  rules: {
    primary_key: "id",
    pg_indexes: ["region", "status", "bucket_id"],
    pg_unique_indexes: ["(bucket_id,root)"],
  },
  fields: {
    id: {
      type: "uuid",
      desc: "Internal id of a sharded RootFS rustic repository.",
    },
    region: {
      type: "string",
      desc: "Region this repository serves, e.g. wnam or apac.",
    },
    bucket_id: {
      type: "uuid",
      desc: "Bucket row backing this RootFS rustic repository.",
    },
    root: {
      type: "string",
      desc: "Root prefix inside the bucket for this RootFS rustic repository.",
    },
    secret: {
      type: "string",
      desc: "Shared rustic password for this repository.",
    },
    status: {
      type: "string",
      desc: "Repository assignment status, e.g. active, sealed, draining, or disabled.",
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
