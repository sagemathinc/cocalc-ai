/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { Table } from "./types";

export const COMMERCIAL_QUOTE_LIFECYCLE_CONSTRAINT =
  "commercial_quotes_lifecycle_v2_check";
export const COMMERCIAL_QUOTE_LIFECYCLE_EXPRESSION =
  "status IN ('draft','issued','accepted','void') " +
  "AND (status NOT IN ('issued','accepted') OR " +
  "(issued_at IS NOT NULL AND document_filename IS NOT NULL " +
  "AND document_mime_type IS NOT NULL AND document_sha256 IS NOT NULL " +
  "AND document_size IS NOT NULL AND document_data IS NOT NULL)) " +
  "AND (status <> 'void' OR " +
  "(voided_at IS NOT NULL AND voided_by_account_id IS NOT NULL))";

const money = {
  type: "number" as const,
  pg_type: "numeric(20,10)",
  not_null: true,
  pg_default: "0",
};

Table({
  name: "commercial_orders",
  rules: {
    primary_key: "id",
    pg_indexes: [
      "crm_organization_id",
      "customer_account_id",
      "site_license_id",
      "workflow_state",
      "collection_state",
      "fulfillment_state",
      "assignee_account_id",
      "next_action_due_at",
      "updated_at",
    ],
    pg_unique_indexes: ["order_number"],
    pg_custom_indexes: [
      {
        name: "commercial_orders_zendesk_ticket_ids_idx",
        query: "USING GIN (zendesk_ticket_ids)",
      },
      {
        name: "commercial_orders_updated_cursor_idx",
        query: "(updated_at DESC,id DESC)",
      },
      {
        name: "commercial_orders_open_queue_idx",
        query:
          "(next_action_due_at, updated_at) WHERE workflow_state NOT IN ('complete','cancelled')",
      },
    ],
  },
  fields: {
    id: { type: "uuid", not_null: true },
    order_number: {
      type: "string",
      pg_type: "VARCHAR(40)",
      not_null: true,
      pg_check: "CHECK (btrim(order_number) <> '')",
    },
    crm_organization_id: { type: "uuid" },
    organization_name: {
      type: "string",
      not_null: true,
      pg_check: "CHECK (btrim(organization_name) <> '')",
    },
    customer_account_id: { type: "uuid", render: { type: "account" } },
    stripe_customer_id: { type: "string" },
    site_license_id: { type: "uuid" },
    zendesk_ticket_ids: {
      type: "array",
      pg_type: "INTEGER[]",
      not_null: true,
      pg_default: "'{}'::integer[]",
    },
    workflow_state: {
      type: "string",
      pg_type: "VARCHAR(32)",
      not_null: true,
      pg_default: "'draft'::character varying",
      pg_check:
        "CHECK (workflow_state IN ('draft','awaiting_customer','ready_to_invoice','awaiting_payment','complete','cancelled')) " +
        "CHECK (workflow_state IN ('complete','cancelled') OR (btrim(next_action) <> '' AND next_action_due_at IS NOT NULL)) " +
        "CHECK (workflow_state <> 'complete' OR completed_at IS NOT NULL) " +
        "CHECK (workflow_state <> 'cancelled' OR cancelled_at IS NOT NULL)",
    },
    collection_mode: {
      type: "string",
      pg_type: "VARCHAR(32)",
      not_null: true,
      pg_default: "'stripe_invoice'::character varying",
      pg_check:
        "CHECK (collection_mode IN ('stripe_invoice','manual_invoice','complimentary'))",
    },
    collection_state: {
      type: "string",
      pg_type: "VARCHAR(32)",
      not_null: true,
      pg_default: "'not_invoiced'::character varying",
      pg_check:
        "CHECK (collection_state IN ('not_invoiced','draft_invoice','open','partially_paid','paid','overdue','void','uncollectible','waived'))",
    },
    fulfillment_state: {
      type: "string",
      pg_type: "VARCHAR(32)",
      not_null: true,
      pg_default: "'not_provisioned'::character varying",
      pg_check:
        "CHECK (fulfillment_state IN ('not_provisioned','provisioned','ended'))",
    },
    currency: {
      type: "string",
      pg_type: "VARCHAR(3)",
      not_null: true,
      pg_default: "'usd'::character varying",
      pg_check: "CHECK (currency = 'usd')",
    },
    agreed_subtotal: {
      ...money,
      pg_check: "CHECK (agreed_subtotal > 0)",
    },
    agreed_total: {
      ...money,
      pg_check: "CHECK (agreed_total > 0 AND agreed_total >= agreed_subtotal)",
    },
    service_starts_at: { type: "timestamp" },
    service_ends_at: {
      type: "timestamp",
      pg_check:
        "CHECK (service_starts_at IS NULL OR service_ends_at >= service_starts_at)",
    },
    payment_terms_days: {
      type: "integer",
      pg_check: "CHECK (payment_terms_days IS NULL OR payment_terms_days >= 0)",
    },
    po_number: { type: "string" },
    customer_reference: { type: "string" },
    terms_snapshot: {
      type: "map",
      not_null: true,
      pg_default: "'{}'::jsonb",
    },
    assignee_account_id: { type: "uuid", render: { type: "account" } },
    next_action: {
      type: "string",
      not_null: true,
      pg_default: "'Review agreement'::text",
      pg_check:
        "CHECK (next_action IN ('Review agreement','Contact customer','Await customer response','Confirm billing details','Obtain purchase order','Approve agreement','Create invoice','Send invoice','Collect payment','Follow up on overdue payment','Reconcile payment','Provision service','Resolve exception','Complete','Cancelled'))",
    },
    next_action_due_at: { type: "timestamp" },
    approved_at: {
      type: "timestamp",
      pg_check:
        "CHECK ((approved_at IS NULL) = (approved_by_account_id IS NULL))",
    },
    approved_by_account_id: { type: "uuid", render: { type: "account" } },
    provisioned_at: { type: "timestamp" },
    completed_at: { type: "timestamp" },
    cancelled_at: { type: "timestamp" },
    created_by_account_id: {
      type: "uuid",
      not_null: true,
      render: { type: "account" },
    },
    created_at: { type: "timestamp", not_null: true, pg_default: "now()" },
    updated_at: { type: "timestamp", not_null: true, pg_default: "now()" },
    version: {
      type: "integer",
      not_null: true,
      pg_default: "1",
      pg_check: "CHECK (version >= 1)",
    },
  },
});

Table({
  name: "commercial_order_items",
  rules: {
    primary_key: "id",
    pg_indexes: ["commercial_order_id", "product_kind"],
    pg_unique_indexes: ["(commercial_order_id,position)"],
  },
  fields: {
    id: { type: "uuid", not_null: true },
    commercial_order_id: { type: "uuid", not_null: true },
    position: {
      type: "integer",
      not_null: true,
      pg_check: "CHECK (position >= 0)",
    },
    description: {
      type: "string",
      not_null: true,
      pg_check: "CHECK (btrim(description) <> '')",
    },
    quantity: { ...money, pg_check: "CHECK (quantity > 0)" },
    unit_amount: { ...money, pg_check: "CHECK (unit_amount > 0)" },
    subtotal: {
      ...money,
      pg_check:
        "CHECK (subtotal > 0 AND subtotal = round(quantity * unit_amount, 2))",
    },
    service_start: { type: "timestamp" },
    service_end: {
      type: "timestamp",
      pg_check: "CHECK (service_start IS NULL OR service_end >= service_start)",
    },
    product_kind: {
      type: "string",
      not_null: true,
      pg_check: "CHECK (btrim(product_kind) <> '')",
    },
    product_reference: { type: "string" },
    metadata: { type: "map", not_null: true, pg_default: "'{}'::jsonb" },
    created_at: { type: "timestamp", not_null: true, pg_default: "now()" },
    updated_at: { type: "timestamp", not_null: true, pg_default: "now()" },
  },
});

Table({
  name: "commercial_order_contacts",
  rules: {
    primary_key: "id",
    pg_indexes: ["commercial_order_id", "crm_person_id", "role"],
  },
  fields: {
    id: { type: "uuid", not_null: true },
    commercial_order_id: { type: "uuid", not_null: true },
    crm_person_id: { type: "uuid" },
    role: {
      type: "string",
      pg_type: "VARCHAR(32)",
      not_null: true,
      pg_check:
        "CHECK (role IN ('primary','billing','procurement','technical','manager'))",
    },
    name_snapshot: {
      type: "string",
      not_null: true,
      pg_check: "CHECK (btrim(name_snapshot) <> '')",
    },
    email_snapshot: {
      type: "string",
      not_null: true,
      pg_check: "CHECK (btrim(email_snapshot) <> '')",
    },
    organization_snapshot: { type: "string" },
    created_at: { type: "timestamp", not_null: true, pg_default: "now()" },
    updated_at: { type: "timestamp", not_null: true, pg_default: "now()" },
  },
});

Table({
  name: "commercial_quotes",
  rules: {
    primary_key: "id",
    pg_indexes: [
      "commercial_order_id",
      "status",
      "provider",
      "provider_status",
      "issued_at",
      "valid_until",
      "updated_at",
    ],
    pg_unique_indexes: [
      "quote_number",
      "provider_quote_id",
      "idempotency_key",
      "download_token_hash",
    ],
    pg_constraints: [
      {
        name: COMMERCIAL_QUOTE_LIFECYCLE_CONSTRAINT,
        type: "check",
        expression: COMMERCIAL_QUOTE_LIFECYCLE_EXPRESSION,
      },
    ],
  },
  fields: {
    id: { type: "uuid", not_null: true },
    commercial_order_id: { type: "uuid", not_null: true },
    quote_number: {
      type: "string",
      pg_type: "VARCHAR(64)",
      not_null: true,
      pg_check: "CHECK (btrim(quote_number) <> '')",
    },
    status: {
      type: "string",
      pg_type: "VARCHAR(32)",
      not_null: true,
      pg_default: "'issued'::character varying",
    },
    provider_quote_id: { type: "string" },
    provider_status: {
      type: "string",
      pg_type: "VARCHAR(32)",
      pg_check:
        "CHECK (provider_status IN ('draft','open','accepted','canceled'))",
    },
    provider_invoice_id: { type: "string" },
    // Declare the referenced provider columns first so existing databases can
    // add this cross-column constraint during an in-place schema sync.
    provider: {
      type: "string",
      pg_type: "VARCHAR(32)",
      not_null: true,
      pg_default: "'local'::character varying",
      pg_check:
        "CHECK (provider IN ('local','stripe')) " +
        "CHECK (provider <> 'local' OR (provider_quote_id IS NULL AND provider_status IS NULL AND provider_invoice_id IS NULL)) " +
        "CHECK (provider_status IS NULL OR provider_quote_id IS NOT NULL) " +
        "CHECK (provider_status <> 'draft' OR status = 'draft') " +
        "CHECK (provider_status <> 'open' OR status = 'issued') " +
        "CHECK (provider_status <> 'accepted' OR status = 'accepted') " +
        "CHECK (provider_status <> 'canceled' OR status = 'void')",
    },
    currency: {
      type: "string",
      pg_type: "VARCHAR(3)",
      not_null: true,
      pg_check: "CHECK (currency = 'usd')",
    },
    subtotal: { ...money, pg_check: "CHECK (subtotal > 0)" },
    total: { ...money, pg_check: "CHECK (total >= subtotal)" },
    issued_at: { type: "timestamp", not_null: false },
    valid_until: {
      type: "timestamp",
      not_null: true,
      pg_check: "CHECK (issued_at IS NULL OR valid_until > issued_at)",
    },
    voided_at: { type: "timestamp" },
    download_token_hash: { type: "string", pg_type: "VARCHAR(64)" },
    download_expires_at: { type: "timestamp" },
    download_window_at: { type: "timestamp" },
    download_window_count: { type: "integer", pg_default: "0" },
    document_filename: {
      type: "string",
      not_null: false,
      pg_check: "CHECK (btrim(document_filename) <> '')",
    },
    document_mime_type: {
      type: "string",
      pg_type: "VARCHAR(64)",
      not_null: false,
      pg_check: "CHECK (document_mime_type = 'application/pdf')",
    },
    document_sha256: {
      type: "string",
      pg_type: "VARCHAR(64)",
      not_null: false,
      pg_check: "CHECK (document_sha256 ~ '^[0-9a-f]{64}$')",
    },
    document_size: {
      type: "integer",
      not_null: false,
      pg_check: "CHECK (document_size > 0 AND document_size <= 2097152)",
    },
    document_data: { type: "Buffer", not_null: false },
    snapshot: { type: "map", not_null: true, pg_default: "'{}'::jsonb" },
    provider_snapshot: {
      type: "map",
      not_null: true,
      pg_default: "'{}'::jsonb",
    },
    provider_updated_at: { type: "timestamp" },
    last_reconciled_at: { type: "timestamp" },
    created_by_account_id: {
      type: "uuid",
      not_null: true,
      render: { type: "account" },
    },
    voided_by_account_id: { type: "uuid", render: { type: "account" } },
    idempotency_key: { type: "string", not_null: true },
    created_at: { type: "timestamp", not_null: true, pg_default: "now()" },
    updated_at: { type: "timestamp", not_null: true, pg_default: "now()" },
  },
});

Table({
  name: "commercial_order_documents",
  rules: {
    primary_key: "id",
    pg_indexes: [
      "commercial_order_id",
      "document_kind",
      "status",
      "created_at",
    ],
    pg_unique_indexes: ["idempotency_key"],
  },
  fields: {
    id: { type: "uuid", not_null: true },
    commercial_order_id: { type: "uuid", not_null: true },
    document_kind: {
      type: "string",
      pg_type: "VARCHAR(32)",
      not_null: true,
      pg_check: "CHECK (document_kind IN ('purchase_order'))",
    },
    status: {
      type: "string",
      pg_type: "VARCHAR(32)",
      not_null: true,
      pg_default: "'active'::character varying",
      pg_check:
        "CHECK (status IN ('active','void')) " +
        "CHECK (status <> 'void' OR (voided_at IS NOT NULL AND voided_by_account_id IS NOT NULL))",
    },
    document_reference: { type: "string" },
    note: { type: "string" },
    document_filename: {
      type: "string",
      pg_type: "VARCHAR(255)",
      not_null: true,
      pg_check: "CHECK (btrim(document_filename) <> '')",
    },
    document_mime_type: {
      type: "string",
      pg_type: "VARCHAR(64)",
      not_null: true,
      pg_check: "CHECK (document_mime_type = 'application/pdf')",
    },
    document_sha256: {
      type: "string",
      pg_type: "VARCHAR(64)",
      not_null: true,
      pg_check: "CHECK (document_sha256 ~ '^[0-9a-f]{64}$')",
    },
    document_size: {
      type: "integer",
      not_null: true,
      pg_check: "CHECK (document_size > 0 AND document_size <= 5242880)",
    },
    document_data: { type: "Buffer", not_null: true },
    created_by_account_id: {
      type: "uuid",
      not_null: true,
      render: { type: "account" },
    },
    voided_by_account_id: { type: "uuid", render: { type: "account" } },
    voided_at: { type: "timestamp" },
    idempotency_key: { type: "string", not_null: true },
    created_at: { type: "timestamp", not_null: true, pg_default: "now()" },
    updated_at: { type: "timestamp", not_null: true, pg_default: "now()" },
  },
});

Table({
  name: "commercial_invoices",
  rules: {
    primary_key: "id",
    pg_indexes: [
      "commercial_order_id",
      "status",
      "due_at",
      "last_reconciled_at",
      "updated_at",
    ],
    pg_unique_indexes: ["provider_invoice_id", "idempotency_key"],
    pg_custom_indexes: [
      {
        name: "commercial_invoices_one_active_idx",
        query:
          "(commercial_order_id) WHERE status IN ('creating','draft','open')",
        unique: true,
      },
      {
        name: "commercial_invoices_reconciliation_idx",
        query:
          "(COALESCE(last_reconciled_at,created_at),id) WHERE provider='stripe' AND status IN ('creating','draft','open')",
      },
    ],
  },
  fields: {
    id: { type: "uuid", not_null: true },
    commercial_order_id: { type: "uuid", not_null: true },
    provider: {
      type: "string",
      pg_type: "VARCHAR(32)",
      not_null: true,
      pg_default: "'stripe'::character varying",
      pg_check:
        "CHECK (provider IN ('stripe','manual')) " +
        "CHECK (provider <> 'manual' OR status IN ('open','paid','void','uncollectible','failed')) " +
        "CHECK (provider <> 'stripe' OR status IN ('creating','failed') OR provider_invoice_id IS NOT NULL)",
    },
    provider_customer_id: { type: "string" },
    provider_invoice_id: { type: "string" },
    provider_payment_intent_id: { type: "string" },
    status: {
      type: "string",
      pg_type: "VARCHAR(32)",
      not_null: true,
      pg_check:
        "CHECK (status IN ('creating','draft','open','paid','void','uncollectible','failed')) " +
        "CHECK (status <> 'paid' OR paid_at IS NOT NULL) " +
        "CHECK (status <> 'void' OR voided_at IS NOT NULL)",
    },
    currency: {
      type: "string",
      pg_type: "VARCHAR(3)",
      not_null: true,
      pg_check: "CHECK (currency = 'usd')",
    },
    subtotal: { ...money, pg_check: "CHECK (subtotal >= 0)" },
    tax: { ...money, pg_check: "CHECK (tax >= 0)" },
    total: { ...money, pg_check: "CHECK (total > 0)" },
    amount_due: {
      ...money,
      pg_check: "CHECK (amount_due >= 0)",
    },
    amount_paid: {
      ...money,
      pg_check: "CHECK (amount_paid >= 0)",
    },
    due_at: { type: "timestamp" },
    hosted_invoice_url: { type: "string" },
    invoice_pdf_url: { type: "string" },
    sent_at: { type: "timestamp" },
    paid_at: { type: "timestamp" },
    voided_at: { type: "timestamp" },
    last_reconciled_at: { type: "timestamp" },
    reconcile_attempt_count: {
      type: "integer",
      not_null: true,
      pg_default: "0",
      pg_check: "CHECK (reconcile_attempt_count >= 0)",
    },
    last_reconcile_error: { type: "string" },
    idempotency_key: { type: "string", not_null: true },
    provider_snapshot: {
      type: "map",
      not_null: true,
      pg_default: "'{}'::jsonb",
    },
    created_at: { type: "timestamp", not_null: true, pg_default: "now()" },
    updated_at: { type: "timestamp", not_null: true, pg_default: "now()" },
  },
});

Table({
  name: "commercial_payments",
  rules: {
    primary_key: "id",
    pg_indexes: [
      "commercial_order_id",
      "commercial_invoice_id",
      "status",
      "received_at",
    ],
    pg_unique_indexes: ["provider_payment_id", "idempotency_key"],
  },
  fields: {
    id: { type: "uuid", not_null: true },
    commercial_order_id: { type: "uuid", not_null: true },
    commercial_invoice_id: { type: "uuid" },
    provider: {
      type: "string",
      pg_type: "VARCHAR(32)",
      not_null: true,
      pg_check:
        "CHECK (provider IN ('stripe','manual')) " +
        "CHECK (provider <> 'stripe' OR provider_payment_id IS NOT NULL) " +
        "CHECK (provider <> 'manual' OR (recorded_by_account_id IS NOT NULL AND COALESCE(btrim(evidence_reference),'') <> ''))",
    },
    provider_payment_id: { type: "string" },
    amount: { ...money, pg_check: "CHECK (amount >= 0)" },
    currency: {
      type: "string",
      pg_type: "VARCHAR(3)",
      not_null: true,
      pg_check: "CHECK (currency = 'usd')",
    },
    status: {
      type: "string",
      pg_type: "VARCHAR(32)",
      not_null: true,
      pg_check:
        "CHECK (status IN ('pending','open','succeeded','failed','canceled','refunded','partially_refunded'))",
    },
    received_at: { type: "timestamp", not_null: true },
    method: {
      type: "string",
      pg_type: "VARCHAR(32)",
      not_null: true,
      pg_check:
        "CHECK (method IN ('card','ach','bank_transfer','check','wire','credit','other'))",
    },
    recorded_by_account_id: { type: "uuid", render: { type: "account" } },
    evidence_reference: { type: "string" },
    idempotency_key: { type: "string", not_null: true },
    created_at: { type: "timestamp", not_null: true, pg_default: "now()" },
    updated_at: { type: "timestamp", not_null: true, pg_default: "now()" },
  },
});

Table({
  name: "commercial_order_events",
  rules: {
    primary_key: "id",
    pg_indexes: ["commercial_order_id", "event_type", "created_at"],
    pg_unique_indexes: ["idempotency_key"],
    pg_custom_indexes: [
      {
        name: "commercial_order_events_timeline_idx",
        query: "(commercial_order_id,created_at DESC,id DESC)",
      },
    ],
  },
  fields: {
    id: { type: "uuid", not_null: true },
    commercial_order_id: { type: "uuid", not_null: true },
    event_type: {
      type: "string",
      not_null: true,
      pg_check: "CHECK (btrim(event_type) <> '')",
    },
    actor_account_id: { type: "uuid", render: { type: "account" } },
    source: {
      type: "string",
      pg_type: "VARCHAR(32)",
      not_null: true,
      pg_check:
        "CHECK (source IN ('admin-ui','cli','stripe-webhook','reconciler','migration','system'))",
    },
    reason: {
      type: "string",
      not_null: true,
      pg_check: "CHECK (btrim(reason) <> '')",
    },
    idempotency_key: { type: "string", not_null: true },
    before: { type: "map", not_null: true, pg_default: "'{}'::jsonb" },
    after: { type: "map", not_null: true, pg_default: "'{}'::jsonb" },
    metadata: { type: "map", not_null: true, pg_default: "'{}'::jsonb" },
    created_at: { type: "timestamp", not_null: true, pg_default: "now()" },
  },
});

Table({
  name: "commercial_stripe_events",
  rules: {
    primary_key: "event_id",
    pg_indexes: [
      "commercial_quote_id",
      "provider_quote_id",
      "status",
      "next_attempt_at",
      "lease_expires_at",
      "created_at",
    ],
    pg_custom_indexes: [
      {
        name: "commercial_stripe_events_claim_idx",
        query:
          "(next_attempt_at, created_at) WHERE status IN ('pending','processing','failed')",
      },
    ],
  },
  fields: {
    event_id: { type: "string", not_null: true },
    event_type: { type: "string", not_null: true },
    livemode: { type: "boolean", not_null: true },
    commercial_order_id: { type: "uuid" },
    commercial_quote_id: { type: "uuid" },
    commercial_invoice_id: { type: "uuid" },
    provider_quote_id: { type: "string" },
    provider_invoice_id: { type: "string" },
    status: {
      type: "string",
      pg_type: "VARCHAR(32)",
      not_null: true,
      pg_default: "'pending'::character varying",
      pg_check:
        "CHECK (status IN ('pending','processing','processed','failed','dead_letter','ignored')) " +
        "CHECK (status <> 'processing' OR lease_expires_at IS NOT NULL) " +
        "CHECK (status NOT IN ('processed','dead_letter','ignored') OR processed_at IS NOT NULL)",
    },
    payload: { type: "map", not_null: true, pg_default: "'{}'::jsonb" },
    attempt_count: {
      type: "integer",
      not_null: true,
      pg_default: "0",
      pg_check: "CHECK (attempt_count >= 0)",
    },
    next_attempt_at: { type: "timestamp", not_null: true, pg_default: "now()" },
    lease_expires_at: { type: "timestamp" },
    last_error: { type: "string" },
    processed_at: { type: "timestamp" },
    created_at: { type: "timestamp", not_null: true, pg_default: "now()" },
    updated_at: { type: "timestamp", not_null: true, pg_default: "now()" },
  },
});

Table({
  name: "commercial_provider_operations",
  rules: {
    primary_key: "id",
    pg_indexes: [
      "commercial_order_id",
      "commercial_quote_id",
      "commercial_invoice_id",
      "operation",
      "status",
      "updated_at",
    ],
    pg_unique_indexes: ["idempotency_key"],
  },
  fields: {
    id: { type: "uuid", not_null: true },
    commercial_order_id: { type: "uuid", not_null: true },
    commercial_quote_id: { type: "uuid" },
    commercial_invoice_id: { type: "uuid" },
    operation: {
      type: "string",
      pg_type: "VARCHAR(32)",
      not_null: true,
      pg_check: "CHECK (btrim(operation) <> '')",
    },
    status: {
      type: "string",
      pg_type: "VARCHAR(32)",
      not_null: true,
      pg_default: "'reserved'::character varying",
      pg_check:
        "CHECK (status IN ('reserved','remote_started','succeeded','failed','indeterminate')) " +
        "CHECK (status NOT IN ('succeeded','failed') OR completed_at IS NOT NULL)",
    },
    idempotency_key: { type: "string", not_null: true },
    expected_version: {
      type: "integer",
      not_null: true,
      pg_check: "CHECK (expected_version >= 1)",
    },
    request: { type: "map", not_null: true, pg_default: "'{}'::jsonb" },
    result: { type: "map", not_null: true, pg_default: "'{}'::jsonb" },
    last_error: { type: "string" },
    attempt_count: {
      type: "integer",
      not_null: true,
      pg_default: "0",
      pg_check: "CHECK (attempt_count >= 0)",
    },
    remote_started_at: { type: "timestamp" },
    completed_at: { type: "timestamp" },
    created_at: { type: "timestamp", not_null: true, pg_default: "now()" },
    updated_at: { type: "timestamp", not_null: true, pg_default: "now()" },
  },
});

Table({
  name: "commercial_worker_state",
  rules: {
    primary_key: "worker_name",
    pg_indexes: ["lease_expires_at", "last_success_at", "updated_at"],
  },
  fields: {
    worker_name: {
      type: "string",
      pg_type: "VARCHAR(96)",
      not_null: true,
      pg_check: "CHECK (btrim(worker_name) <> '')",
    },
    lease_owner: { type: "string" },
    lease_expires_at: { type: "timestamp" },
    last_started_at: { type: "timestamp" },
    last_success_at: { type: "timestamp" },
    last_daily_digest_at: { type: "timestamp" },
    last_error: { type: "string" },
    last_result: { type: "map", not_null: true, pg_default: "'{}'::jsonb" },
    updated_at: { type: "timestamp", not_null: true, pg_default: "now()" },
  },
});
