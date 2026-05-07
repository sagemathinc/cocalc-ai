/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "membership_claim_scopes",
  rules: {
    primary_key: "scope_id",
    pg_indexes: ["scope_key", "scope_kind", "updated"],
    pg_unique_indexes: ["scope_key"],
    user_query: {
      get: {
        admin: true,
        fields: {
          scope_id: null,
          scope_key: null,
          scope_kind: null,
          metadata: null,
          created: null,
          updated: null,
        },
      },
      set: {
        admin: true,
        delete: true,
        fields: {
          scope_id: null,
          scope_key: null,
          scope_kind: null,
          metadata: null,
        },
      },
    },
  },
  fields: {
    scope_id: {
      type: "uuid",
      desc: "Stable seed-global claim scope id.",
    },
    scope_key: {
      type: "string",
      pg_type: "VARCHAR(512)",
      desc: "Stable dedupe key for an institutional claim scope.",
    },
    scope_kind: {
      type: "string",
      pg_type: "VARCHAR(64)",
      desc: "Scope kind, e.g. institutional-domain-set.",
    },
    metadata: {
      type: "map",
      desc: "Optional scope metadata such as allowed domains or provisioning hints.",
    },
    created: {
      type: "timestamp",
      desc: "Creation time.",
    },
    updated: {
      type: "timestamp",
      desc: "Last updated time.",
    },
  },
});

Table({
  name: "membership_claim_identities",
  rules: {
    primary_key: ["scope_id", "canonical_identity"],
    pg_indexes: [
      "account_id",
      "state",
      "assignment_id",
      "package_id",
      "grant_id",
      "reservation_expires_at",
      "updated",
    ],
    user_query: {
      get: {
        admin: true,
        fields: {
          scope_id: null,
          canonical_identity: null,
          account_id: null,
          state: null,
          reservation_id: null,
          package_id: null,
          assignment_id: null,
          grant_id: null,
          matched_email_address: null,
          claimed_domain: null,
          reservation_expires_at: null,
          activated_at: null,
          revoked_at: null,
          metadata: null,
          created: null,
          updated: null,
        },
      },
      set: {
        admin: true,
        delete: true,
        fields: {
          scope_id: null,
          canonical_identity: null,
          account_id: null,
          state: null,
          reservation_id: null,
          package_id: null,
          assignment_id: null,
          grant_id: null,
          matched_email_address: null,
          claimed_domain: null,
          reservation_expires_at: null,
          activated_at: null,
          revoked_at: null,
          metadata: null,
        },
      },
    },
  },
  fields: {
    scope_id: {
      type: "uuid",
      desc: "Seed-global institutional claim scope id.",
    },
    canonical_identity: {
      type: "string",
      pg_type: "VARCHAR(320)",
      desc: "Canonicalized institutional email identity used for dedupe.",
    },
    account_id: {
      type: "uuid",
      desc: "Account currently holding or reserving this institutional identity.",
      render: { type: "account" },
    },
    state: {
      type: "string",
      pg_type: "VARCHAR(16)",
      desc: "Current identity state: pending, active, or revoked.",
    },
    reservation_id: {
      type: "uuid",
      desc: "Reservation token used while a claim is being finalized.",
    },
    package_id: {
      type: "uuid",
      desc: "Package currently associated with this identity, if active.",
    },
    assignment_id: {
      type: "uuid",
      desc: "Assignment currently associated with this identity, if active.",
    },
    grant_id: {
      type: "uuid",
      desc: "Grant currently associated with this identity, if active.",
    },
    matched_email_address: {
      type: "string",
      pg_type: "VARCHAR(254)",
      desc: "Exact verified email address that matched the institutional claim.",
    },
    claimed_domain: {
      type: "string",
      pg_type: "VARCHAR(254)",
      desc: "Domain matched during the institutional claim.",
    },
    reservation_expires_at: {
      type: "timestamp",
      desc: "When a pending reservation stops blocking duplicate claims.",
    },
    activated_at: {
      type: "timestamp",
      desc: "When this claim identity became active.",
    },
    revoked_at: {
      type: "timestamp",
      desc: "When this claim identity was released.",
    },
    metadata: {
      type: "map",
      desc: "Optional claim metadata for support and audit.",
    },
    created: {
      type: "timestamp",
      desc: "Creation time.",
    },
    updated: {
      type: "timestamp",
      desc: "Last updated time.",
    },
  },
});
