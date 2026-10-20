/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "admin_alert_state",
  rules: { primary_key: "subject" },
  fields: {
    subject: {
      type: "string",
      desc: "Subject of a condition alert, e.g. low root filesystem space on project hosts.",
    },
    active: {
      type: "boolean",
      desc: "Whether the condition was present when last checked.",
    },
    cleared_at: {
      type: "timestamp",
      desc: "When the condition was last seen to clear. Alerts sent before this are not duplicates of a recurrence.",
    },
    updated_at: {
      type: "timestamp",
      desc: "When this state was last updated.",
      pg_default: "now()",
      not_null: true,
    },
  },
});
