/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "deleted_projects",
  fields: {
    project_id: {
      type: "uuid",
      desc: "Original workspace id.",
    },
    name: {
      type: "string",
      pg_type: "VARCHAR(100)",
      desc: "Workspace name at delete time.",
    },
    title: {
      type: "string",
      desc: "Workspace title at delete time.",
    },
    description: {
      type: "string",
      desc: "Workspace description at delete time.",
    },
    owner_account_id: {
      type: "uuid",
      desc: "Owner account id at delete time, if known.",
    },
    host_id: {
      type: "uuid",
      desc: "Assigned host at delete time, if any.",
    },
    backup_bucket_id: {
      type: "uuid",
      desc: "Backup bucket id used by this workspace at delete time, if any.",
    },
    created: {
      type: "timestamp",
      desc: "When the workspace was originally created.",
    },
    last_edited: {
      type: "timestamp",
      desc: "Last edited timestamp at delete time.",
    },
    deleted_at: {
      type: "timestamp",
      desc: "When permanent deletion was completed.",
    },
    deleted_by: {
      type: "uuid",
      desc: "Account id that initiated permanent deletion.",
    },
    backup_retention_days: {
      type: "integer",
      desc: "Configured delayed backup purge retention in days (0 means immediate).",
    },
    backup_purge_due_at: {
      type: "timestamp",
      desc: "When deferred backup purge should run.",
    },
    backup_purge_started_at: {
      type: "timestamp",
      desc: "When backup purge processing last started.",
    },
    backups_purged_at: {
      type: "timestamp",
      desc: "When backup snapshots were actually purged.",
    },
    backup_purge_status: {
      type: "string",
      desc: "Deferred backup purge status (scheduled, running, failed, purged).",
    },
    backup_purge_error: {
      type: "string",
      desc: "Most recent deferred backup purge error, if any.",
    },
    metadata: {
      type: "map",
      desc: "Small metadata map for audit/debug context.",
    },
  },
  rules: {
    primary_key: "project_id",
    pg_indexes: ["deleted_at", "deleted_by", "owner_account_id", "backup_purge_due_at"],
  },
});
