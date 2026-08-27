/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { type FieldSpec, type PgTableConstraint, Table } from "./types";

const required = (field: FieldSpec): FieldSpec => ({
  ...field,
  not_null: true,
});
const withDefault = (field: FieldSpec, pgDefault: string): FieldSpec => ({
  ...field,
  not_null: true,
  pg_default: pgDefault,
  pg_null_backfill: pgDefault,
});
const timestamp = (desc: string): FieldSpec =>
  withDefault({ type: "timestamp", pg_type: "TIMESTAMPTZ", desc }, "now()");
const nullableTimestamp = (desc: string): FieldSpec => ({
  type: "timestamp",
  pg_type: "TIMESTAMPTZ",
  desc,
});
const version = (): FieldSpec =>
  withDefault(
    { type: "integer", desc: "Optimistic concurrency version." },
    "1",
  );
const fk = (
  name: string,
  column: string,
  table: string,
): PgTableConstraint => ({
  name,
  type: "foreign-key",
  columns: [column],
  references: { table, columns: ["id"] },
});
const json = (desc: string): FieldSpec =>
  withDefault({ type: "map", desc }, "'{}'::jsonb");

Table({
  name: "crm_outreach_templates",
  rules: {
    primary_key: "id",
    pg_constraints: [
      {
        name: "crm_outreach_templates_key_revision_key",
        type: "unique",
        columns: ["template_key", "revision"],
      },
      {
        name: "crm_outreach_templates_status_check",
        type: "check",
        expression: "status IN ('draft','active','retired')",
      },
      {
        name: "crm_outreach_templates_kind_check",
        type: "check",
        expression: "kind IN ('adoption_pilot','renewal','expansion','other')",
      },
      {
        name: "crm_outreach_templates_follow_up_policy_check",
        type: "check",
        expression: "follow_up_policy IN ('no_response','none')",
      },
    ],
    pg_custom_indexes: [
      {
        name: "crm_outreach_one_active_template_key",
        query: "(template_key) WHERE status='active'",
        unique: true,
      },
    ],
    pg_indexes: ["template_key", "kind", "status", "created_at"],
  },
  fields: {
    id: { type: "uuid", desc: "Outreach template revision id." },
    template_key: required({
      type: "string",
      desc: "Stable template selector.",
    }),
    revision: required({
      type: "integer",
      desc: "Positive immutable revision.",
    }),
    name: required({ type: "string", desc: "Human template name." }),
    kind: required({ type: "string", desc: "Constrained outreach kind." }),
    status: required({ type: "string", desc: "Draft, active, or retired." }),
    subject_template: required({
      type: "string",
      desc: "Bounded subject template.",
    }),
    body_markdown_template: required({
      type: "string",
      desc: "Bounded Markdown body template.",
    }),
    required_fields: withDefault(
      {
        type: "array",
        pg_type: "TEXT[]",
        desc: "Required allowlisted merge fields.",
      },
      "'{}'::text[]",
    ),
    follow_up_policy: required({
      type: "string",
      desc: "No-response task policy.",
    }),
    follow_up_after_days: {
      type: "integer",
      desc: "Optional follow-up interval override.",
    },
    max_followups: {
      type: "integer",
      desc: "Optional reviewed follow-up limit.",
    },
    final_review_after_days: {
      type: "integer",
      desc: "Optional final-review interval override.",
    },
    created_by_account_id: required({
      type: "uuid",
      desc: "Creating admin.",
      render: { type: "account" },
    }),
    activated_by_account_id: {
      type: "uuid",
      desc: "Activating admin.",
      render: { type: "account" },
    },
    retired_by_account_id: {
      type: "uuid",
      desc: "Retiring admin.",
      render: { type: "account" },
    },
    created_at: timestamp("Creation time."),
    activated_at: nullableTimestamp("Activation time."),
    retired_at: nullableTimestamp("Retirement time."),
  },
});

Table({
  name: "crm_outreach_batches",
  rules: {
    primary_key: "id",
    pg_sequences: ["crm_outreach_number_seq"],
    pg_constraints: [
      {
        name: "crm_outreach_batches_number_key",
        type: "unique",
        columns: ["outreach_number"],
      },
      fk(
        "crm_outreach_batches_template_fk",
        "template_id",
        "crm_outreach_templates",
      ),
      {
        name: "crm_outreach_batches_state_check",
        type: "check",
        expression:
          "state IN ('draft','approved','queued','sending','paused','complete','cancelled')",
      },
      {
        name: "crm_outreach_batches_kind_check",
        type: "check",
        expression: "kind IN ('adoption_pilot','renewal','expansion','other')",
      },
    ],
    pg_custom_indexes: [
      { name: "crm_outreach_batch_queue_idx", query: "(state,updated_at,id)" },
    ],
    pg_indexes: [
      "outreach_number",
      "state",
      "kind",
      "owner_account_id",
      "updated_at",
    ],
  },
  fields: {
    id: { type: "uuid", desc: "Outreach batch id." },
    outreach_number: required({
      type: "string",
      desc: "Stable human outreach key.",
    }),
    name: required({ type: "string", desc: "Batch name." }),
    purpose: required({ type: "string", desc: "Reviewed business purpose." }),
    kind: required({ type: "string", desc: "Constrained outreach kind." }),
    state: required({ type: "string", desc: "Batch workflow state." }),
    template_id: { type: "uuid", desc: "Optional source template revision." },
    template_snapshot: json("Immutable template revision snapshot."),
    owner_account_id: required({
      type: "uuid",
      desc: "Responsible admin.",
      render: { type: "account" },
    }),
    recipient_count: withDefault(
      { type: "integer", desc: "Current recipient count." },
      "0",
    ),
    approved_recipient_count: withDefault(
      { type: "integer", desc: "Approved recipient count." },
      "0",
    ),
    created_by_account_id: required({
      type: "uuid",
      desc: "Creating admin.",
      render: { type: "account" },
    }),
    approved_by_account_id: {
      type: "uuid",
      desc: "Approving admin.",
      render: { type: "account" },
    },
    updated_by_account_id: required({
      type: "uuid",
      desc: "Last updating admin.",
      render: { type: "account" },
    }),
    queued_at: nullableTimestamp("Queue time."),
    started_at: nullableTimestamp("First provider work time."),
    completed_at: nullableTimestamp("Completion time."),
    paused_at: nullableTimestamp("Pause time."),
    cancelled_at: nullableTimestamp("Cancellation time."),
    created_at: timestamp("Creation time."),
    updated_at: timestamp("Last update time."),
    version: version(),
  },
});

Table({
  name: "crm_outreach_deliveries",
  rules: {
    primary_key: "id",
    pg_constraints: [
      {
        name: "crm_outreach_deliveries_batch_email_key",
        type: "unique",
        columns: ["batch_id", "person_email_id"],
      },
      {
        name: "crm_outreach_deliveries_external_key",
        type: "unique",
        columns: ["provider_external_id"],
      },
      fk(
        "crm_outreach_deliveries_batch_fk",
        "batch_id",
        "crm_outreach_batches",
      ),
      fk(
        "crm_outreach_deliveries_org_fk",
        "organization_id",
        "crm_organizations",
      ),
      fk("crm_outreach_deliveries_person_fk", "person_id", "crm_people"),
      fk(
        "crm_outreach_deliveries_person_email_fk",
        "person_email_id",
        "crm_person_emails",
      ),
      fk(
        "crm_outreach_deliveries_opportunity_fk",
        "opportunity_id",
        "crm_opportunities",
      ),
      fk("crm_outreach_deliveries_task_fk", "task_id", "crm_tasks"),
      {
        name: "crm_outreach_deliveries_state_check",
        type: "check",
        expression:
          "state IN ('draft','approved','queued','creating_ticket','notification_requested','replied','closed','suppressed','failed','cancelled')",
      },
      {
        name: "crm_outreach_deliveries_suggested_action_check",
        type: "check",
        expression:
          "follow_up_suggested_action IN ('await_response','review_and_follow_up','verify_delivery','close_no_response')",
      },
    ],
    pg_custom_indexes: [
      {
        name: "crm_outreach_delivery_ticket_key",
        query: "(zendesk_ticket_id) WHERE zendesk_ticket_id IS NOT NULL",
        unique: true,
      },
      {
        name: "crm_outreach_delivery_claim_idx",
        query:
          "(state,next_attempt_at,id) WHERE state IN ('queued','creating_ticket')",
      },
      {
        name: "crm_outreach_delivery_followup_idx",
        query: "(follow_up_due_at,id) WHERE state='notification_requested'",
      },
    ],
    pg_indexes: [
      "batch_id",
      "organization_id",
      "person_id",
      "person_email_id",
      "opportunity_id",
      "task_id",
      "state",
      "recipient_domain",
      "zendesk_ticket_id",
      "updated_at",
    ],
  },
  fields: {
    id: { type: "uuid", desc: "One-recipient outreach delivery id." },
    batch_id: required({ type: "uuid", desc: "Parent batch." }),
    organization_id: required({
      type: "uuid",
      desc: "Reviewed CRM organization.",
    }),
    person_id: required({ type: "uuid", desc: "Reviewed CRM person." }),
    person_email_id: required({
      type: "uuid",
      desc: "Reviewed CRM email relation.",
    }),
    opportunity_id: { type: "uuid", desc: "Optional commercial opportunity." },
    task_id: { type: "uuid", desc: "No-response follow-up task." },
    kind: required({ type: "string", desc: "Constrained outreach kind." }),
    recipient_name: required({
      type: "string",
      desc: "Immutable recipient name.",
    }),
    normalized_email: required({
      type: "string",
      desc: "Immutable normalized recipient email.",
    }),
    recipient_domain: required({
      type: "string",
      desc: "Normalized recipient domain.",
    }),
    subject: required({ type: "string", desc: "Immutable approved subject." }),
    body_plain_text: required({
      type: "string",
      desc: "Immutable approved plain text.",
    }),
    body_markdown: required({
      type: "string",
      desc: "Immutable approved Markdown.",
    }),
    rendered_html: required({
      type: "string",
      desc: "Immutable sanitized HTML.",
    }),
    footer: required({
      type: "string",
      desc: "Immutable company and opt-out footer.",
    }),
    template_snapshot: json("Immutable template and merge-field snapshot."),
    state: required({ type: "string", desc: "Delivery workflow state." }),
    provider_external_id: required({
      type: "string",
      desc: "Deterministic Zendesk external id.",
    }),
    zendesk_ticket_id: { type: "integer", desc: "Linked Zendesk ticket." },
    opening_zendesk_comment_id: {
      type: "integer",
      pg_type: "BIGINT",
      desc: "Opening Zendesk comment.",
    },
    last_zendesk_comment_id: {
      type: "integer",
      pg_type: "BIGINT",
      desc: "Latest known Zendesk comment.",
    },
    last_zendesk_status: {
      type: "string",
      desc: "Latest bounded Zendesk status.",
    },
    zendesk_sync_metadata: json("Bounded Zendesk reconciliation metadata."),
    first_view_observed_at: nullableTimestamp(
      "First imported view observation.",
    ),
    last_view_observed_at: nullableTimestamp(
      "Latest imported view observation.",
    ),
    view_observation_count: withDefault(
      { type: "integer", desc: "View observation count." },
      "0",
    ),
    follow_up_policy: required({
      type: "string",
      desc: "Snapshotted follow-up policy.",
    }),
    follow_up_after_days: required({
      type: "integer",
      desc: "Snapshotted follow-up interval.",
    }),
    max_followups: required({
      type: "integer",
      desc: "Snapshotted follow-up limit.",
    }),
    final_review_after_days: required({
      type: "integer",
      desc: "Snapshotted final-review interval.",
    }),
    notification_requested_at: nullableTimestamp(
      "Zendesk notification request time.",
    ),
    follow_up_due_at: nullableTimestamp("No-response due time."),
    last_follow_up_at: nullableTimestamp("Latest reviewed follow-up time."),
    follow_up_attempt_count: withDefault(
      { type: "integer", desc: "Reviewed follow-up attempts." },
      "0",
    ),
    follow_up_suggested_action: withDefault(
      { type: "string", desc: "Constrained queue suggestion." },
      "'await_response'::text",
    ),
    approved_at: nullableTimestamp("Approval time."),
    queued_at: nullableTimestamp("Queue time."),
    provider_submitted_at: nullableTimestamp("Provider call start time."),
    replied_at: nullableTimestamp("First requester reply time."),
    closed_at: nullableTimestamp("Zendesk close time."),
    cancelled_at: nullableTimestamp("Cancellation time."),
    next_attempt_at: timestamp("Earliest provider attempt time."),
    attempt_count: withDefault(
      { type: "integer", desc: "Provider claim attempts." },
      "0",
    ),
    last_error: { type: "string", desc: "Bounded actionable provider error." },
    opt_out_token_digest: required({
      type: "string",
      desc: "SHA-256 digest of opaque opt-out token.",
    }),
    override_reason: {
      type: "string",
      desc: "Reviewed cooldown warning override.",
    },
    created_by_account_id: required({
      type: "uuid",
      desc: "Creating admin.",
      render: { type: "account" },
    }),
    approved_by_account_id: {
      type: "uuid",
      desc: "Approving admin.",
      render: { type: "account" },
    },
    updated_by_account_id: required({
      type: "uuid",
      desc: "Last updating admin.",
      render: { type: "account" },
    }),
    created_at: timestamp("Creation time."),
    updated_at: timestamp("Last update time."),
    version: version(),
  },
});

Table({
  name: "crm_contact_suppressions",
  rules: {
    primary_key: "id",
    pg_constraints: [
      fk(
        "crm_contact_suppressions_org_fk",
        "organization_id",
        "crm_organizations",
      ),
      fk("crm_contact_suppressions_person_fk", "person_id", "crm_people"),
      fk(
        "crm_contact_suppressions_email_fk",
        "person_email_id",
        "crm_person_emails",
      ),
      {
        name: "crm_contact_suppressions_scope_check",
        type: "check",
        expression: "scope IN ('email','person','organization','domain')",
      },
      {
        name: "crm_contact_suppressions_reason_check",
        type: "check",
        expression:
          "reason IN ('opt_out','hard_bounce','complaint','invalid_address','manual','legal','other')",
      },
      {
        name: "crm_contact_suppressions_source_check",
        type: "check",
        expression:
          "source IN ('opt_out_link','zendesk','provider','admin_ui','cli')",
      },
    ],
    pg_custom_indexes: [
      {
        name: "crm_contact_suppressions_active_scope_key",
        query: "(scope,normalized_scope_value) WHERE active",
        unique: true,
      },
    ],
    pg_indexes: [
      "scope",
      "normalized_scope_value",
      "organization_id",
      "person_id",
      "person_email_id",
      "active",
      "created_at",
    ],
  },
  fields: {
    id: { type: "uuid", desc: "Suppression record id." },
    scope: required({
      type: "string",
      desc: "Email, person, organization, or domain.",
    }),
    normalized_scope_value: required({
      type: "string",
      desc: "Normalized suppression key.",
    }),
    organization_id: { type: "uuid", desc: "Optional CRM organization." },
    person_id: { type: "uuid", desc: "Optional CRM person." },
    person_email_id: { type: "uuid", desc: "Optional CRM email relation." },
    reason: required({
      type: "string",
      desc: "Constrained suppression reason.",
    }),
    source: required({
      type: "string",
      desc: "Constrained suppression source.",
    }),
    source_reference: { type: "string", desc: "Bounded source identifier." },
    note: { type: "string", desc: "Bounded internal note." },
    active: withDefault(
      { type: "boolean", desc: "Whether suppression is active." },
      "true",
    ),
    created_by_account_id: {
      type: "uuid",
      desc: "Creating admin when applicable.",
      render: { type: "account" },
    },
    revoked_by_account_id: {
      type: "uuid",
      desc: "Revoking admin.",
      render: { type: "account" },
    },
    created_at: timestamp("Creation time."),
    revoked_at: nullableTimestamp("Revocation time."),
    revocation_reason: { type: "string", desc: "Required revocation reason." },
    version: version(),
  },
});

Table({
  name: "crm_outreach_provider_operations",
  rules: {
    primary_key: "id",
    pg_constraints: [
      {
        name: "crm_outreach_provider_operations_idempotency_key",
        type: "unique",
        columns: ["idempotency_key"],
      },
      fk(
        "crm_outreach_provider_operations_delivery_fk",
        "delivery_id",
        "crm_outreach_deliveries",
      ),
      {
        name: "crm_outreach_provider_operations_operation_check",
        type: "check",
        expression:
          "operation IN ('create_ticket','add_comment','reconcile_ticket')",
      },
      {
        name: "crm_outreach_provider_operations_state_check",
        type: "check",
        expression:
          "state IN ('queued','started','succeeded','failed','indeterminate','cancelled')",
      },
      {
        name: "crm_outreach_provider_operations_attempt_check",
        type: "check",
        expression: "attempt_number>0",
      },
    ],
    pg_custom_indexes: [
      {
        name: "crm_outreach_provider_operation_claim_idx",
        query:
          "(state,not_before,id) WHERE state IN ('queued','started','indeterminate')",
      },
      {
        name: "crm_outreach_one_pending_followup_operation",
        query:
          "(delivery_id) WHERE operation='add_comment' AND state IN ('queued','started','indeterminate')",
        unique: true,
      },
    ],
    pg_indexes: [
      "delivery_id",
      "operation",
      "state",
      "provider_external_id",
      "zendesk_ticket_id",
      "updated_at",
    ],
  },
  fields: {
    id: { type: "uuid", desc: "Durable provider operation id." },
    delivery_id: required({ type: "uuid", desc: "Outreach delivery." }),
    operation: required({
      type: "string",
      desc: "Constrained provider effect.",
    }),
    idempotency_key: required({
      type: "string",
      desc: "Stable operation idempotency key.",
    }),
    payload_hash: required({
      type: "string",
      desc: "Canonical request digest.",
    }),
    state: required({ type: "string", desc: "Provider operation state." }),
    attempt_number: required({
      type: "integer",
      desc: "Positive attempt number.",
    }),
    provider_external_id: required({
      type: "string",
      desc: "Deterministic provider correlation id.",
    }),
    zendesk_ticket_id: { type: "integer", desc: "Provider ticket result." },
    rate_limit_snapshot: json("Effective limits used for this claim."),
    request_payload: json(
      "Bounded immutable provider request needed for asynchronous execution.",
    ),
    lease_owner: { type: "string", desc: "Claiming worker." },
    lease_expires_at: nullableTimestamp("Claim lease expiry."),
    not_before: timestamp("Earliest attempt time."),
    provider_status: { type: "string", desc: "Bounded provider status." },
    error_category: { type: "string", desc: "Stable error category." },
    error_text: { type: "string", desc: "Bounded actionable error." },
    created_at: timestamp("Creation time."),
    started_at: nullableTimestamp("Provider call start time."),
    finished_at: nullableTimestamp("Provider result time."),
    updated_at: timestamp("Last update time."),
  },
});

Table({
  name: "crm_outreach_zendesk_events",
  rules: {
    primary_key: "event_id",
    pg_constraints: [
      {
        name: "crm_outreach_zendesk_events_state_check",
        type: "check",
        expression:
          "state IN ('pending','processing','processed','ignored','failed','dead_letter')",
      },
      {
        name: "crm_outreach_zendesk_events_attempt_check",
        type: "check",
        expression: "attempt_count>=0",
      },
    ],
    pg_indexes: [
      "zendesk_ticket_id",
      "event_type",
      "state",
      "next_attempt_at",
      "received_at",
    ],
  },
  fields: {
    event_id: required({
      type: "string",
      desc: "Immutable Zendesk event identifier.",
    }),
    zendesk_ticket_id: required({ type: "integer", desc: "Zendesk ticket." }),
    zendesk_comment_id: {
      type: "integer",
      pg_type: "BIGINT",
      desc: "Optional Zendesk comment.",
    },
    event_type: required({ type: "string", desc: "Bounded event type." }),
    occurred_at: required({
      type: "timestamp",
      pg_type: "TIMESTAMPTZ",
      desc: "Provider event time.",
    }),
    payload: json("Minimal bounded event payload."),
    state: withDefault(
      {
        type: "string",
        desc: "Pending, processing, processed, ignored, failed, or dead letter.",
      },
      "'pending'::text",
    ),
    attempt_count: withDefault(
      { type: "integer", desc: "Processing attempts." },
      "0",
    ),
    next_attempt_at: timestamp("Earliest processing attempt."),
    last_error: { type: "string", desc: "Bounded processing error." },
    received_at: timestamp("Webhook receipt time."),
    processed_at: nullableTimestamp("Terminal processing time."),
    dead_lettered_at: nullableTimestamp("Dead-letter time."),
    updated_at: timestamp("Last update time."),
  },
});

Table({
  name: "crm_outreach_engagement_events",
  rules: {
    primary_key: "id",
    pg_constraints: [
      {
        name: "crm_outreach_engagement_provider_event_key",
        type: "unique",
        columns: ["provider", "provider_event_id"],
      },
      fk(
        "crm_outreach_engagement_delivery_fk",
        "delivery_id",
        "crm_outreach_deliveries",
      ),
      {
        name: "crm_outreach_engagement_kind_check",
        type: "check",
        expression: "kind='view_observed'",
      },
      {
        name: "crm_outreach_engagement_provider_check",
        type: "check",
        expression: "provider='my_read_receipts'",
      },
    ],
    pg_indexes: [
      "delivery_id",
      "zendesk_ticket_id",
      "zendesk_comment_id",
      "observed_at",
    ],
  },
  fields: {
    id: { type: "uuid", desc: "Immutable engagement event id." },
    delivery_id: required({
      type: "uuid",
      desc: "Correlated outreach delivery.",
    }),
    kind: required({ type: "string", desc: "View observed." }),
    provider: required({ type: "string", desc: "My Read Receipts." }),
    provider_event_id: required({
      type: "string",
      desc: "Stable provider event key or digest.",
    }),
    zendesk_ticket_id: required({
      type: "integer",
      desc: "Correlated ticket.",
    }),
    zendesk_comment_id: required({
      type: "integer",
      pg_type: "BIGINT",
      desc: "Exact outbound comment.",
    }),
    observed_at: required({
      type: "timestamp",
      pg_type: "TIMESTAMPTZ",
      desc: "Observed time.",
    }),
    ingested_at: timestamp("CRM ingestion time."),
    provenance: json("Bounded parser provenance without tracking details."),
  },
});

Table({
  name: "crm_outreach_worker_state",
  rules: { primary_key: "provider", pg_indexes: ["not_before", "updated_at"] },
  fields: {
    provider: required({ type: "string", desc: "Provider or worker key." }),
    not_before: nullableTimestamp("Durable provider-wide backoff."),
    reconciliation_cursor: {
      type: "string",
      desc: "Bounded reconciliation cursor.",
    },
    lease_owner: { type: "string", desc: "Current maintenance worker." },
    lease_expires_at: nullableTimestamp("Worker lease expiry."),
    heartbeat_at: nullableTimestamp("Latest worker heartbeat."),
    last_success_at: nullableTimestamp("Latest successful cycle."),
    last_error: { type: "string", desc: "Bounded worker error." },
    last_result: json("Bounded latest cycle result."),
    updated_at: timestamp("Last update time."),
  },
});
