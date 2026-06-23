/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "project_rootfs_builds",
  rules: {
    primary_key: "build_id",
    pg_indexes: [
      "project_id",
      "account_id",
      "host_id",
      "op_id",
      "status",
      "recipe_ref",
      "created_at",
      "updated",
      "(project_id, created_at)",
    ],
  },
  fields: {
    build_id: {
      type: "string",
      pg_type: "VARCHAR(128)",
      desc: "Durable rootfs build id.",
    },
    project_id: {
      type: "uuid",
      desc: "Project whose filesystem is being built.",
    },
    account_id: {
      type: "uuid",
      desc: "Account that started the build, if known.",
    },
    host_id: {
      type: "uuid",
      desc: "Project host that owns the build subprocess and artifacts.",
    },
    op_id: {
      type: "uuid",
      desc: "Associated long-running operation id.",
    },
    status: {
      type: "string",
      pg_type: "VARCHAR(32)",
      desc: "Latest known build status.",
    },
    recipe_ref: {
      type: "string",
      desc: "Recipe reference used for the build.",
    },
    paths: {
      type: "map",
      desc: "Project-relative artifact paths such as log, events, script, and status.",
    },
    pid: {
      type: "integer",
      desc: "Latest known runner process id on the project host.",
    },
    exit_code: {
      type: "integer",
      desc: "Runner exit code for terminal builds.",
    },
    signal: {
      type: "string",
      pg_type: "VARCHAR(32)",
      desc: "Signal that terminated the runner, if any.",
    },
    error: {
      type: "string",
      desc: "Latest known build error.",
    },
    created_at: {
      type: "timestamp",
      desc: "Build creation time reported by the project host or hub.",
    },
    started_at: {
      type: "timestamp",
      desc: "Build start time reported by the project host.",
    },
    finished_at: {
      type: "timestamp",
      desc: "Build finish time reported by the project host.",
    },
    heartbeat_at: {
      type: "timestamp",
      desc: "Latest heartbeat time reported by the project-host runner.",
    },
    last_output_at: {
      type: "timestamp",
      desc: "Latest output time reported by the project-host runner.",
    },
    updated: {
      type: "timestamp",
      desc: "When the hub last reconciled this build row.",
    },
  },
});
