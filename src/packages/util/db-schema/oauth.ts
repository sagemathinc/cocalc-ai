/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Tables for CoCalc as an OAuth 2 sign-in provider for registered clients
// (currently only Sagebrush), and for asking those clients to purge a deleted
// account's data. See docs/sagebrush.md.

import { Table } from "./types";

Table({
  name: "oauth_authorization_codes",
  rules: {
    primary_key: "code_hash",
    durability: "soft",
    pg_indexes: ["expire"],
  },
  fields: {
    code_hash: {
      type: "string",
      pg_type: "char(64)",
      desc: "SHA-256 hex hash of the one-time authorization code. The code itself is never stored.",
    },
    client_id: {
      type: "string",
      pg_type: "varchar(64)",
      desc: "Registered OAuth client the code was issued to.",
    },
    account_id: {
      type: "uuid",
      desc: "Account that approved the sign-in.",
    },
    email_address: {
      type: "string",
      desc: "The verified email address of the account when it approved the sign-in.",
    },
    redirect_uri: {
      type: "string",
      desc: "Redirect URI from the authorize request; the token request must repeat it exactly.",
    },
    code_challenge: {
      type: "string",
      pg_type: "varchar(128)",
      desc: "PKCE S256 code challenge from the authorize request.",
    },
    created: {
      type: "timestamp",
      desc: "When the code was issued.",
    },
    expire: {
      type: "timestamp",
      desc: "When the code stops being valid.",
    },
    used_at: {
      type: "timestamp",
      desc: "When the first redemption attempt used up the code.",
    },
  },
});

Table({
  name: "oauth_client_approvals",
  rules: {
    primary_key: ["account_id", "client_id"],
  },
  fields: {
    account_id: {
      type: "uuid",
      desc: "Account that approved a sign-in for the client.",
    },
    client_id: {
      type: "string",
      pg_type: "varchar(64)",
      desc: "Registered OAuth client.",
    },
    first_approved: {
      type: "timestamp",
      desc: "When the account first approved a sign-in for the client.",
    },
    last_approved: {
      type: "timestamp",
      desc: "When the account most recently approved a sign-in for the client.",
    },
  },
});

Table({
  name: "oauth_client_purge_requests",
  rules: {
    primary_key: "request_id",
    pg_indexes: ["next_attempt_at", "account_id"],
  },
  fields: {
    request_id: {
      type: "uuid",
      desc: "Idempotency id sent to the client with every attempt.",
    },
    client_id: {
      type: "string",
      pg_type: "varchar(64)",
      desc: "Registered OAuth client asked to purge the account's data.",
    },
    account_id: {
      type: "uuid",
      desc: "Deleted account whose data the client must purge.",
    },
    created: {
      type: "timestamp",
      desc: "When the account deletion queued this request.",
    },
    attempts: {
      type: "integer",
      desc: "Number of delivery attempts so far.",
    },
    next_attempt_at: {
      type: "timestamp",
      desc: "When the next delivery attempt is due; null once accepted.",
    },
    last_attempt_at: {
      type: "timestamp",
      desc: "When the last delivery attempt was made.",
    },
    last_error: {
      type: "string",
      desc: "Why the last delivery attempt failed.",
    },
    accepted_at: {
      type: "timestamp",
      desc: "When the client accepted the request (HTTP 202).",
    },
    alerted_at: {
      type: "timestamp",
      desc: "When admins were alerted that the request is overdue.",
    },
  },
});
