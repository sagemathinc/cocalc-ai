/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "support_ticket_attempts",
  rules: {
    primary_key: "id",
    durability: "soft",
    pg_indexes: [
      "time",
      "expire",
      "ip_address",
      "email_address",
      "account_id",
      "accepted",
    ],
  },
  fields: {
    id: {
      type: "uuid",
      desc: "Unique support ticket attempt id.",
    },
    time: {
      type: "timestamp",
      desc: "When this ticket creation attempt happened.",
    },
    expire: {
      type: "timestamp",
      desc: "When this anti-abuse record can be deleted.",
    },
    ip_address: {
      type: "string",
      pg_type: "inet",
      desc: "Request IP address, if available.",
    },
    email_address: {
      type: "string",
      pg_type: "VARCHAR(254)",
      desc: "Normalized requester email address, if available.",
    },
    account_id: {
      type: "uuid",
      desc: "Signed-in account id, if available.",
      render: { type: "account" },
    },
    accepted: {
      type: "boolean",
      desc: "True if this attempt was allowed through to Zendesk.",
    },
    reason: {
      type: "string",
      desc: "Blocked reason or internal diagnostic for this attempt.",
    },
  },
});
