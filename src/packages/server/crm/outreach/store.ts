/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createHash, createHmac, randomUUID } from "node:crypto";

import type {
  CrmContactSuppressionListRequest,
  CrmContactSuppressionListResponse,
  CrmContactSuppressionMutationRequest,
  CrmOutreachBatchCreateRequest,
  CrmOutreachBatchGetRequest,
  CrmOutreachBatchListRequest,
  CrmOutreachBatchListResponse,
  CrmOutreachBatchTransitionRequest,
  CrmOutreachBatchUpdateRequest,
  CrmOutreachDeliveryActionRequest,
  CrmOutreachDeliveryGetRequest,
  CrmOutreachDeliveryListRequest,
  CrmOutreachDeliveryListResponse,
  CrmOutreachDiagnosticsRequest,
  CrmOutreachEngagementListRequest,
  CrmOutreachEngagementListResponse,
  CrmOutreachFollowUpListRequest,
  CrmOutreachFollowUpListResponse,
  CrmOutreachFollowUpPreview,
  CrmOutreachFollowUpPreviewRequest,
  CrmOutreachFollowUpSendRequest,
  CrmOutreachLimitsRequest,
  CrmOutreachPreview,
  CrmOutreachPreviewRequest,
  CrmOutreachProviderOperationListRequest,
  CrmOutreachProviderOperationListResponse,
  CrmOutreachRecipientRemoveRequest,
  CrmOutreachRecipientRequest,
  CrmOutreachSyncRequest,
  CrmOutreachTemplateCreateRequest,
  CrmOutreachTemplateGetRequest,
  CrmOutreachTemplateListRequest,
  CrmOutreachTemplateListResponse,
  CrmOutreachTemplateTransitionRequest,
} from "@cocalc/conat/hub/api/crm";
import getPool, { type PoolClient } from "@cocalc/database/pool";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import siteURL from "@cocalc/database/settings/site-url";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterSeedBayId } from "@cocalc/server/cluster-config";
import type { CrmMutationResult, CrmTask } from "@cocalc/util/crm";
import {
  CRM_OUTREACH_BATCH_STATES,
  CRM_OUTREACH_DELIVERY_STATES,
  CRM_OUTREACH_FOLLOW_UP_POLICIES,
  CRM_OUTREACH_KINDS,
  CRM_OUTREACH_SUPPRESSION_REASONS,
  CRM_OUTREACH_SUPPRESSION_SCOPES,
  CRM_OUTREACH_TEMPLATE_STATES,
  CRM_OUTREACH_VIEW_CAVEAT,
  type CrmContactSuppression,
  type CrmOutreachBatch,
  type CrmOutreachBatchDetail,
  type CrmOutreachDelivery,
  type CrmOutreachDiagnostics,
  type CrmOutreachEngagementEvent,
  type CrmOutreachLimits,
  type CrmOutreachProviderOperation,
  type CrmOutreachTemplate,
} from "@cocalc/util/crm-outreach";
import { isValidUUID } from "@cocalc/util/misc";
import MarkdownIt from "markdown-it";
import {
  recordOutreachSuppression,
  updateOutreachQueueMetrics,
} from "./observability";

type Db = PoolClient | ReturnType<typeof getPool>;
type Json = Record<string, unknown>;

const MAX_LIST = 500;
const MAX_BODY = 50_000;
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });

export const OUTREACH_HARD_BOUNDS = {
  max_recipients_per_batch: { min: 1, max: 500, fallback: 25 },
  send_per_minute: { min: 1, max: 60, fallback: 5 },
  send_per_hour: { min: 1, max: 1_000, fallback: 50 },
  send_per_day: { min: 1, max: 5_000, fallback: 200 },
  send_per_domain_per_day: { min: 1, max: 500, fallback: 20 },
  contact_cooldown_days: { min: 1, max: 730, fallback: 90 },
  default_followup_days: { min: 1, max: 90, fallback: 7 },
  default_max_followups: { min: 1, max: 5, fallback: 2 },
  default_final_review_days: { min: 1, max: 90, fallback: 14 },
  worker_concurrency: { min: 1, max: 10, fallback: 1 },
  worker_batch_size: { min: 1, max: 100, fallback: 10 },
  retry_max_attempts: { min: 1, max: 20, fallback: 8 },
  retry_base_seconds: { min: 10, max: 3_600, fallback: 60 },
} as const;

const ALLOWED_MERGE_FIELDS = new Set([
  "person.display_name",
  "person.first_name",
  "person.email",
  "organization.display_name",
  "organization.customer_number",
  "opportunity.name",
  "opportunity.kind",
  "opportunity.expected_value",
  "opportunity.currency",
  "opportunity.service_starts_at",
  "opportunity.service_ends_at",
  "relationship_owner.display_name",
]);

export function missingRequiredMergeFields(
  requiredFields: string[],
  context: Record<string, string>,
): string[] {
  return requiredFields.filter((field) => !`${context[field] ?? ""}`.trim());
}

export function canQueueOutreachBatch(
  contentReady: boolean,
  state: string,
): boolean {
  return contentReady && state === "approved";
}

export function outreachProviderConfigurationErrors(config: {
  support_address?: string;
  submitter_id?: string;
  group_id?: string;
  postal_address?: string;
  footer_markdown?: string;
  webhook_secret?: string;
}): string[] {
  return [
    !config.support_address &&
      "shared Zendesk support address is not configured",
    !config.submitter_id && "Zendesk submitter ID is not configured",
    !config.group_id && "Zendesk group ID is not configured",
    !config.postal_address && "company postal address is not configured",
    !config.footer_markdown && "reviewed outreach footer is not configured",
    !config.webhook_secret && "webhook/opt-out secret is not configured",
  ].filter((value): value is string => !!value);
}

export function requireOutreachOptOutSecret(secret?: string): string {
  const value = `${secret ?? ""}`.trim();
  if (!value) {
    throw Error(
      "webhook/opt-out secret must be configured before adding outreach recipients",
    );
  }
  return value;
}

function assertSeed(): void {
  if (getConfiguredBayId() !== getConfiguredClusterSeedBayId()) {
    throw Error("CRM outreach is seed-global and must run on seed authority");
  }
}

function reason(value: unknown): string {
  const text = `${value ?? ""}`.trim();
  if (text.length < 4) throw Error("a human-readable audit reason is required");
  if (text.length > 2_000)
    throw Error("audit reason must be at most 2000 characters");
  return text;
}

function actor(value: unknown): string {
  const text = `${value ?? ""}`.trim();
  if (!isValidUUID(text)) throw Error("account_id must be a UUID");
  return text;
}

function bounded(value: unknown, name: string, max: number): string {
  const text = `${value ?? ""}`.trim();
  if (!text) throw Error(`${name} is required`);
  if (text.length > max)
    throw Error(`${name} must be at most ${max} characters`);
  return text;
}

function optionalBounded(
  value: unknown,
  name: string,
  max: number,
): string | null {
  const text = `${value ?? ""}`.trim();
  if (!text) return null;
  if (text.length > max)
    throw Error(`${name} must be at most ${max} characters`);
  return text;
}

function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
  name: string,
): T {
  if (!values.includes(value as T))
    throw Error(`${name} must be one of: ${values.join(", ")}`);
  return value as T;
}

function positiveInteger(
  value: unknown,
  name: string,
  min: number,
  max: number,
): number {
  const result = Number(value);
  if (!Number.isInteger(result) || result < min || result > max) {
    throw Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return result;
}

function limit(value: unknown): number {
  return Math.min(
    positiveInteger(value ?? 100, "limit", 1, MAX_LIST),
    MAX_LIST,
  );
}

function iso(value: unknown): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(`${value}`);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
}

function isoRequired(value: unknown): string {
  const result = iso(value);
  if (!result) throw Error("invalid timestamp");
  return result;
}

export function decodeZendeskId(
  value: unknown,
  name: string,
  required = false,
): number | null | undefined {
  if (value == null) {
    if (required) throw Error(`${name} must be a positive safe integer`);
    return value as null | undefined;
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw Error(`${name} must be a positive safe integer`);
  }
  return result;
}

function normalizeEmail(value: unknown): string {
  const email = bounded(value, "email", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw Error("email must be valid");
  return email;
}

function normalizeDomain(value: unknown): string {
  const domain = bounded(value, "domain", 253).toLowerCase().replace(/^@/, "");
  if (
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)
  ) {
    throw Error("domain must be valid");
  }
  return domain;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Json)
        .filter(
          ([key]) =>
            !["account_id", "browser_id", "session_hash", "commit"].includes(
              key,
            ),
        )
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stable(child)]),
    );
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}

function timestampFields<T extends Json>(row: T, fields: string[]): T {
  const result = { ...row };
  for (const field of fields) {
    if (Object.hasOwn(result, field))
      (result as Json)[field] = iso((result as Json)[field]);
  }
  return result;
}

function recordRow(row: unknown, name: string): Json {
  if (row == null || typeof row !== "object" || Array.isArray(row)) {
    throw Error(`${name} must be a decoded database record`);
  }
  return row as Json;
}

function templateRow(row: any): CrmOutreachTemplate {
  row = recordRow(row, "CRM outreach template row");
  return timestampFields(
    { ...row, required_fields: row.required_fields ?? [] },
    ["created_at", "activated_at", "retired_at"],
  ) as CrmOutreachTemplate;
}

export function batchRow(row: any): CrmOutreachBatch {
  row = recordRow(row, "CRM outreach batch row");
  return timestampFields(
    { ...row, template_snapshot: row.template_snapshot ?? {} },
    [
      "queued_at",
      "started_at",
      "completed_at",
      "paused_at",
      "cancelled_at",
      "created_at",
      "updated_at",
    ],
  ) as CrmOutreachBatch;
}

export function deliveryRow(row: any): CrmOutreachDelivery {
  row = recordRow(row, "CRM outreach delivery row");
  return timestampFields(
    {
      ...row,
      template_snapshot: row.template_snapshot ?? {},
      zendesk_sync_metadata: row.zendesk_sync_metadata ?? {},
      opening_zendesk_comment_id: decodeZendeskId(
        row.opening_zendesk_comment_id,
        "opening_zendesk_comment_id",
      ),
      last_zendesk_comment_id: decodeZendeskId(
        row.last_zendesk_comment_id,
        "last_zendesk_comment_id",
      ),
    },
    [
      "first_view_observed_at",
      "last_view_observed_at",
      "notification_requested_at",
      "follow_up_due_at",
      "last_follow_up_at",
      "approved_at",
      "queued_at",
      "provider_submitted_at",
      "replied_at",
      "closed_at",
      "cancelled_at",
      "next_attempt_at",
      "created_at",
      "updated_at",
    ],
  ) as CrmOutreachDelivery;
}

export interface OutreachFollowupEligibility {
  delivery_state: string;
  replied_at?: Date | string | null;
  task_state?: string | null;
  follow_up_attempt_count: number;
  max_followups: number;
  suppressed: boolean;
  pending_operation?: boolean;
  provider_attempt_number?: number;
  provider_retry_max_attempts?: number;
}

export function outreachFollowupIneligibilityReason({
  delivery_state,
  replied_at,
  task_state,
  follow_up_attempt_count,
  max_followups,
  suppressed,
  pending_operation = false,
  provider_attempt_number,
  provider_retry_max_attempts,
}: OutreachFollowupEligibility): string | undefined {
  if (suppressed) return "recipient is suppressed";
  if (replied_at) return "recipient has already replied";
  if (delivery_state !== "notification_requested") {
    return `delivery state is ${delivery_state}, not notification_requested`;
  }
  if (task_state !== "open" && task_state !== "waiting") {
    return "follow-up task is no longer open or waiting";
  }
  if (follow_up_attempt_count >= max_followups) {
    return "maximum reviewed follow-ups reached";
  }
  if (
    provider_attempt_number != null &&
    provider_retry_max_attempts != null &&
    provider_attempt_number > provider_retry_max_attempts
  ) {
    return "maximum provider attempts reached";
  }
  if (pending_operation) return "a reviewed follow-up is already pending";
  return undefined;
}

function suppressionRow(row: any): CrmContactSuppression {
  return timestampFields(row, [
    "created_at",
    "revoked_at",
  ]) as CrmContactSuppression;
}

function engagementRow(row: any): CrmOutreachEngagementEvent {
  return timestampFields(
    {
      ...row,
      zendesk_comment_id: decodeZendeskId(
        row.zendesk_comment_id,
        "zendesk_comment_id",
        true,
      ),
      provenance: row.provenance ?? {},
    },
    ["observed_at", "ingested_at"],
  ) as CrmOutreachEngagementEvent;
}

function providerOperationRow(row: any): CrmOutreachProviderOperation {
  return timestampFields(
    {
      ...row,
      rate_limit_snapshot: row.rate_limit_snapshot ?? {},
      request_payload: row.request_payload ?? {},
    },
    [
      "lease_expires_at",
      "not_before",
      "created_at",
      "started_at",
      "finished_at",
      "updated_at",
    ],
  ) as CrmOutreachProviderOperation;
}

function taskRow(row: any): CrmTask {
  return timestampFields(row, [
    "due_at",
    "created_at",
    "updated_at",
    "completed_at",
    "cancelled_at",
  ]) as CrmTask;
}

async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

interface MutationOptions<T> {
  action: string;
  actor: string;
  reason: string;
  commit?: boolean;
  expectedVersion?: number;
  idempotencyKey?: string;
  defaultIdempotencyKey?: string;
  organizationId?: string | null;
  proposed: Json;
  idempotencyPayload?: Json;
  warnings?: string[];
  currentVersion: (db: Db) => Promise<number>;
  validate?: (db: Db) => Promise<void>;
  apply: (client: PoolClient, eventId: string) => Promise<T>;
  resultType: string;
}

async function mutate<T>(
  opts: MutationOptions<T>,
): Promise<CrmMutationResult<T>> {
  assertSeed();
  const auditReason = reason(opts.reason);
  const accountId = actor(opts.actor);
  const payloadHash = digest({
    action: opts.action,
    proposed: opts.idempotencyPayload ?? opts.proposed,
  });
  const key =
    `${opts.idempotencyKey ?? opts.defaultIdempotencyKey ?? `crm:${opts.action}:${payloadHash.slice(0, 24)}`}`.slice(
      0,
      500,
    );
  if (!opts.commit) {
    const expectedVersion = await opts.currentVersion(getPool());
    await opts.validate?.(getPool());
    return {
      preview: true,
      action: opts.action,
      expected_version: expectedVersion,
      proposed: opts.proposed,
      warnings: opts.warnings ?? [],
      idempotency_key: key,
    };
  }
  if (!Number.isInteger(opts.expectedVersion))
    throw Error("expected_version is required for a committed CRM mutation");
  if (!opts.idempotencyKey?.trim())
    throw Error("idempotency_key is required for a committed CRM mutation");
  return await transaction(async (client) => {
    const replay = await client.query(
      `SELECT payload_hash,metadata FROM crm_mutation_events
        WHERE actor_account_id=$1 AND action=$2 AND idempotency_key=$3`,
      [accountId, opts.action, key],
    );
    if (replay.rows[0]) {
      if (replay.rows[0].payload_hash !== payloadHash) {
        throw Object.assign(
          Error(
            "idempotency key was already used with a different CRM outreach mutation",
          ),
          { code: 409 },
        );
      }
      return {
        preview: false,
        action: opts.action,
        replayed: true,
        result: replay.rows[0].metadata.result as T,
      };
    }
    const version = await opts.currentVersion(client);
    if (version !== opts.expectedVersion) {
      throw Object.assign(
        Error(
          `CRM outreach record changed: expected version ${opts.expectedVersion}, current version is ${version}`,
        ),
        {
          code: 409,
          expected_version: opts.expectedVersion,
          current_version: version,
        },
      );
    }
    await opts.validate?.(client);
    const eventId = randomUUID();
    const result = await opts.apply(client, eventId);
    const metadata = { result };
    if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > 1_000_000) {
      throw Error("CRM outreach mutation result is too large to audit safely");
    }
    await client.query(
      `INSERT INTO crm_mutation_events
       (id,organization_id,actor_account_id,action,reason,idempotency_key,payload_hash,result_type,result_id,metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        eventId,
        opts.organizationId ?? null,
        accountId,
        opts.action,
        auditReason,
        key,
        payloadHash,
        opts.resultType,
        (result as any)?.id ?? null,
        metadata,
      ],
    );
    return { preview: false, action: opts.action, replayed: false, result };
  });
}

async function resolveOrganization(db: Db, selector: string): Promise<any> {
  const value = bounded(selector, "organization", 500);
  const { rows } = await db.query(
    `SELECT * FROM crm_organizations
      WHERE id::text=$1 OR lower(customer_number)=lower($1) OR lower(display_name)=lower($1)
      ORDER BY status='active' DESC LIMIT 2`,
    [value],
  );
  if (rows.length !== 1)
    throw Error(
      rows.length
        ? "organization selector is ambiguous"
        : `organization not found: ${value}`,
    );
  return rows[0];
}

async function resolvePerson(db: Db, selector: string): Promise<any> {
  const value = bounded(selector, "person", 500);
  const normalized = value.toLowerCase();
  const { rows } = await db.query(
    `SELECT p.* FROM crm_people p
      WHERE p.id::text=$1 OR lower(p.display_name)=lower($1)
         OR EXISTS (
           SELECT 1 FROM crm_person_emails e
            WHERE e.person_id=p.id AND e.normalized_email=$2
         )
      ORDER BY p.status='active' DESC LIMIT 2`,
    [value, normalized],
  );
  if (rows.length !== 1)
    throw Error(
      rows.length
        ? "person selector is ambiguous"
        : `person not found: ${value}`,
    );
  return rows[0];
}

async function resolveOpportunity(db: Db, selector: string): Promise<any> {
  const value = bounded(selector, "opportunity", 500);
  const { rows } = await db.query(
    "SELECT * FROM crm_opportunities WHERE id::text=$1 OR lower(name)=lower($1) ORDER BY updated_at DESC LIMIT 2",
    [value],
  );
  if (rows.length !== 1)
    throw Error(
      rows.length
        ? "opportunity selector is ambiguous"
        : `opportunity not found: ${value}`,
    );
  return rows[0];
}

async function resolveTemplate(
  db: Db,
  selector: string,
  lock = false,
): Promise<CrmOutreachTemplate> {
  const value = bounded(selector, "template", 500);
  const match = /^(.*)@(\d+)$/.exec(value);
  const params: unknown[] = [match?.[1] ?? value];
  let where = "id::text=$1 OR template_key=$1";
  if (match) {
    params.push(Number(match[2]));
    where = "template_key=$1 AND revision=$2";
  }
  const { rows } = await db.query(
    `SELECT * FROM crm_outreach_templates WHERE ${where}
      ORDER BY status='active' DESC,revision DESC LIMIT 2${lock ? " FOR UPDATE" : ""}`,
    params,
  );
  if (!rows.length) throw Error(`outreach template not found: ${value}`);
  if (
    !match &&
    !isValidUUID(value) &&
    rows.length > 1 &&
    rows[0].status !== "active"
  ) {
    throw Error("template selector is ambiguous; specify key@revision");
  }
  return templateRow(rows[0]);
}

async function resolveBatch(
  db: Db,
  selector: string,
  lock = false,
): Promise<CrmOutreachBatch> {
  const value = bounded(selector, "batch", 500);
  const { rows } = await db.query(
    `SELECT * FROM crm_outreach_batches WHERE id::text=$1 OR lower(outreach_number)=lower($1)
      LIMIT 2${lock ? " FOR UPDATE" : ""}`,
    [value],
  );
  if (rows.length !== 1)
    throw Error(
      rows.length
        ? "batch selector is ambiguous"
        : `outreach batch not found: ${value}`,
    );
  return batchRow(rows[0]);
}

async function resolveDelivery(
  db: Db,
  selector: string,
  lock = false,
): Promise<CrmOutreachDelivery> {
  const value = bounded(selector, "delivery", 500);
  const ticket = /^\d+$/.test(value) ? Number(value) : null;
  const { rows } = await db.query(
    `SELECT * FROM crm_outreach_deliveries
      WHERE id::text=$1 OR provider_external_id=$1 OR ($2::integer IS NOT NULL AND zendesk_ticket_id=$2)
      LIMIT 2${lock ? " FOR UPDATE" : ""}`,
    [value, ticket],
  );
  if (rows.length !== 1)
    throw Error(
      rows.length
        ? "delivery selector is ambiguous"
        : `outreach delivery not found: ${value}`,
    );
  return deliveryRow(rows[0]);
}

export async function addActivity(
  db: Db,
  input: {
    organization_id: string;
    person_id?: string | null;
    opportunity_id?: string | null;
    task_id?: string | null;
    zendesk_ticket_id?: number | null;
    kind?: string;
    source_id: string;
    summary: string;
    details?: string | null;
    actor_account_id?: string | null;
    metadata?: Json;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO crm_activities
      (id,organization_id,person_id,opportunity_id,task_id,zendesk_ticket_id,kind,source,source_id,summary,details,actor_account_id,occurred_at,metadata)
     VALUES($1,$2,$3,$4,$5,$6,$7,'crm-outreach',$8,$9,$10,$11,NOW(),$12)
     ON CONFLICT (organization_id,source,source_id) DO NOTHING`,
    [
      randomUUID(),
      input.organization_id,
      input.person_id ?? null,
      input.opportunity_id ?? null,
      input.task_id ?? null,
      input.zendesk_ticket_id ?? null,
      input.kind ?? "system",
      input.source_id,
      bounded(input.summary, "activity summary", 1_000),
      optionalBounded(input.details, "activity details", 10_000),
      input.actor_account_id ?? null,
      input.metadata ?? {},
    ],
  );
}

function clampSetting(
  settings: any,
  key: keyof typeof OUTREACH_HARD_BOUNDS,
): number {
  const spec = OUTREACH_HARD_BOUNDS[key];
  const value = Number(settings[`crm_outreach_${key}`] ?? spec.fallback);
  return Number.isInteger(value)
    ? Math.min(spec.max, Math.max(spec.min, value))
    : spec.fallback;
}

export async function loadOutreachConfiguration(): Promise<any> {
  const settings = await getServerSettings();
  return {
    enabled: settings.crm_outreach_enabled === true,
    mutations_enabled: settings.crm_outreach_mutations_enabled === true,
    delivery_enabled: settings.crm_outreach_delivery_enabled === true,
    webhook_enabled: settings.crm_outreach_webhook_enabled === true,
    max_recipients_per_batch: clampSetting(
      settings,
      "max_recipients_per_batch",
    ),
    send_per_minute: clampSetting(settings, "send_per_minute"),
    send_per_hour: clampSetting(settings, "send_per_hour"),
    send_per_day: clampSetting(settings, "send_per_day"),
    send_per_domain_per_day: clampSetting(settings, "send_per_domain_per_day"),
    contact_cooldown_days: clampSetting(settings, "contact_cooldown_days"),
    default_followup_days: clampSetting(settings, "default_followup_days"),
    default_max_followups: clampSetting(settings, "default_max_followups"),
    default_final_review_days: clampSetting(
      settings,
      "default_final_review_days",
    ),
    worker_concurrency: clampSetting(settings, "worker_concurrency"),
    worker_batch_size: clampSetting(settings, "worker_batch_size"),
    retry_max_attempts: clampSetting(settings, "retry_max_attempts"),
    retry_base_seconds: clampSetting(settings, "retry_base_seconds"),
    submitter_id: `${settings.crm_outreach_zendesk_submitter_id ?? ""}`.trim(),
    group_id: `${settings.crm_outreach_zendesk_group_id ?? ""}`.trim(),
    form_id: `${settings.crm_outreach_zendesk_form_id ?? ""}`.trim(),
    support_address:
      `${settings.crm_outreach_zendesk_support_address ?? ""}`.trim(),
    postal_address:
      `${settings.crm_outreach_company_postal_address ?? ""}`.trim(),
    footer_markdown: `${settings.crm_outreach_footer_markdown ?? ""}`.trim(),
    webhook_secret:
      `${settings.crm_outreach_zendesk_webhook_secret ?? ""}`.trim(),
    read_receipts_enabled: settings.crm_outreach_read_receipts_enabled === true,
    read_receipts_mode: `${settings.crm_outreach_read_receipts_mode ?? "ticket_fields"}`,
    read_receipts_ticket_field_ids: `${settings.crm_outreach_read_receipts_ticket_field_ids ?? ""}`,
    read_receipts_integration_id: `${settings.crm_outreach_read_receipts_integration_id ?? ""}`,
    site_url: `${await siteURL()}`.replace(/\/$/, ""),
  };
}

export async function getOutreachLimits(
  opts: CrmOutreachLimitsRequest,
): Promise<CrmOutreachLimits> {
  assertSeed();
  reason(opts.reason);
  const config = await loadOutreachConfiguration();
  const domain = opts.domain ? normalizeDomain(opts.domain) : null;
  const usage = await getPool().query(
    `SELECT
       count(*) FILTER (WHERE started_at >= NOW()-INTERVAL '1 minute')::int AS minute,
       count(*) FILTER (WHERE started_at >= NOW()-INTERVAL '1 hour')::int AS hour,
       count(*) FILTER (WHERE started_at >= NOW()-INTERVAL '24 hours')::int AS day,
       count(*) FILTER (WHERE started_at >= NOW()-INTERVAL '24 hours' AND d.recipient_domain=$1)::int AS domain
     FROM crm_outreach_provider_operations p
     JOIN crm_outreach_deliveries d ON d.id=p.delivery_id
     WHERE p.started_at IS NOT NULL AND p.state<>'cancelled'`,
    [domain],
  );
  const worker = await getPool().query(
    "SELECT not_before FROM crm_outreach_worker_state WHERE provider='zendesk'",
  );
  const providerNotBefore = iso(worker.rows[0]?.not_before);
  return {
    enabled: config.enabled,
    mutations_enabled: config.mutations_enabled,
    delivery_enabled: config.delivery_enabled,
    webhook_enabled: config.webhook_enabled,
    max_recipients_per_batch: config.max_recipients_per_batch,
    send_per_minute: config.send_per_minute,
    send_per_hour: config.send_per_hour,
    send_per_day: config.send_per_day,
    send_per_domain_per_day: config.send_per_domain_per_day,
    contact_cooldown_days: config.contact_cooldown_days,
    default_followup_days: config.default_followup_days,
    default_max_followups: config.default_max_followups,
    default_final_review_days: config.default_final_review_days,
    worker_concurrency: config.worker_concurrency,
    worker_batch_size: config.worker_batch_size,
    retry_max_attempts: config.retry_max_attempts,
    retry_base_seconds: config.retry_base_seconds,
    rolling_usage: {
      minute: usage.rows[0]?.minute ?? 0,
      hour: usage.rows[0]?.hour ?? 0,
      day: usage.rows[0]?.day ?? 0,
      by_domain: domain ? { [domain]: usage.rows[0]?.domain ?? 0 } : {},
    },
    provider_not_before: providerNotBefore,
    next_eligible_send_at:
      providerNotBefore && new Date(providerNotBefore) > new Date()
        ? providerNotBefore
        : null,
    hard_bounds: Object.fromEntries(
      Object.entries(OUTREACH_HARD_BOUNDS).map(([key, value]) => [
        key,
        { min: value.min, max: value.max },
      ]),
    ),
  };
}

export async function listOutreachTemplates(
  opts: CrmOutreachTemplateListRequest,
): Promise<CrmOutreachTemplateListResponse> {
  assertSeed();
  reason(opts.reason);
  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.template_key) {
    params.push(opts.template_key);
    where.push(`template_key=$${params.length}`);
  }
  if (opts.kind) {
    params.push(enumValue(opts.kind, CRM_OUTREACH_KINDS, "kind"));
    where.push(`kind=$${params.length}`);
  }
  if (opts.status) {
    params.push(enumValue(opts.status, CRM_OUTREACH_TEMPLATE_STATES, "status"));
    where.push(`status=$${params.length}`);
  }
  params.push(limit(opts.limit));
  const { rows } = await getPool().query(
    `SELECT * FROM crm_outreach_templates ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY template_key,revision DESC LIMIT $${params.length}`,
    params,
  );
  return {
    templates: rows.map(templateRow),
    truncated: rows.length === params.at(-1),
  };
}

export async function getOutreachTemplate(
  opts: CrmOutreachTemplateGetRequest,
): Promise<CrmOutreachTemplate> {
  assertSeed();
  reason(opts.reason);
  return await resolveTemplate(getPool(), opts.template);
}

export async function createOutreachTemplate(
  opts: CrmOutreachTemplateCreateRequest,
): Promise<CrmMutationResult<CrmOutreachTemplate>> {
  assertSeed();
  reason(opts.reason);
  const accountId = actor(opts.account_id);
  const templateKey = bounded(
    opts.template_key,
    "template_key",
    100,
  ).toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(templateKey))
    throw Error("template_key must be lower-case words separated by hyphens");
  const maxRevision = async (db: Db) =>
    Number(
      (
        await db.query(
          "SELECT COALESCE(max(revision),0)::int AS revision FROM crm_outreach_templates WHERE template_key=$1",
          [templateKey],
        )
      ).rows[0].revision,
    );
  const revision =
    (opts.commit && Number.isInteger(opts.expected_version)
      ? opts.expected_version!
      : await maxRevision(getPool())) + 1;
  const requiredFields = [...new Set(opts.required_fields ?? [])];
  for (const field of requiredFields)
    if (!ALLOWED_MERGE_FIELDS.has(field))
      throw Error(`unsupported required merge field: ${field}`);
  validateTemplate(opts.subject_template, "subject_template", 500);
  validateTemplate(
    opts.body_markdown_template,
    "body_markdown_template",
    MAX_BODY,
  );
  const proposed = {
    template_key: templateKey,
    revision,
    name: bounded(opts.name, "name", 200),
    kind: enumValue(opts.kind, CRM_OUTREACH_KINDS, "kind"),
    subject_template: bounded(opts.subject_template, "subject_template", 500),
    body_markdown_template: bounded(
      opts.body_markdown_template,
      "body_markdown_template",
      MAX_BODY,
    ),
    required_fields: requiredFields,
    follow_up_policy: enumValue(
      opts.follow_up_policy ?? "no_response",
      CRM_OUTREACH_FOLLOW_UP_POLICIES,
      "follow_up_policy",
    ),
    follow_up_after_days:
      opts.follow_up_after_days == null
        ? null
        : positiveInteger(
            opts.follow_up_after_days,
            "follow_up_after_days",
            1,
            90,
          ),
    max_followups:
      opts.max_followups == null
        ? null
        : positiveInteger(opts.max_followups, "max_followups", 1, 5),
    final_review_after_days:
      opts.final_review_after_days == null
        ? null
        : positiveInteger(
            opts.final_review_after_days,
            "final_review_after_days",
            1,
            90,
          ),
  };
  return await mutate({
    action: "outreach.template.create",
    actor: accountId,
    reason: opts.reason,
    commit: opts.commit,
    expectedVersion: opts.expected_version,
    idempotencyKey: opts.idempotency_key,
    proposed,
    resultType: "outreach_template",
    currentVersion: maxRevision,
    apply: async (db) => {
      const id = randomUUID();
      const { rows } = await db.query(
        `INSERT INTO crm_outreach_templates
          (id,template_key,revision,name,kind,status,subject_template,body_markdown_template,required_fields,
           follow_up_policy,follow_up_after_days,max_followups,final_review_after_days,created_by_account_id)
         VALUES($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [
          id,
          proposed.template_key,
          proposed.revision,
          proposed.name,
          proposed.kind,
          proposed.subject_template,
          proposed.body_markdown_template,
          proposed.required_fields,
          proposed.follow_up_policy,
          proposed.follow_up_after_days,
          proposed.max_followups,
          proposed.final_review_after_days,
          accountId,
        ],
      );
      return templateRow(rows[0]);
    },
  });
}

function validateTemplate(text: unknown, name: string, max: number): void {
  const value = bounded(text, name, max);
  for (const match of value.matchAll(/{{\s*([^{}]+?)\s*}}/g)) {
    if (!ALLOWED_MERGE_FIELDS.has(match[1]))
      throw Error(`unsupported merge field in ${name}: ${match[1]}`);
  }
  if (/{{|}}/.test(value.replace(/{{\s*[^{}]+?\s*}}/g, "")))
    throw Error(`${name} contains malformed merge syntax`);
}

export async function transitionOutreachTemplate(
  opts: CrmOutreachTemplateTransitionRequest,
): Promise<CrmMutationResult<CrmOutreachTemplate>> {
  assertSeed();
  reason(opts.reason);
  const accountId = actor(opts.account_id);
  const original = await resolveTemplate(getPool(), opts.template);
  const action = enumValue(
    opts.action,
    ["activate", "retire"] as const,
    "action",
  );
  return await mutate({
    action: `outreach.template.${action}`,
    actor: accountId,
    reason: opts.reason,
    commit: opts.commit,
    expectedVersion: opts.expected_version,
    idempotencyKey: opts.idempotency_key,
    proposed: {
      id: original.id,
      status: action === "activate" ? "active" : "retired",
    },
    resultType: "outreach_template",
    currentVersion: async (db) =>
      (await resolveTemplate(db, original.id, db !== getPool())).revision,
    validate: async (db) => {
      const current = await resolveTemplate(db, original.id, db !== getPool());
      if (action === "activate" && current.status !== "draft")
        throw Error("only a draft template can be activated");
      if (action === "retire" && current.status !== "active")
        throw Error("only an active template can be retired");
    },
    apply: async (db) => {
      if (action === "activate") {
        await db.query(
          "UPDATE crm_outreach_templates SET status='retired',retired_by_account_id=$1,retired_at=NOW() WHERE template_key=$2 AND status='active'",
          [accountId, original.template_key],
        );
        const { rows } = await db.query(
          "UPDATE crm_outreach_templates SET status='active',activated_by_account_id=$1,activated_at=NOW() WHERE id=$2 RETURNING *",
          [accountId, original.id],
        );
        return templateRow(rows[0]);
      }
      const { rows } = await db.query(
        "UPDATE crm_outreach_templates SET status='retired',retired_by_account_id=$1,retired_at=NOW() WHERE id=$2 RETURNING *",
        [accountId, original.id],
      );
      return templateRow(rows[0]);
    },
  });
}

export async function listOutreachBatches(
  opts: CrmOutreachBatchListRequest,
): Promise<CrmOutreachBatchListResponse> {
  assertSeed();
  reason(opts.reason);
  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.states?.length) {
    params.push(
      opts.states.map((v) => enumValue(v, CRM_OUTREACH_BATCH_STATES, "state")),
    );
    where.push(`b.state=ANY($${params.length}::text[])`);
  }
  if (opts.kinds?.length) {
    params.push(
      opts.kinds.map((v) => enumValue(v, CRM_OUTREACH_KINDS, "kind")),
    );
    where.push(`b.kind=ANY($${params.length}::text[])`);
  }
  if (opts.owner_account_id) {
    params.push(opts.owner_account_id);
    where.push(`b.owner_account_id=$${params.length}`);
  }
  if (opts.organization) {
    const org = await resolveOrganization(getPool(), opts.organization);
    params.push(org.id);
    where.push(
      `EXISTS(SELECT 1 FROM crm_outreach_deliveries d WHERE d.batch_id=b.id AND d.organization_id=$${params.length})`,
    );
  }
  if (opts.zendesk_ticket_id) {
    params.push(opts.zendesk_ticket_id);
    where.push(
      `EXISTS(SELECT 1 FROM crm_outreach_deliveries d WHERE d.batch_id=b.id AND d.zendesk_ticket_id=$${params.length})`,
    );
  }
  params.push(limit(opts.limit));
  const { rows } = await getPool().query(
    `SELECT b.* FROM crm_outreach_batches b ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY b.updated_at DESC,b.id LIMIT $${params.length}`,
    params,
  );
  return {
    batches: rows.map(batchRow),
    truncated: rows.length === params.at(-1),
  };
}

export async function getOutreachBatch(
  opts: CrmOutreachBatchGetRequest,
): Promise<CrmOutreachBatchDetail> {
  assertSeed();
  reason(opts.reason);
  const batch = await resolveBatch(getPool(), opts.batch);
  const { rows } = await getPool().query(
    "SELECT * FROM crm_outreach_deliveries WHERE batch_id=$1 ORDER BY created_at,id",
    [batch.id],
  );
  return { batch, deliveries: rows.map(deliveryRow) };
}

export async function createOutreachBatch(
  opts: CrmOutreachBatchCreateRequest,
): Promise<CrmMutationResult<CrmOutreachBatch>> {
  assertSeed();
  reason(opts.reason);
  const accountId = actor(opts.account_id);
  if (!isValidUUID(opts.owner_account_id))
    throw Error("owner_account_id must be a UUID");
  const template = opts.template
    ? await resolveTemplate(getPool(), opts.template)
    : null;
  const proposed = {
    name: bounded(opts.name, "name", 300),
    purpose: bounded(opts.purpose, "purpose", 2_000),
    kind: enumValue(opts.kind, CRM_OUTREACH_KINDS, "kind"),
    owner_account_id: opts.owner_account_id,
    template_id: template?.id ?? null,
    template_snapshot: template ?? {},
  };
  return await mutate({
    action: "outreach.batch.create",
    actor: accountId,
    reason: opts.reason,
    commit: opts.commit,
    expectedVersion: opts.expected_version,
    idempotencyKey: opts.idempotency_key,
    proposed,
    idempotencyPayload: {
      name: proposed.name,
      purpose: proposed.purpose,
      kind: proposed.kind,
      owner_account_id: proposed.owner_account_id,
      template_id: template?.id ?? null,
      template_revision: template?.revision ?? null,
    },
    resultType: "outreach_batch",
    currentVersion: async () => 0,
    validate: async (db) => {
      if (!template) return;
      const current = await resolveTemplate(db, template.id, db !== getPool());
      if (current.status !== "active")
        throw Error("new outreach batches require an active template revision");
    },
    apply: async (db) => {
      const id = randomUUID();
      const { rows } = await db.query(
        `INSERT INTO crm_outreach_batches
          (id,outreach_number,name,purpose,kind,state,template_id,template_snapshot,owner_account_id,created_by_account_id,updated_by_account_id)
         VALUES($1,'OUT-'||to_char(NOW(),'YYYY')||'-'||lpad(nextval('crm_outreach_number_seq')::text,6,'0'),$2,$3,$4,'draft',$5,$6,$7,$8,$8) RETURNING *`,
        [
          id,
          proposed.name,
          proposed.purpose,
          proposed.kind,
          proposed.template_id,
          proposed.template_snapshot,
          proposed.owner_account_id,
          accountId,
        ],
      );
      return batchRow(rows[0]);
    },
  });
}

export async function updateOutreachBatch(
  opts: CrmOutreachBatchUpdateRequest,
): Promise<CrmMutationResult<CrmOutreachBatch>> {
  assertSeed();
  reason(opts.reason);
  const accountId = actor(opts.account_id);
  const original = await resolveBatch(getPool(), opts.batch);
  const changes: Json = {};
  if (Object.hasOwn(opts.changes, "name"))
    changes.name = bounded(opts.changes.name, "name", 300);
  if (Object.hasOwn(opts.changes, "purpose"))
    changes.purpose = bounded(opts.changes.purpose, "purpose", 2_000);
  if (Object.hasOwn(opts.changes, "owner_account_id")) {
    if (!isValidUUID(`${opts.changes.owner_account_id}`))
      throw Error("owner_account_id must be a UUID");
    changes.owner_account_id = opts.changes.owner_account_id;
  }
  return await mutate({
    action: "outreach.batch.update",
    actor: accountId,
    reason: opts.reason,
    commit: opts.commit,
    expectedVersion: opts.expected_version,
    idempotencyKey: opts.idempotency_key,
    proposed: changes,
    resultType: "outreach_batch",
    currentVersion: async (db) =>
      (await resolveBatch(db, original.id, db !== getPool())).version,
    validate: async (db) => {
      const current = await resolveBatch(db, original.id, db !== getPool());
      if (current.state !== "draft")
        throw Error("only a draft outreach batch can be edited");
    },
    apply: async (db) => {
      const keys = Object.keys(changes);
      if (keys.length) {
        const values = keys.map((key) => changes[key]);
        values.push(accountId, original.id);
        await db.query(
          `UPDATE crm_outreach_batches SET ${keys.map((key, i) => `${key}=$${i + 1}`).join(",")},updated_by_account_id=$${keys.length + 1},updated_at=NOW(),version=version+1 WHERE id=$${keys.length + 2}`,
          values,
        );
      }
      return await resolveBatch(db, original.id);
    },
  });
}

function renderTemplate(text: string, context: Record<string, string>): string {
  return text.replace(/{{\s*([^{}]+?)\s*}}/g, (_match, field: string) => {
    if (!ALLOWED_MERGE_FIELDS.has(field))
      throw Error(`unsupported merge field: ${field}`);
    const value = context[field];
    if (value == null) throw Error(`missing required merge value: ${field}`);
    return value;
  });
}

async function recipientContext(
  opts: CrmOutreachRecipientRequest,
  batch: CrmOutreachBatch,
): Promise<{
  organization: any;
  person: any;
  email: any;
  opportunity: any | null;
  context: Record<string, string>;
}> {
  const person = await resolvePerson(getPool(), opts.person);
  let organization: any;
  if (opts.organization) {
    organization = await resolveOrganization(getPool(), opts.organization);
  } else {
    const organizations = await getPool().query(
      `SELECT o.* FROM crm_organizations o JOIN crm_organization_people op ON op.organization_id=o.id
        WHERE op.person_id=$1 AND op.state='active' AND o.status='active'
        ORDER BY 'primary_contact'=ANY(op.roles) DESC,o.updated_at DESC LIMIT 2`,
      [person.id],
    );
    if (organizations.rows.length > 1) {
      throw Error(
        "person is linked to multiple active CRM organizations; specify --organization",
      );
    }
    organization = organizations.rows[0];
  }
  if (!organization)
    throw Error("person is not linked to an active CRM organization");
  const opportunity = opts.opportunity
    ? await resolveOpportunity(getPool(), opts.opportunity)
    : null;
  if (opportunity && opportunity.organization_id !== organization.id)
    throw Error("opportunity belongs to a different organization");
  const emailQuery = opts.email ? normalizeEmail(opts.email) : null;
  const emails = await getPool().query(
    `SELECT * FROM crm_person_emails WHERE person_id=$1 AND ($2::text IS NULL OR normalized_email=$2)
      ORDER BY verified DESC,is_primary DESC,updated_at DESC LIMIT 2`,
    [person.id, emailQuery],
  );
  if (!emails.rows.length) throw Error("reviewed person email not found");
  if (
    !emailQuery &&
    emails.rows.length > 1 &&
    emails.rows[0].is_primary === emails.rows[1].is_primary
  )
    throw Error("person email is ambiguous; specify --email");
  const email = emails.rows[0];
  const owner = await getPool().query(
    "SELECT first_name,last_name FROM accounts WHERE account_id=$1",
    [batch.owner_account_id],
  );
  const ownerName =
    [owner.rows[0]?.first_name, owner.rows[0]?.last_name]
      .filter(Boolean)
      .join(" ") || "CoCalc Partnerships";
  const firstName =
    `${person.display_name}`.trim().split(/\s+/)[0] ?? person.display_name;
  return {
    organization,
    person,
    email,
    opportunity,
    context: {
      "person.display_name": person.display_name,
      "person.first_name": firstName,
      "person.email": email.normalized_email,
      "organization.display_name": organization.display_name,
      "organization.customer_number": organization.customer_number,
      "opportunity.name": opportunity?.name ?? "",
      "opportunity.kind": opportunity?.kind ?? "",
      "opportunity.expected_value": `${opportunity?.expected_value ?? ""}`,
      "opportunity.currency": opportunity?.currency ?? "",
      "opportunity.service_starts_at":
        iso(opportunity?.service_starts_at) ?? "",
      "opportunity.service_ends_at": iso(opportunity?.service_ends_at) ?? "",
      "relationship_owner.display_name": ownerName,
    },
  };
}

export async function activeSuppressions(
  db: Db,
  organizationId: string,
  personId: string,
  emailId: string,
  email: string,
): Promise<CrmContactSuppression[]> {
  const domain = email.split("@")[1];
  const { rows } = await db.query(
    `SELECT * FROM crm_contact_suppressions WHERE active AND (
      (scope='email' AND normalized_scope_value=$1) OR
      (scope='domain' AND normalized_scope_value=$2) OR
      (scope='person' AND person_id=$3) OR
      (scope='organization' AND organization_id=$4) OR person_email_id=$5)`,
    [email, domain, personId, organizationId, emailId],
  );
  return rows.map(suppressionRow);
}

async function deliveryPreflight(
  delivery: CrmOutreachDelivery,
): Promise<{ blocking_errors: string[]; warnings: string[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const config = await loadOutreachConfiguration();
  const relations = await getPool().query(
    `SELECT p.status AS person_status,e.verified,e.is_primary,op.state AS relationship_state,o.status AS organization_status
       FROM crm_people p JOIN crm_person_emails e ON e.person_id=p.id
       JOIN crm_organizations o ON o.id=$2
       LEFT JOIN crm_organization_people op ON op.organization_id=o.id AND op.person_id=p.id
      WHERE p.id=$1 AND e.id=$3`,
    [delivery.person_id, delivery.organization_id, delivery.person_email_id],
  );
  const relation = relations.rows[0];
  if (!relation || relation.person_status !== "active")
    errors.push("CRM person is not active");
  if (relation?.organization_status !== "active")
    errors.push("CRM organization is not active");
  if (relation?.relationship_state !== "active")
    errors.push("person is not actively linked to this organization");
  if (relation?.verified !== true)
    errors.push("recipient email relation is not reviewed and verified");
  if (relation?.is_primary !== true)
    errors.push("recipient email relation is not the reviewed primary email");
  const suppressions = await activeSuppressions(
    getPool(),
    delivery.organization_id,
    delivery.person_id,
    delivery.person_email_id,
    delivery.normalized_email,
  );
  if (suppressions.length)
    errors.push(
      `recipient is suppressed (${suppressions.map((item) => item.reason).join(", ")})`,
    );
  if (!delivery.subject.trim() || !delivery.body_plain_text.trim())
    errors.push("subject and body are required");
  if (delivery.subject.length > 500)
    errors.push("rendered subject exceeds 500 characters");
  if (delivery.body_plain_text.length > MAX_BODY)
    errors.push(`rendered message exceeds ${MAX_BODY} characters`);
  if (
    !delivery.footer.includes(config.postal_address) ||
    !delivery.body_plain_text.includes("/crm/outreach/opt-out/")
  ) {
    errors.push("required postal address and opt-out footer are missing");
  }
  const recent = await getPool().query(
    `SELECT max(notification_requested_at) AS last_contact FROM crm_outreach_deliveries
      WHERE normalized_email=$1 AND id<>$2 AND notification_requested_at >= NOW()-($3::int * INTERVAL '1 day')`,
    [delivery.normalized_email, delivery.id, config.contact_cooldown_days],
  );
  if (recent.rows[0]?.last_contact)
    warnings.push(
      `contact cooldown has not elapsed since ${isoRequired(recent.rows[0].last_contact)}`,
    );
  const duplicate = await getPool().query(
    `SELECT count(*)::int AS count FROM crm_outreach_deliveries
      WHERE id<>$1 AND normalized_email=$2 AND kind=$3 AND state IN ('approved','queued','creating_ticket','notification_requested')`,
    [delivery.id, delivery.normalized_email, delivery.kind],
  );
  if (duplicate.rows[0].count)
    errors.push(
      "same-purpose nonterminal outreach already exists for this contact",
    );
  return { blocking_errors: errors, warnings };
}

export async function addOutreachRecipient(
  opts: CrmOutreachRecipientRequest,
): Promise<CrmMutationResult<CrmOutreachDelivery>> {
  assertSeed();
  reason(opts.reason);
  const accountId = actor(opts.account_id);
  const batch = await resolveBatch(getPool(), opts.batch);
  const config = await loadOutreachConfiguration();
  const optOutSecret = requireOutreachOptOutSecret(config.webhook_secret);
  const target = await recipientContext(opts, batch);
  const template = batch.template_id
    ? await resolveTemplate(getPool(), batch.template_id)
    : null;
  const inputKey = `crm:outreach.recipient:${digest({ batch: batch.id, person: target.person.id, email: target.email.id, opportunity: target.opportunity?.id, subject: opts.subject, body: opts.body_markdown }).slice(0, 32)}`;
  const idempotencyKey = opts.idempotency_key ?? inputKey;
  const optOutToken = createHmac("sha256", optOutSecret)
    .update(`opt-out:${idempotencyKey}`)
    .digest("base64url");
  const optOutUrl = `${config.site_url}/crm/outreach/opt-out/${optOutToken}`;
  const subject = opts.subject
    ? bounded(opts.subject, "subject", 500)
    : renderTemplate(template?.subject_template ?? "", target.context);
  const bodyMarkdown = opts.body_markdown
    ? bounded(opts.body_markdown, "body_markdown", MAX_BODY)
    : renderTemplate(template?.body_markdown_template ?? "", target.context);
  if (!subject || !bodyMarkdown)
    throw Error("an active template or custom subject and body are required");
  const footer =
    `${config.footer_markdown}\n\n${config.postal_address}\n\nTo stop receiving partnership outreach from CoCalc: ${optOutUrl}`.trim();
  const bodyPlain = `${bodyMarkdown}\n\n${footer}`;
  if (bodyPlain.length > MAX_BODY) {
    throw Error(
      `rendered outreach body including its required footer must be at most ${MAX_BODY} characters`,
    );
  }
  const proposed = {
    batch_id: batch.id,
    organization_id: target.organization.id,
    person_id: target.person.id,
    person_email_id: target.email.id,
    opportunity_id: target.opportunity?.id ?? null,
    kind: batch.kind,
    recipient_name: target.person.display_name,
    normalized_email: target.email.normalized_email,
    recipient_domain: normalizeDomain(
      target.email.normalized_email.split("@")[1],
    ),
    subject,
    body_plain_text: bodyPlain,
    body_markdown: `${bodyMarkdown}\n\n${footer}`,
    rendered_html: markdown.render(`${bodyMarkdown}\n\n${footer}`),
    footer,
    template_snapshot: template ?? batch.template_snapshot,
    follow_up_policy: template?.follow_up_policy ?? "no_response",
    follow_up_after_days:
      template?.follow_up_after_days ?? config.default_followup_days,
    max_followups: template?.max_followups ?? config.default_max_followups,
    final_review_after_days:
      template?.final_review_after_days ?? config.default_final_review_days,
    opt_out_token_digest: createHash("sha256")
      .update(optOutToken)
      .digest("hex"),
    override_reason: optionalBounded(
      opts.override_reason,
      "override_reason",
      2_000,
    ),
  };
  const previewDelivery = deliveryRow({
    // Preflight queries compare this value against UUID columns even though the
    // preview is never persisted.
    id: randomUUID(),
    ...proposed,
    task_id: null,
    state: "draft",
    provider_external_id: "cocalc-crm-outreach:preview",
    zendesk_sync_metadata: {},
    view_observation_count: 0,
    follow_up_attempt_count: 0,
    follow_up_suggested_action: "await_response",
    next_attempt_at: new Date(),
    attempt_count: 0,
    created_by_account_id: accountId,
    updated_by_account_id: accountId,
    created_at: new Date(),
    updated_at: new Date(),
    version: 1,
  });
  const previewChecks = opts.commit
    ? { blocking_errors: [], warnings: [] }
    : await deliveryPreflight(previewDelivery);
  if (previewChecks.warnings.length && !proposed.override_reason)
    previewChecks.warnings.push(
      "commit requires override_reason for the listed warnings",
    );
  return await mutate({
    action: "outreach.recipient.add",
    actor: accountId,
    reason: opts.reason,
    commit: opts.commit,
    expectedVersion: opts.expected_version,
    idempotencyKey: opts.idempotency_key,
    defaultIdempotencyKey: inputKey,
    organizationId: target.organization.id,
    proposed,
    idempotencyPayload: {
      batch_id: batch.id,
      organization_id: target.organization.id,
      person_id: target.person.id,
      person_email_id: target.email.id,
      opportunity_id: target.opportunity?.id ?? null,
      template_id: template?.id ?? null,
      template_revision: template?.revision ?? null,
      subject: opts.subject ?? null,
      body_markdown: opts.body_markdown ?? null,
      override_reason: proposed.override_reason,
    },
    warnings: previewChecks.warnings,
    resultType: "outreach_delivery",
    currentVersion: async (db) =>
      (await resolveBatch(db, batch.id, db !== getPool())).version,
    validate: async (db) => {
      const currentBatch = await resolveBatch(db, batch.id, db !== getPool());
      if (currentBatch.state !== "draft")
        throw Error("recipients can only be added to a draft batch");
      const currentConfig = await loadOutreachConfiguration();
      if (
        currentBatch.recipient_count >= currentConfig.max_recipients_per_batch
      )
        throw Error(
          `batch recipient limit is ${currentConfig.max_recipients_per_batch}`,
        );
      const currentTarget = await recipientContext(opts, currentBatch);
      if (currentTarget.email.verified !== true)
        throw Error("recipient email relation must be reviewed and verified");
      const currentTemplate = currentBatch.template_id
        ? await resolveTemplate(db, currentBatch.template_id)
        : null;
      const missingFields = missingRequiredMergeFields(
        currentTemplate?.required_fields ?? [],
        currentTarget.context,
      );
      if (missingFields.length)
        throw Error(
          `required outreach values are missing: ${missingFields.join(", ")}`,
        );
      const checks = await deliveryPreflight(previewDelivery);
      const suppressions = await activeSuppressions(
        db,
        currentTarget.organization.id,
        currentTarget.person.id,
        currentTarget.email.id,
        currentTarget.email.normalized_email,
      );
      if (suppressions.length)
        checks.blocking_errors.push(
          "active suppression prevents adding this recipient",
        );
      if (checks.blocking_errors.length)
        throw Error(checks.blocking_errors.join("; "));
      if (checks.warnings.length && !proposed.override_reason)
        throw Error(
          "override_reason is required to commit a recipient with preflight warnings",
        );
    },
    apply: async (db, eventId) => {
      const id = randomUUID();
      const { rows } = await db.query(
        `INSERT INTO crm_outreach_deliveries
          (id,batch_id,organization_id,person_id,person_email_id,opportunity_id,kind,recipient_name,normalized_email,
           recipient_domain,subject,body_plain_text,body_markdown,rendered_html,footer,template_snapshot,state,
           provider_external_id,zendesk_sync_metadata,follow_up_policy,follow_up_after_days,max_followups,
           final_review_after_days,follow_up_suggested_action,next_attempt_at,opt_out_token_digest,override_reason,
           created_by_account_id,updated_by_account_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'draft',$17,'{}'::jsonb,$18,$19,$20,$21,
           'await_response',NOW(),$22,$23,$24,$24) RETURNING *`,
        [
          id,
          proposed.batch_id,
          proposed.organization_id,
          proposed.person_id,
          proposed.person_email_id,
          proposed.opportunity_id,
          proposed.kind,
          proposed.recipient_name,
          proposed.normalized_email,
          proposed.recipient_domain,
          proposed.subject,
          proposed.body_plain_text,
          proposed.body_markdown,
          proposed.rendered_html,
          proposed.footer,
          proposed.template_snapshot,
          `cocalc-crm-outreach:${id}`,
          proposed.follow_up_policy,
          proposed.follow_up_after_days,
          proposed.max_followups,
          proposed.final_review_after_days,
          proposed.opt_out_token_digest,
          proposed.override_reason,
          accountId,
        ],
      );
      await db.query(
        "UPDATE crm_outreach_batches SET recipient_count=recipient_count+1,updated_by_account_id=$1,updated_at=NOW(),version=version+1 WHERE id=$2",
        [accountId, batch.id],
      );
      await addActivity(db, {
        organization_id: target.organization.id,
        person_id: target.person.id,
        opportunity_id: target.opportunity?.id,
        source_id: eventId,
        summary: `Drafted outreach to ${target.person.display_name}`,
        details: opts.reason,
        actor_account_id: accountId,
        metadata: { delivery_id: id, batch_id: batch.id },
      });
      return deliveryRow(rows[0]);
    },
  });
}

export async function removeOutreachRecipient(
  opts: CrmOutreachRecipientRemoveRequest,
): Promise<CrmMutationResult<CrmOutreachDelivery>> {
  assertSeed();
  reason(opts.reason);
  const accountId = actor(opts.account_id);
  const batch = await resolveBatch(getPool(), opts.batch);
  const delivery = await resolveDelivery(getPool(), opts.delivery);
  if (delivery.batch_id !== batch.id)
    throw Error("delivery belongs to a different batch");
  return await mutate({
    action: "outreach.recipient.remove",
    actor: accountId,
    reason: opts.reason,
    commit: opts.commit,
    expectedVersion: opts.expected_version,
    idempotencyKey: opts.idempotency_key,
    organizationId: delivery.organization_id,
    proposed: { delivery_id: delivery.id, state: "cancelled" },
    resultType: "outreach_delivery",
    currentVersion: async (db) =>
      (await resolveBatch(db, batch.id, db !== getPool())).version,
    validate: async (db) => {
      const currentBatch = await resolveBatch(db, batch.id, db !== getPool());
      const currentDelivery = await resolveDelivery(
        db,
        delivery.id,
        db !== getPool(),
      );
      if (currentBatch.state !== "draft" || currentDelivery.state !== "draft")
        throw Error("only draft recipients can be removed");
    },
    apply: async (db, eventId) => {
      const { rows } = await db.query(
        "UPDATE crm_outreach_deliveries SET state='cancelled',cancelled_at=NOW(),updated_by_account_id=$1,updated_at=NOW(),version=version+1 WHERE id=$2 RETURNING *",
        [accountId, delivery.id],
      );
      await db.query(
        "UPDATE crm_outreach_batches SET recipient_count=GREATEST(recipient_count-1,0),updated_by_account_id=$1,updated_at=NOW(),version=version+1 WHERE id=$2",
        [accountId, batch.id],
      );
      await addActivity(db, {
        organization_id: delivery.organization_id,
        person_id: delivery.person_id,
        opportunity_id: delivery.opportunity_id,
        source_id: eventId,
        summary: `Removed draft outreach recipient ${delivery.recipient_name}`,
        details: opts.reason,
        actor_account_id: accountId,
        metadata: { delivery_id: delivery.id, batch_id: batch.id },
      });
      return deliveryRow(rows[0]);
    },
  });
}

export async function previewOutreachBatch(
  opts: CrmOutreachPreviewRequest,
): Promise<CrmOutreachPreview> {
  assertSeed();
  reason(opts.reason);
  const detail = await getOutreachBatch({ ...opts, batch: opts.batch });
  const deliveries = await Promise.all(
    detail.deliveries
      .filter((item) => item.state !== "cancelled")
      .map(async (delivery) => ({
        delivery,
        ...(await deliveryPreflight(delivery)),
      })),
  );
  const limits = await getOutreachLimits({ reason: opts.reason });
  const config = await loadOutreachConfiguration();
  const providerErrors = outreachProviderConfigurationErrors(config);
  if (providerErrors.length)
    for (const item of deliveries) item.blocking_errors.push(...providerErrors);
  const canApprove =
    deliveries.length > 0 &&
    deliveries.every(
      (item) =>
        !item.blocking_errors.length &&
        (!item.warnings.length || !!item.delivery.override_reason),
    );
  return {
    batch: detail.batch,
    deliveries,
    effective_limits: limits,
    provider_routing: {
      support_address: config.support_address,
      submitter_id: config.submitter_id,
      group_id: config.group_id,
      form_id: config.form_id,
    },
    can_approve: canApprove && detail.batch.state === "draft",
    can_queue: canQueueOutreachBatch(canApprove, detail.batch.state),
  };
}

export async function transitionOutreachBatch(
  opts: CrmOutreachBatchTransitionRequest,
): Promise<CrmMutationResult<CrmOutreachBatchDetail>> {
  assertSeed();
  reason(opts.reason);
  const accountId = actor(opts.account_id);
  const original = await resolveBatch(getPool(), opts.batch);
  const action = enumValue(
    opts.action,
    ["approve", "queue", "pause", "resume", "cancel"] as const,
    "action",
  );
  const next: Record<typeof action, string> = {
    approve: "approved",
    queue: "queued",
    pause: "paused",
    resume: "queued",
    cancel: "cancelled",
  };
  const allowed: Record<typeof action, string[]> = {
    approve: ["draft"],
    queue: ["approved"],
    pause: ["queued", "sending"],
    resume: ["paused"],
    cancel: ["draft", "approved", "queued", "paused"],
  };
  const preview = await previewOutreachBatch({
    batch: original.id,
    reason: opts.reason,
  });
  return await mutate({
    action: `outreach.batch.${action}`,
    actor: accountId,
    reason: opts.reason,
    commit: opts.commit,
    expectedVersion: opts.expected_version,
    idempotencyKey: opts.idempotency_key,
    proposed: {
      id: original.id,
      state: next[action],
      recipient_count: preview.deliveries.length,
    },
    resultType: "outreach_batch",
    currentVersion: async (db) =>
      (await resolveBatch(db, original.id, db !== getPool())).version,
    validate: async (db) => {
      const current = await resolveBatch(db, original.id, db !== getPool());
      if (!allowed[action].includes(current.state))
        throw Error(
          `cannot ${action} an outreach batch in ${current.state} state`,
        );
      if (action === "approve" || action === "queue") {
        const currentPreview = await previewOutreachBatch({
          batch: current.id,
          reason: opts.reason,
        });
        if (action === "approve" && !currentPreview.can_approve)
          throw Error(
            "batch preflight has blocking errors or unreviewed warnings",
          );
        if (action === "queue" && !currentPreview.can_queue)
          throw Error(
            "batch preflight has blocking errors or unreviewed warnings",
          );
      }
    },
    apply: async (db, eventId) => {
      const state = next[action];
      const timestampColumn =
        action === "approve"
          ? null
          : action === "queue" || action === "resume"
            ? "queued_at"
            : action === "pause"
              ? "paused_at"
              : "cancelled_at";
      await db.query(
        `UPDATE crm_outreach_batches SET state=$1,updated_by_account_id=$2,updated_at=NOW(),version=version+1,
          approved_by_account_id=CASE WHEN $1='approved' THEN $2::uuid ELSE approved_by_account_id END,
          approved_recipient_count=CASE WHEN $1='approved' THEN recipient_count ELSE approved_recipient_count END
          ${timestampColumn ? `,${timestampColumn}=NOW()` : ""} WHERE id=$3`,
        [state, accountId, original.id],
      );
      if (action === "approve")
        await db.query(
          "UPDATE crm_outreach_deliveries SET state='approved',approved_by_account_id=$1,approved_at=NOW(),updated_by_account_id=$1,updated_at=NOW(),version=version+1 WHERE batch_id=$2 AND state='draft'",
          [accountId, original.id],
        );
      if (["queue", "resume"].includes(action))
        await db.query(
          "UPDATE crm_outreach_deliveries SET state='queued',queued_at=COALESCE(queued_at,NOW()),next_attempt_at=NOW(),updated_by_account_id=$1,updated_at=NOW(),version=version+1 WHERE batch_id=$2 AND state IN ('approved','failed')",
          [accountId, original.id],
        );
      if (action === "cancel")
        await db.query(
          "UPDATE crm_outreach_deliveries SET state='cancelled',cancelled_at=NOW(),updated_by_account_id=$1,updated_at=NOW(),version=version+1 WHERE batch_id=$2 AND state IN ('draft','approved','queued','failed')",
          [accountId, original.id],
        );
      for (const delivery of preview.deliveries)
        await addActivity(db, {
          organization_id: delivery.delivery.organization_id,
          person_id: delivery.delivery.person_id,
          opportunity_id: delivery.delivery.opportunity_id,
          source_id: `${eventId}:${delivery.delivery.id}`,
          summary: `${action} outreach ${original.outreach_number}`,
          details: opts.reason,
          actor_account_id: accountId,
          metadata: {
            batch_id: original.id,
            delivery_id: delivery.delivery.id,
            state,
          },
        });
      const batch = await resolveBatch(db, original.id);
      const rows = await db.query(
        "SELECT * FROM crm_outreach_deliveries WHERE batch_id=$1 ORDER BY created_at,id",
        [original.id],
      );
      return { batch, deliveries: rows.rows.map(deliveryRow) };
    },
  });
}

export async function listOutreachDeliveries(
  opts: CrmOutreachDeliveryListRequest,
): Promise<CrmOutreachDeliveryListResponse> {
  assertSeed();
  reason(opts.reason);
  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.batch) {
    const batch = await resolveBatch(getPool(), opts.batch);
    params.push(batch.id);
    where.push(`d.batch_id=$${params.length}`);
  }
  if (opts.organization) {
    const org = await resolveOrganization(getPool(), opts.organization);
    params.push(org.id);
    where.push(`d.organization_id=$${params.length}`);
  }
  if (opts.person) {
    const person = await resolvePerson(getPool(), opts.person);
    params.push(person.id);
    where.push(`d.person_id=$${params.length}`);
  }
  if (opts.opportunity) {
    const opportunity = await resolveOpportunity(getPool(), opts.opportunity);
    params.push(opportunity.id);
    where.push(`d.opportunity_id=$${params.length}`);
  }
  if (opts.states?.length) {
    params.push(
      opts.states.map((value) =>
        enumValue(value, CRM_OUTREACH_DELIVERY_STATES, "state"),
      ),
    );
    where.push(`d.state=ANY($${params.length}::text[])`);
  }
  if (opts.zendesk_ticket_id) {
    params.push(opts.zendesk_ticket_id);
    where.push(`d.zendesk_ticket_id=$${params.length}`);
  }
  if (opts.engagement === "viewed") where.push("d.view_observation_count>0");
  if (opts.engagement === "unviewed") where.push("d.view_observation_count=0");
  if (opts.engagement === "replied") where.push("d.replied_at IS NOT NULL");
  if (opts.engagement === "unreplied") where.push("d.replied_at IS NULL");
  if (opts.suggested_action) {
    params.push(opts.suggested_action);
    where.push(`d.follow_up_suggested_action=$${params.length}`);
  }
  params.push(limit(opts.limit));
  const { rows } = await getPool().query(
    `SELECT d.* FROM crm_outreach_deliveries d ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY d.updated_at DESC,d.id LIMIT $${params.length}`,
    params,
  );
  return {
    deliveries: rows.map(deliveryRow),
    truncated: rows.length === params.at(-1),
  };
}

export async function getOutreachDelivery(
  opts: CrmOutreachDeliveryGetRequest,
): Promise<CrmOutreachDelivery> {
  assertSeed();
  reason(opts.reason);
  return await resolveDelivery(getPool(), opts.delivery);
}

export async function listOutreachProviderOperations(
  opts: CrmOutreachProviderOperationListRequest,
): Promise<CrmOutreachProviderOperationListResponse> {
  assertSeed();
  reason(opts.reason);
  const delivery = await resolveDelivery(getPool(), opts.delivery);
  const rowLimit = limit(opts.limit);
  const { rows } = await getPool().query(
    `SELECT * FROM crm_outreach_provider_operations
      WHERE delivery_id=$1 ORDER BY created_at DESC,id LIMIT $2`,
    [delivery.id, rowLimit],
  );
  return {
    operations: rows.map(providerOperationRow),
    truncated: rows.length === rowLimit,
  };
}

export async function mutateOutreachDelivery(
  opts: CrmOutreachDeliveryActionRequest,
): Promise<CrmMutationResult<CrmOutreachDelivery>> {
  assertSeed();
  reason(opts.reason);
  const accountId = actor(opts.account_id);
  const original = await resolveDelivery(getPool(), opts.delivery);
  const action = enumValue(
    opts.action,
    ["retry", "reconcile", "cancel"] as const,
    "action",
  );
  return await mutate({
    action: `outreach.delivery.${action}`,
    actor: accountId,
    reason: opts.reason,
    commit: opts.commit,
    expectedVersion: opts.expected_version,
    idempotencyKey: opts.idempotency_key,
    organizationId: original.organization_id,
    proposed: { id: original.id, action },
    resultType: "outreach_delivery",
    currentVersion: async (db) =>
      (await resolveDelivery(db, original.id, db !== getPool())).version,
    validate: async (db) => {
      const current = await resolveDelivery(db, original.id, db !== getPool());
      if (action === "retry" && current.state !== "failed")
        throw Error("only failed deliveries can be retried");
      if (
        action === "reconcile" &&
        !["creating_ticket", "notification_requested", "failed"].includes(
          current.state,
        )
      )
        throw Error("delivery is not eligible for reconciliation");
      if (
        action === "cancel" &&
        !["draft", "approved", "queued", "failed"].includes(current.state)
      )
        throw Error("delivery can no longer be cancelled");
    },
    apply: async (db, eventId) => {
      if (action === "retry")
        await db.query(
          "UPDATE crm_outreach_deliveries SET state='queued',next_attempt_at=NOW(),last_error=NULL,updated_by_account_id=$1,updated_at=NOW(),version=version+1 WHERE id=$2",
          [accountId, original.id],
        );
      if (action === "cancel")
        await db.query(
          "UPDATE crm_outreach_deliveries SET state='cancelled',cancelled_at=NOW(),updated_by_account_id=$1,updated_at=NOW(),version=version+1 WHERE id=$2",
          [accountId, original.id],
        );
      if (action === "reconcile")
        await db.query(
          `INSERT INTO crm_outreach_provider_operations
          (id,delivery_id,operation,idempotency_key,payload_hash,state,attempt_number,provider_external_id,rate_limit_snapshot,not_before)
         VALUES($1,$2,'reconcile_ticket',$3,$4,'queued',1,$5,'{}'::jsonb,NOW()) ON CONFLICT(idempotency_key) DO NOTHING`,
          [
            randomUUID(),
            original.id,
            `reconcile:${original.id}:${original.version}`,
            digest({ id: original.id, action }),
            original.provider_external_id,
          ],
        );
      await addActivity(db, {
        organization_id: original.organization_id,
        person_id: original.person_id,
        opportunity_id: original.opportunity_id,
        zendesk_ticket_id: original.zendesk_ticket_id,
        source_id: eventId,
        summary: `${action} outreach delivery`,
        details: opts.reason,
        actor_account_id: accountId,
        metadata: { delivery_id: original.id },
      });
      return await resolveDelivery(db, original.id);
    },
  });
}

export async function listContactSuppressions(
  opts: CrmContactSuppressionListRequest,
): Promise<CrmContactSuppressionListResponse> {
  assertSeed();
  reason(opts.reason);
  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.organization) {
    const org = await resolveOrganization(getPool(), opts.organization);
    params.push(org.id);
    where.push(`organization_id=$${params.length}`);
  }
  if (opts.person) {
    const person = await resolvePerson(getPool(), opts.person);
    params.push(person.id);
    where.push(`person_id=$${params.length}`);
  }
  if (opts.active != null) {
    params.push(opts.active);
    where.push(`active=$${params.length}`);
  }
  if (opts.scope) {
    params.push(
      enumValue(opts.scope, CRM_OUTREACH_SUPPRESSION_SCOPES, "scope"),
    );
    where.push(`scope=$${params.length}`);
  }
  if (opts.search) {
    params.push(`%${opts.search.toLowerCase()}%`);
    where.push(
      `(lower(normalized_scope_value) LIKE $${params.length} OR lower(COALESCE(note,'')) LIKE $${params.length})`,
    );
  }
  params.push(limit(opts.limit));
  const { rows } = await getPool().query(
    `SELECT * FROM crm_contact_suppressions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY active DESC,created_at DESC LIMIT $${params.length}`,
    params,
  );
  return {
    suppressions: rows.map(suppressionRow),
    truncated: rows.length === params.at(-1),
  };
}

export async function mutateContactSuppression(
  opts: CrmContactSuppressionMutationRequest,
): Promise<CrmMutationResult<CrmContactSuppression>> {
  assertSeed();
  reason(opts.reason);
  const accountId = actor(opts.account_id);
  const action = enumValue(opts.action, ["add", "revoke"] as const, "action");
  if (action === "revoke") {
    const id = bounded(opts.suppression, "suppression", 500);
    const { rows } = await getPool().query(
      "SELECT * FROM crm_contact_suppressions WHERE id::text=$1",
      [id],
    );
    if (!rows[0]) throw Error("suppression not found");
    const original = suppressionRow(rows[0]);
    return await mutate({
      action: "outreach.suppression.revoke",
      actor: accountId,
      reason: opts.reason,
      commit: opts.commit,
      expectedVersion: opts.expected_version,
      idempotencyKey: opts.idempotency_key,
      organizationId: original.organization_id,
      proposed: {
        id: original.id,
        active: false,
        revocation_reason: reason(opts.reason),
      },
      resultType: "contact_suppression",
      currentVersion: async (db) =>
        Number(
          (
            await db.query(
              "SELECT version FROM crm_contact_suppressions WHERE id=$1 FOR UPDATE",
              [original.id],
            )
          ).rows[0].version,
        ),
      validate: async (db) => {
        const current = await db.query(
          "SELECT active FROM crm_contact_suppressions WHERE id=$1 FOR UPDATE",
          [original.id],
        );
        if (current.rows[0]?.active !== true)
          throw Error("suppression is already revoked");
      },
      apply: async (db, eventId) => {
        const result = await db.query(
          "UPDATE crm_contact_suppressions SET active=false,revoked_by_account_id=$1,revoked_at=NOW(),revocation_reason=$2,version=version+1 WHERE id=$3 RETURNING *",
          [accountId, opts.reason, original.id],
        );
        if (original.organization_id)
          await addActivity(db, {
            organization_id: original.organization_id,
            person_id: original.person_id,
            source_id: eventId,
            summary: `Revoked ${original.scope} outreach suppression`,
            details: opts.reason,
            actor_account_id: accountId,
            metadata: { suppression_id: original.id },
          });
        const suppression = suppressionRow(result.rows[0]);
        recordOutreachSuppression("revoke", suppression.scope);
        return suppression;
      },
    });
  }
  const scope = enumValue(opts.scope, CRM_OUTREACH_SUPPRESSION_SCOPES, "scope");
  const organization = opts.organization
    ? await resolveOrganization(getPool(), opts.organization)
    : null;
  const person = opts.person
    ? await resolvePerson(getPool(), opts.person)
    : null;
  const email = opts.email ? normalizeEmail(opts.email) : null;
  let value = bounded(
    opts.value ?? email ?? person?.id ?? organization?.id,
    "suppression value",
    500,
  );
  if (scope === "email") value = normalizeEmail(value);
  if (scope === "domain") value = normalizeDomain(value);
  if (scope === "person" && !person)
    throw Error("person is required for a person suppression");
  if (scope === "organization" && !organization)
    throw Error("organization is required for an organization suppression");
  const suppressionReason = enumValue(
    opts.suppression_reason ?? "manual",
    CRM_OUTREACH_SUPPRESSION_REASONS,
    "suppression_reason",
  );
  const proposed = {
    scope,
    normalized_scope_value: value,
    organization_id: organization?.id ?? null,
    person_id: person?.id ?? null,
    reason: suppressionReason,
    source: opts.source === "cli" ? "cli" : "admin_ui",
    note: optionalBounded(opts.note, "note", 5_000),
  };
  return await mutate({
    action: "outreach.suppression.add",
    actor: accountId,
    reason: opts.reason,
    commit: opts.commit,
    expectedVersion: opts.expected_version,
    idempotencyKey: opts.idempotency_key,
    organizationId: organization?.id,
    proposed,
    warnings: [
      "This suppression blocks queued and future outreach at its selected scope.",
    ],
    resultType: "contact_suppression",
    currentVersion: async () => 0,
    apply: async (db, eventId) => {
      const id = randomUUID();
      const { rows } = await db.query(
        `INSERT INTO crm_contact_suppressions
          (id,scope,normalized_scope_value,organization_id,person_id,reason,source,note,active,created_by_account_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,true,$9) RETURNING *`,
        [
          id,
          proposed.scope,
          proposed.normalized_scope_value,
          proposed.organization_id,
          proposed.person_id,
          proposed.reason,
          proposed.source,
          proposed.note,
          accountId,
        ],
      );
      await db.query(
        `UPDATE crm_outreach_deliveries SET state='suppressed',last_error=$1,updated_by_account_id=$2,updated_at=NOW(),version=version+1
          WHERE state IN ('draft','approved','queued','failed') AND (
            ($3='email' AND normalized_email=$4) OR ($3='domain' AND recipient_domain=$4) OR
            ($3='person' AND person_id=$5) OR ($3='organization' AND organization_id=$6))`,
        [
          `Suppressed: ${proposed.reason}`,
          accountId,
          scope,
          value,
          person?.id ?? null,
          organization?.id ?? null,
        ],
      );
      await db.query(
        `UPDATE crm_tasks t SET state='cancelled',cancelled_at=NOW(),cancelled_by_account_id=$1,updated_by_account_id=$1,updated_at=NOW(),version=version+1
          FROM crm_outreach_deliveries d WHERE d.task_id=t.id AND t.state IN ('open','waiting') AND (
            ($2='email' AND d.normalized_email=$3) OR ($2='domain' AND d.recipient_domain=$3) OR
            ($2='person' AND d.person_id=$4) OR ($2='organization' AND d.organization_id=$5))`,
        [accountId, scope, value, person?.id ?? null, organization?.id ?? null],
      );
      await db.query(
        `UPDATE crm_outreach_provider_operations p SET state='cancelled',
          provider_status='cancelled_suppression',error_category='suppressed',
          error_text='Queued follow-up cancelled by an active outreach suppression',
          lease_owner=NULL,lease_expires_at=NULL,finished_at=NOW(),updated_at=NOW()
         FROM crm_outreach_deliveries d
        WHERE p.delivery_id=d.id AND p.operation='add_comment' AND p.state='queued' AND (
          ($1='email' AND d.normalized_email=$2) OR ($1='domain' AND d.recipient_domain=$2) OR
          ($1='person' AND d.person_id=$3) OR ($1='organization' AND d.organization_id=$4))`,
        [scope, value, person?.id ?? null, organization?.id ?? null],
      );
      if (organization)
        await addActivity(db, {
          organization_id: organization.id,
          person_id: person?.id,
          source_id: eventId,
          summary: `Added ${scope} outreach suppression`,
          details: opts.reason,
          actor_account_id: accountId,
          metadata: { suppression_id: id, reason: suppressionReason },
        });
      const suppression = suppressionRow(rows[0]);
      recordOutreachSuppression("add", suppression.scope);
      return suppression;
    },
  });
}

export async function listOutreachEngagementEvents(
  opts: CrmOutreachEngagementListRequest,
): Promise<CrmOutreachEngagementListResponse> {
  assertSeed();
  reason(opts.reason);
  const delivery = await resolveDelivery(getPool(), opts.delivery);
  const { rows } = await getPool().query(
    "SELECT * FROM crm_outreach_engagement_events WHERE delivery_id=$1 ORDER BY observed_at DESC,id LIMIT $2",
    [delivery.id, limit(opts.limit)],
  );
  return {
    events: rows.map(engagementRow),
    truncated: rows.length === limit(opts.limit),
  };
}

export async function listOutreachFollowups(
  opts: CrmOutreachFollowUpListRequest,
): Promise<CrmOutreachFollowUpListResponse> {
  assertSeed();
  reason(opts.reason);
  const params: unknown[] = [];
  const where = ["d.task_id IS NOT NULL", "t.state IN ('open','waiting')"];
  if (opts.organization) {
    const org = await resolveOrganization(getPool(), opts.organization);
    params.push(org.id);
    where.push(`d.organization_id=$${params.length}`);
  }
  if (opts.opportunity) {
    const opportunity = await resolveOpportunity(getPool(), opts.opportunity);
    params.push(opportunity.id);
    where.push(`d.opportunity_id=$${params.length}`);
  }
  if (opts.assignee_account_id) {
    params.push(opts.assignee_account_id);
    where.push(`t.assignee_account_id=$${params.length}`);
  }
  if (opts.due_before) {
    params.push(isoRequired(opts.due_before));
    where.push(`t.due_at<=$${params.length}`);
  }
  if (opts.overdue) where.push("t.due_at<NOW()");
  if (opts.viewed != null)
    where.push(
      opts.viewed ? "d.view_observation_count>0" : "d.view_observation_count=0",
    );
  if (opts.replied != null)
    where.push(
      opts.replied ? "d.replied_at IS NOT NULL" : "d.replied_at IS NULL",
    );
  params.push(limit(opts.limit));
  const { rows } = await getPool().query(
    `SELECT to_jsonb(d) AS delivery,to_jsonb(t) AS task,
      o.id AS organization_id,o.customer_number,o.display_name
       FROM crm_outreach_deliveries d JOIN crm_tasks t ON t.id=d.task_id JOIN crm_organizations o ON o.id=d.organization_id
      WHERE ${where.join(" AND ")} ORDER BY t.due_at,t.id LIMIT $${params.length}`,
    params,
  );
  return {
    followups: rows.map((row) => {
      const delivery = deliveryRow(row.delivery);
      return {
        delivery,
        task: taskRow(row.task),
        organization: {
          id: row.organization_id,
          customer_number: row.customer_number,
          display_name: row.display_name,
        },
        support_show_command: `cocalc admin support show ${delivery.zendesk_ticket_id}`,
        follow_up_command: `cocalc admin crm outreach followups draft ${delivery.id}`,
      };
    }),
    truncated: rows.length === params.at(-1),
  };
}

export async function previewOutreachFollowup(
  opts: CrmOutreachFollowUpPreviewRequest,
): Promise<CrmOutreachFollowUpPreview> {
  assertSeed();
  reason(opts.reason);
  const delivery = await resolveDelivery(getPool(), opts.delivery);
  await assertOutreachFollowupEligible(getPool(), delivery);
  return composeOutreachFollowup(delivery, opts.body);
}

async function assertOutreachFollowupEligible(
  db: Db,
  delivery: CrmOutreachDelivery,
): Promise<void> {
  if (!delivery.zendesk_ticket_id || !delivery.task_id)
    throw Error("delivery has no linked Zendesk ticket and follow-up task");
  const eligibility = await db.query(
    `SELECT t.state AS task_state,
      EXISTS(SELECT 1 FROM crm_contact_suppressions s WHERE s.active AND (
        (s.scope='email' AND s.normalized_scope_value=d.normalized_email) OR
        (s.scope='domain' AND s.normalized_scope_value=d.recipient_domain) OR
        (s.scope='person' AND s.person_id=d.person_id) OR
        (s.scope='organization' AND s.organization_id=d.organization_id) OR
        s.person_email_id=d.person_email_id)) AS suppressed,
      EXISTS(SELECT 1 FROM crm_outreach_provider_operations p
        WHERE p.delivery_id=d.id AND p.operation='add_comment'
          AND p.state IN ('queued','started','indeterminate')) AS pending_operation
     FROM crm_outreach_deliveries d LEFT JOIN crm_tasks t ON t.id=d.task_id
    WHERE d.id=$1`,
    [delivery.id],
  );
  const ineligible = outreachFollowupIneligibilityReason({
    delivery_state: delivery.state,
    replied_at: delivery.replied_at,
    task_state: eligibility.rows[0]?.task_state,
    follow_up_attempt_count: delivery.follow_up_attempt_count,
    max_followups: delivery.max_followups,
    suppressed: eligibility.rows[0]?.suppressed === true,
    pending_operation: eligibility.rows[0]?.pending_operation === true,
  });
  if (ineligible) throw Error(`cannot queue outreach follow-up: ${ineligible}`);
}

function composeOutreachFollowup(
  delivery: CrmOutreachDelivery,
  requestedBody?: string,
): CrmOutreachFollowUpPreview {
  const body =
    requestedBody?.trim() ||
    `Hello ${delivery.recipient_name.split(/\s+/)[0]},\n\nI wanted to follow up on my previous message. Please let us know if a CoCalc adoption pilot would be useful, or if there is someone else we should contact.\n\nBest wishes,\nThe CoCalc Team`;
  if (body.length > 10_000)
    throw Error("follow-up body must be at most 10000 characters");
  const finalReview =
    delivery.follow_up_attempt_count + 1 >= delivery.max_followups;
  const days = finalReview
    ? delivery.final_review_after_days
    : delivery.follow_up_after_days;
  return {
    delivery,
    body,
    zendesk_ticket_id: delivery.zendesk_ticket_id!,
    next_due_at: new Date(Date.now() + days * 86_400_000).toISOString(),
    final_review: finalReview,
    warnings: [
      CRM_OUTREACH_VIEW_CAVEAT,
      "This reviewed message will be added publicly to the existing Zendesk ticket.",
    ],
  };
}

export async function sendOutreachFollowup(
  opts: CrmOutreachFollowUpSendRequest,
): Promise<CrmMutationResult<CrmOutreachDelivery>> {
  assertSeed();
  reason(opts.reason);
  const accountId = actor(opts.account_id);
  const original = await resolveDelivery(getPool(), opts.delivery);
  const preview = composeOutreachFollowup(original, opts.body);
  return await mutate({
    action: "outreach.followup.queue",
    actor: accountId,
    reason: opts.reason,
    commit: opts.commit,
    expectedVersion: opts.expected_version,
    idempotencyKey: opts.idempotency_key,
    organizationId: original.organization_id,
    proposed: {
      delivery_id: original.id,
      zendesk_ticket_id: original.zendesk_ticket_id,
      body: preview.body,
      next_due_at: preview.next_due_at,
      final_review: preview.final_review,
    },
    idempotencyPayload: {
      delivery_id: original.id,
      zendesk_ticket_id: original.zendesk_ticket_id,
      body: preview.body,
    },
    warnings: preview.warnings,
    resultType: "outreach_delivery",
    currentVersion: async (db) =>
      (await resolveDelivery(db, original.id, db !== getPool())).version,
    validate: async (db) => {
      const current = await resolveDelivery(db, original.id, db !== getPool());
      await assertOutreachFollowupEligible(db, current);
    },
    apply: async (db, eventId) => {
      const lockedResult = await db.query(
        "SELECT * FROM crm_outreach_deliveries WHERE id=$1 FOR UPDATE",
        [original.id],
      );
      if (!lockedResult.rows[0]) throw Error("outreach delivery not found");
      const locked = deliveryRow(lockedResult.rows[0]);
      const task = locked.task_id
        ? await db.query("SELECT state FROM crm_tasks WHERE id=$1 FOR UPDATE", [
            locked.task_id,
          ])
        : { rows: [] };
      const suppression = await db.query(
        `SELECT EXISTS(SELECT 1 FROM crm_contact_suppressions s WHERE s.active AND (
          (s.scope='email' AND s.normalized_scope_value=$1) OR
          (s.scope='domain' AND s.normalized_scope_value=$2) OR
          (s.scope='person' AND s.person_id=$3) OR
          (s.scope='organization' AND s.organization_id=$4) OR
          s.person_email_id=$5)) AS suppressed`,
        [
          locked.normalized_email,
          locked.recipient_domain,
          locked.person_id,
          locked.organization_id,
          locked.person_email_id,
        ],
      );
      const pending = await db.query(
        `SELECT EXISTS(SELECT 1 FROM crm_outreach_provider_operations
          WHERE delivery_id=$1 AND operation='add_comment'
            AND state IN ('queued','started','indeterminate')) AS pending`,
        [locked.id],
      );
      const ineligible = outreachFollowupIneligibilityReason({
        delivery_state: locked.state,
        replied_at: locked.replied_at,
        task_state: task.rows[0]?.state,
        follow_up_attempt_count: locked.follow_up_attempt_count,
        max_followups: locked.max_followups,
        suppressed: suppression.rows[0]?.suppressed === true,
        pending_operation: pending.rows[0]?.pending === true,
      });
      if (ineligible) {
        throw Error(`cannot queue outreach follow-up: ${ineligible}`);
      }
      const operationId = randomUUID();
      await db.query(
        `INSERT INTO crm_outreach_provider_operations
          (id,delivery_id,operation,idempotency_key,payload_hash,state,attempt_number,provider_external_id,rate_limit_snapshot,request_payload,not_before,provider_status)
         VALUES($1,$2,'add_comment',$3,$4,'queued',1,$5,'{}'::jsonb,$6,NOW(),$7)`,
        [
          operationId,
          locked.id,
          `followup:${opts.idempotency_key}`,
          digest({ ticket: locked.zendesk_ticket_id, body: preview.body }),
          locked.provider_external_id,
          {
            body: preview.body,
            next_due_at: preview.next_due_at,
            actor_account_id: accountId,
            follow_up_number: locked.follow_up_attempt_count + 1,
          },
          "queued_reviewed_followup",
        ],
      );
      await addActivity(db, {
        organization_id: original.organization_id,
        person_id: original.person_id,
        opportunity_id: original.opportunity_id,
        task_id: original.task_id,
        zendesk_ticket_id: original.zendesk_ticket_id,
        source_id: eventId,
        summary: "Queued reviewed outreach follow-up",
        details: opts.reason,
        actor_account_id: accountId,
        metadata: {
          delivery_id: original.id,
          provider_operation_id: operationId,
        },
      });
      return await resolveDelivery(db, original.id);
    },
  });
}

export async function syncOutreachDelivery(
  opts: CrmOutreachSyncRequest,
): Promise<CrmMutationResult<CrmOutreachDelivery>> {
  return await mutateOutreachDelivery({ ...opts, action: "reconcile" });
}

export async function getOutreachDiagnostics(
  opts: CrmOutreachDiagnosticsRequest,
): Promise<CrmOutreachDiagnostics> {
  assertSeed();
  reason(opts.reason);
  const config = await loadOutreachConfiguration();
  const limits = await getOutreachLimits({ reason: opts.reason });
  const counts = await getPool().query(
    `SELECT
       (SELECT count(*)::int FROM crm_outreach_deliveries WHERE state='queued') AS queued,
       (SELECT count(*)::int FROM crm_outreach_deliveries WHERE state='failed') AS failed,
       (SELECT count(*)::int FROM crm_outreach_provider_operations WHERE state='indeterminate') AS indeterminate,
       (SELECT count(*)::int FROM crm_contact_suppressions WHERE active) AS active_suppressions,
       (SELECT count(*)::int FROM crm_outreach_zendesk_events WHERE state IN ('pending','processing','failed')) AS webhook_backlog,
       (SELECT count(*)::int FROM crm_outreach_zendesk_events WHERE state='dead_letter') AS webhook_dead_letters,
       (SELECT count(*)::int FROM crm_tasks t JOIN crm_outreach_deliveries d ON d.task_id=t.id WHERE t.state IN ('open','waiting') AND t.due_at<NOW()) AS overdue_followups,
       (SELECT count(*)::int FROM crm_outreach_deliveries
         WHERE state='queued' AND queued_at<NOW()-INTERVAL '1 hour') AS stale_queued,
       (SELECT count(*)::int FROM crm_outreach_deliveries
         WHERE state IN ('notification_requested','replied') AND follow_up_policy='no_response' AND task_id IS NULL) AS sent_missing_followup,
       (SELECT count(*)::int FROM crm_outreach_deliveries d JOIN crm_tasks t ON t.id=d.task_id
         WHERE d.replied_at IS NOT NULL AND t.state IN ('open','waiting')) AS replied_open_followup,
       (SELECT count(*)::int FROM crm_outreach_deliveries
         WHERE follow_up_attempt_count>max_followups) AS followup_beyond_maximum,
       (SELECT count(*)::int FROM crm_outreach_deliveries d
         WHERE d.view_observation_count<>(SELECT count(*)::int FROM crm_outreach_engagement_events e WHERE e.delivery_id=d.id)
            OR d.first_view_observed_at IS DISTINCT FROM (SELECT min(e.observed_at) FROM crm_outreach_engagement_events e WHERE e.delivery_id=d.id)
            OR d.last_view_observed_at IS DISTINCT FROM (SELECT max(e.observed_at) FROM crm_outreach_engagement_events e WHERE e.delivery_id=d.id)) AS engagement_projection_mismatch,
       (SELECT min(queued_at) FROM crm_outreach_deliveries WHERE state='queued') AS oldest_queued_at`,
  );
  const worker = await getPool().query(
    "SELECT * FROM crm_outreach_worker_state WHERE provider='zendesk'",
  );
  const row = counts.rows[0];
  const problems: CrmOutreachDiagnostics["problems"] = [];
  const providerConfigurationErrors =
    outreachProviderConfigurationErrors(config);
  if (providerConfigurationErrors.length) {
    problems.push({
      code: "provider_configuration",
      count: providerConfigurationErrors.length,
      detail: providerConfigurationErrors.join("; "),
    });
  }
  const readReceiptsIdentityConfigured =
    config.read_receipts_mode === "ticket_fields"
      ? !!config.read_receipts_ticket_field_ids
      : !!config.read_receipts_integration_id;
  if (config.read_receipts_enabled && !readReceiptsIdentityConfigured) {
    problems.push({
      code: "read_receipts_configuration",
      count: 1,
      detail:
        "View observations are enabled without a configured Zendesk field or pinned integration identity.",
    });
  }
  for (const [code, count, detail] of [
    [
      "failed_deliveries",
      row.failed,
      "Deliveries require reviewed retry or correction.",
    ],
    [
      "indeterminate_operations",
      row.indeterminate,
      "Provider effects must be reconciled before retry.",
    ],
    [
      "webhook_backlog",
      row.webhook_backlog,
      "Zendesk events await processing.",
    ],
    [
      "overdue_followups",
      row.overdue_followups,
      "Shared no-response tasks are overdue.",
    ],
    [
      "webhook_dead_letters",
      row.webhook_dead_letters,
      "Zendesk webhook events exhausted bounded retries.",
    ],
    [
      "stale_queued",
      row.stale_queued,
      "Outreach deliveries have remained queued for more than one hour.",
    ],
    [
      "sent_missing_followup",
      row.sent_missing_followup,
      "Sent no-response outreach is missing its shared follow-up task.",
    ],
    [
      "replied_open_followup",
      row.replied_open_followup,
      "Prospect replies still have an open or waiting no-response task.",
    ],
    [
      "followup_beyond_maximum",
      row.followup_beyond_maximum,
      "A delivery exceeds its reviewed follow-up maximum.",
    ],
    [
      "engagement_projection_mismatch",
      row.engagement_projection_mismatch,
      "Projected view-observation fields disagree with immutable engagement events.",
    ],
  ] as Array<[string, number, string]>)
    if (count) problems.push({ code, count, detail });
  const diagnostics: CrmOutreachDiagnostics = {
    checked_at: new Date().toISOString(),
    configured: {
      submitter_id: !!config.submitter_id,
      group_id: !!config.group_id,
      form_id: !!config.form_id,
      support_address: !!config.support_address,
      postal_address: !!config.postal_address,
      footer: !!config.footer_markdown,
      webhook_secret: !!config.webhook_secret,
      read_receipts_mode: config.read_receipts_mode,
      read_receipts_identity: readReceiptsIdentityConfigured,
    },
    limits,
    counts: {
      queued: row.queued,
      failed: row.failed,
      indeterminate: row.indeterminate,
      active_suppressions: row.active_suppressions,
      webhook_backlog: row.webhook_backlog,
      webhook_dead_letters: row.webhook_dead_letters,
      overdue_followups: row.overdue_followups,
      stale_queued: row.stale_queued,
      sent_missing_followup: row.sent_missing_followup,
      replied_open_followup: row.replied_open_followup,
      followup_beyond_maximum: row.followup_beyond_maximum,
      engagement_projection_mismatch: row.engagement_projection_mismatch,
    },
    oldest_queued_at: iso(row.oldest_queued_at),
    worker_heartbeat_at: iso(worker.rows[0]?.heartbeat_at),
    provider_backoff_until: iso(worker.rows[0]?.not_before),
    problems,
  };
  updateOutreachQueueMetrics(diagnostics);
  return diagnostics;
}
