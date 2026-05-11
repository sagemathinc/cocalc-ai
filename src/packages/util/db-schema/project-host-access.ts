/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "project_host_access",
  rules: {
    primary_key: ["host_id", "account_id"],
    pg_indexes: ["account_id", "host_id", "role", "revoked_at"],
  },
  fields: {
    host_id: {
      type: "uuid",
      desc: "Dedicated project host id.",
    },
    account_id: {
      type: "uuid",
      desc: "Account granted delegated access to this host.",
    },
    role: {
      type: "string",
      desc: "Delegated host role: user or manager.",
    },
    created_by: {
      type: "uuid",
      desc: "Account that originally granted this access.",
    },
    created_at: {
      type: "timestamp",
      desc: "When this access row was first created.",
    },
    updated_by: {
      type: "uuid",
      desc: "Account that last changed this access row.",
    },
    updated_at: {
      type: "timestamp",
      desc: "When this access row was last changed.",
    },
    revoked_at: {
      type: "timestamp",
      desc: "When this access was revoked; null means active.",
    },
    revoked_by: {
      type: "uuid",
      desc: "Account that revoked this access.",
    },
  },
});
