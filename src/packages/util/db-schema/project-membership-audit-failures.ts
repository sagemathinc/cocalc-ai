/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

// How often the project membership audit trigger failed to record a change
// (database/postgres/schema/project-membership-audit.ts), per day, so admin
// health notices a broken audit. No personal data.
Table({
  name: "project_membership_audit_failures",
  rules: {
    primary_key: "day",
    user_query: {
      get: {
        admin: true,
        fields: {
          day: null,
          failures: null,
          last_error: null,
          last_failed_at: null,
        },
      },
    },
  },
  fields: {
    day: {
      type: "string",
      pg_type: "DATE",
      desc: "UTC day of the failures.",
    },
    failures: {
      type: "integer",
      desc: "Membership changes that day whose audit row could not be written.",
    },
    last_error: {
      type: "string",
      pg_type: "VARCHAR(500)",
      desc: "The most recent database error.",
    },
    last_failed_at: {
      type: "timestamp",
      desc: "When the most recent failure happened.",
    },
  },
});
