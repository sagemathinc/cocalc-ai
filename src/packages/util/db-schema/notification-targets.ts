/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "notification_targets",
  rules: {
    primary_key: ["event_id", "target_account_id"],
    pg_indexes: ["target_home_bay_id", "notification_id", "created_at"],
  },
  fields: {
    event_id: {
      type: "uuid",
      desc: "Authoritative notification event id.",
    },
    target_account_id: {
      type: "uuid",
      desc: "Account that should receive this notification.",
    },
    target_home_bay_id: {
      type: "string",
      desc: "Home bay of the target account.",
    },
    notification_id: {
      type: "uuid",
      desc: "Stable account-facing notification id for this target.",
    },
    dedupe_key: {
      type: "string",
      desc: "Optional dedupe key for suppressing repeated notifications.",
    },
    created_at: {
      type: "timestamp",
      desc: "When this target row was created.",
    },
  },
});
