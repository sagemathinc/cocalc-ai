/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "claude_controller_ownership",
  rules: { primary_key: "account_id" },
  fields: {
    account_id: {
      type: "uuid",
      desc: "Account-home Claude profile authority.",
    },
    ownership: {
      type: "map",
      desc: "Private non-expiring controller/sign-in fence and retired attempts; survives credential replacement and revocation.",
    },
    updated: { type: "timestamp", desc: "Last ownership transition." },
  },
});
