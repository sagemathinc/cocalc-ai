/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "project_labels",
  rules: {
    primary_key: ["project_id", "key"],
    pg_indexes: ["key", "value", "updated_at"],
  },
  fields: {
    project_id: {
      type: "uuid",
      desc: "Project that owns this label.",
    },
    key: {
      type: "string",
      pg_type: "VARCHAR(128)",
      desc: "Stable machine-readable project label key.",
    },
    value: {
      type: "string",
      desc: "Machine-readable project label value.",
    },
    created_by: {
      type: "uuid",
      desc: "Account that first created this label, if known.",
    },
    updated_by: {
      type: "uuid",
      desc: "Account that last updated this label, if known.",
    },
    created_at: {
      type: "timestamp",
      desc: "When this label was first created.",
    },
    updated_at: {
      type: "timestamp",
      desc: "When this label was last changed.",
    },
  },
});
