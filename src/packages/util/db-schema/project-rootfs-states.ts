/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "project_rootfs_states",
  rules: {
    primary_key: ["project_id", "state_role"],
    pg_indexes: [
      "release_id",
      "runtime_image",
      "set_by_account_id",
      "updated",
      "state_role",
    ],
  },
  fields: {
    project_id: {
      type: "uuid",
      desc: "Project that owns this retained RootFS state.",
    },
    state_role: {
      type: "string",
      pg_type: "VARCHAR(16)",
      desc: "Whether this retained state is the current or previous RootFS environment.",
    },
    runtime_image: {
      type: "string",
      desc: "Concrete runtime image string for this retained RootFS state.",
    },
    release_id: {
      type: "string",
      pg_type: "VARCHAR(128)",
      desc: "Optional managed RootFS release referenced by this state.",
    },
    image_id: {
      type: "string",
      pg_type: "VARCHAR(128)",
      desc: "Optional catalog/image id that resolved to this runtime image when selected.",
    },
    set_by_account_id: {
      type: "uuid",
      desc: "Account that explicitly selected this RootFS state for the project.",
    },
    created: {
      type: "timestamp",
      desc: "When this state row was first created.",
    },
    updated: {
      type: "timestamp",
      desc: "When this state row was last refreshed or moved between roles.",
    },
  },
});
