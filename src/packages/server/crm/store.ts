/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createHash, randomUUID } from "node:crypto";

import getPool, { type PoolClient } from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterSeedBayId } from "@cocalc/server/cluster-config";
import { createCommercialOrder } from "@cocalc/server/commercial-orders/store";
import {
  COMMERCIAL_COLLECTION_MODES,
  COMMERCIAL_NEXT_ACTIONS,
} from "@cocalc/util/commercial-orders";
import type {
  CrmActivityCreateRequest,
  CrmBackfillRequest,
  CrmBackfillResponse,
  CrmDailyDigestRequest,
  CrmDiagnosticsRequest,
  CrmDomainMutationRequest,
  CrmExportRequest,
  CrmExportResponse,
  CrmExternalReferenceListRequest,
  CrmExternalReferenceListResponse,
  CrmExternalReferenceMutationRequest,
  CrmMetricsRequest,
  CrmOpportunityCreateRequest,
  CrmOpportunityListRequest,
  CrmOpportunityListResponse,
  CrmOpportunityTransitionRequest,
  CrmOpportunityUpdateRequest,
  CrmOrderFromOpportunityRequest,
  CrmOrganizationArchiveRequest,
  CrmOrganizationCreateRequest,
  CrmOrganizationGetRequest,
  CrmOrganizationListRequest,
  CrmOrganizationListResponse,
  CrmOrganizationMergeRequest,
  CrmOrganizationPersonMutationRequest,
  CrmOrganizationQueueFilters,
  CrmOrganizationSearchRequest,
  CrmOrganizationUpdateRequest,
  CrmPersonAccountMutationRequest,
  CrmPersonCreateRequest,
  CrmPersonEmailMutationRequest,
  CrmPersonGetRequest,
  CrmPersonListRequest,
  CrmPersonListResponse,
  CrmPersonUpdateRequest,
  CrmSupportContextRequest,
  CrmTaskCreateRequest,
  CrmTaskListRequest,
  CrmTaskListResponse,
  CrmTaskTransitionRequest,
  CrmTaskUpdateRequest,
  CrmTimelineRequest,
  CrmTimelineResponse,
} from "@cocalc/conat/hub/api/crm";
import type {
  CrmActivity,
  CrmBackfillCandidate,
  CrmCustomer360,
  CrmCustomerMetrics,
  CrmDailyDigest,
  CrmDiagnostics,
  CrmExternalReference,
  CrmMutationResult,
  CrmOpportunity,
  CrmOpportunityKind,
  CrmOpportunityStage,
  CrmOrganization,
  CrmOrganizationDomain,
  CrmOrganizationPerson,
  CrmOrganizationSummary,
  CrmPerson,
  CrmPersonAccount,
  CrmPersonEmail,
  CrmSupportCustomerContext,
  CrmSupportCustomerEvidence,
  CrmTask,
} from "@cocalc/util/crm";
import {
  CRM_SCHEMA_CONTRACT_VERSION,
  CRM_DOMAIN_KINDS,
  CRM_DOMAIN_STATES,
  CRM_EXTERNAL_OBJECT_KINDS,
  CRM_EXTERNAL_PROVIDERS,
  CRM_EXTERNAL_REFERENCE_VERIFICATION_STATES,
  CRM_LIFECYCLE_STAGES,
  CRM_OPPORTUNITY_KINDS,
  CRM_OPPORTUNITY_STAGES,
  CRM_ORGANIZATION_TYPES,
  CRM_PERSON_ROLES,
  CRM_TASK_PRIORITIES,
  CRM_TASK_TYPES,
} from "@cocalc/util/crm";
import { isValidUUID } from "@cocalc/util/misc";
import { getCrmRuntimeContract } from "./runtime-contract";

type Queryable = PoolClient | ReturnType<typeof getPool>;
type Json = Record<string, unknown>;

const MAX_LIST = 500;
const MAX_BYTES = 5_000_000;
const GENERIC_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "proton.me",
  "protonmail.com",
]);

function assertSeedAuthority(): void {
  const current = getConfiguredBayId();
  const seed = getConfiguredClusterSeedBayId();
  if (current !== seed) {
    throw Error(
      `CRM is seed-global; operation reached ${current}, expected ${seed}`,
    );
  }
}

function requireReason(reason: unknown): string {
  const value = `${reason ?? ""}`.trim();
  if (value.length < 4)
    throw Error("a human-readable audit reason is required");
  if (value.length > 2_000)
    throw Error("audit reason must be at most 2000 characters");
  return value;
}

function requireActor(accountId: unknown): string {
  const value = `${accountId ?? ""}`.trim();
  if (!value) throw Error("account_id is required");
  return value;
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

function normalizeHttpUrl(value: unknown, name: string): string | null {
  const text = optionalBounded(value, name, 2_000);
  if (text == null) return null;
  const candidate = /^[a-z][a-z\d+.-]*:(?!\d)/i.test(text)
    ? text
    : `https://${text}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw Error(`${name} must be a valid HTTP or HTTPS URL`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw Error(`${name} must use HTTP or HTTPS`);
  }
  if (!url.hostname || url.username || url.password) {
    throw Error(
      `${name} must be a public HTTP or HTTPS URL without credentials`,
    );
  }
  return bounded(url.toString(), name, 2_000);
}

function normalizeWebsite(value: unknown): string | null {
  return normalizeHttpUrl(value, "website");
}

function normalizePersonNote(value: unknown): string | null {
  const note = optionalBounded(value, "note", 20_000);
  assertSafeText(note, "note");
  return note;
}

function assertSafeText(value: unknown, name: string): void {
  const text = `${value ?? ""}`;
  if (/\b(?:card number|cvv|cvc|bank password|private key)\b/i.test(text)) {
    throw Error(`${name} appears to contain payment credentials or a secret`);
  }
}

function assertEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): T {
  if (!(allowed as readonly unknown[]).includes(value)) {
    throw Error(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
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

function rfc3339TimestampRequired(value: unknown, name: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      raw,
    )
  ) {
    throw Error(
      `${name} must be an RFC3339 timestamp with an explicit timezone, e.g. 2026-09-01T17:00:00Z`,
    );
  }
  const [hour, minute, second] = raw.slice(11, 19).split(":").map(Number);
  if (hour > 23 || minute > 59 || second > 59) {
    throw Error(`${name} must be a valid RFC3339 timestamp`);
  }
  const calendarDate = new Date(`${raw.slice(0, 10)}T00:00:00.000Z`);
  if (
    !Number.isFinite(calendarDate.valueOf()) ||
    calendarDate.toISOString().slice(0, 10) !== raw.slice(0, 10)
  ) {
    throw Error(`${name} must be a valid RFC3339 timestamp`);
  }
  const timestamp = new Date(raw);
  if (!Number.isFinite(timestamp.valueOf())) {
    throw Error(`${name} must be a valid RFC3339 timestamp`);
  }
  return timestamp.toISOString();
}

function dateOnly(value: unknown): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    const result = value.slice(0, 10);
    const parsed = new Date(`${result}T00:00:00.000Z`);
    if (
      Number.isFinite(parsed.valueOf()) &&
      parsed.toISOString().slice(0, 10) === result
    )
      return result;
    throw Error("invalid date");
  }
  return isoRequired(value).slice(0, 10);
}

function normalizeDomain(value: unknown): string {
  const raw = `${value ?? ""}`.trim().toLowerCase().replace(/^@/, "");
  if (
    raw.length > 253 ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
      raw,
    )
  ) {
    throw Error("domain must be a valid DNS domain name");
  }
  return raw;
}

function normalizeEmail(value: unknown): string {
  const email = `${value ?? ""}`.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw Error("email must be a valid email address");
  }
  return email;
}

function normalizeMoney(value: unknown): string {
  const raw = `${value ?? "0"}`.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,10})?$/.test(raw)) {
    throw Error("expected_value must be a nonnegative decimal amount");
  }
  return Number(raw).toFixed(10);
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

function payloadHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}

function pageLimit(limit: unknown): number {
  const value = Number(limit ?? 100);
  if (!Number.isInteger(value) || value < 1)
    throw Error("limit must be a positive integer");
  return Math.min(value, MAX_LIST);
}

function byteLimit(value: unknown): number {
  const parsed = Number(value ?? 1_000_000);
  if (!Number.isInteger(parsed) || parsed < 10_000) {
    throw Error("max_bytes must be an integer of at least 10000");
  }
  return Math.min(parsed, MAX_BYTES);
}

function encodeCursor(updatedAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ updated_at: updatedAt, id })).toString(
    "base64url",
  );
}

function decodeCursor(
  cursor?: string,
): { updated_at: string; id: string } | undefined {
  if (!cursor) return;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof value.updated_at !== "string" || typeof value.id !== "string")
      throw Error();
    return value;
  } catch {
    throw Error("invalid CRM cursor");
  }
}

type ExternalReferenceCursor = Pick<
  CrmExternalReference,
  "provider" | "object_kind" | "external_id"
>;

function encodeExternalReferenceCursor({
  provider,
  object_kind,
  external_id,
}: ExternalReferenceCursor): string {
  return Buffer.from(
    JSON.stringify({ provider, object_kind, external_id }),
  ).toString("base64url");
}

function decodeExternalReferenceCursor(
  cursor?: string,
): ExternalReferenceCursor | undefined {
  if (!cursor) return;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof value.provider !== "string" ||
      typeof value.object_kind !== "string" ||
      typeof value.external_id !== "string"
    ) {
      throw Error();
    }
    assertEnum(value.provider, CRM_EXTERNAL_PROVIDERS, "cursor provider");
    assertEnum(
      value.object_kind,
      CRM_EXTERNAL_OBJECT_KINDS,
      "cursor object_kind",
    );
    if (!value.external_id || value.external_id.length > 500) throw Error();
    return value as ExternalReferenceCursor;
  } catch {
    throw Error("invalid CRM external-reference cursor");
  }
}

function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function truncateRows<T>(
  rows: T[],
  maxBytes: number,
): { rows: T[]; bytes: number; truncated: boolean } {
  const result: T[] = [];
  let bytes = 2;
  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
    if (bytes + size > maxBytes)
      return { rows: result, bytes, truncated: true };
    result.push(row);
    bytes += size;
  }
  return { rows: result, bytes, truncated: false };
}

function organizationRow(row: any): CrmOrganization {
  return {
    ...row,
    aliases: row.aliases ?? [],
    created_at: isoRequired(row.created_at),
    updated_at: isoRequired(row.updated_at),
  };
}

function domainRow(row: any): CrmOrganizationDomain {
  return {
    ...row,
    created_at: isoRequired(row.created_at),
    updated_at: isoRequired(row.updated_at),
    verified_at: iso(row.verified_at),
    retired_at: iso(row.retired_at),
  };
}

function emailRow(row: any): CrmPersonEmail {
  return {
    ...row,
    created_at: isoRequired(row.created_at),
    updated_at: isoRequired(row.updated_at),
  };
}

function accountRow(row: any): CrmPersonAccount {
  return {
    ...row,
    created_at: isoRequired(row.created_at),
    updated_at: isoRequired(row.updated_at),
  };
}

function relationshipRow(row: any): CrmOrganizationPerson {
  return {
    ...row,
    roles: row.roles ?? [],
    created_at: isoRequired(row.created_at),
    updated_at: isoRequired(row.updated_at),
  };
}

function opportunityRow(row: any): CrmOpportunity {
  return {
    ...row,
    expected_value: `${row.expected_value ?? "0"}`,
    expected_close_date: dateOnly(row.expected_close_date),
    service_starts_at: iso(row.service_starts_at),
    service_ends_at: iso(row.service_ends_at),
    source_zendesk_ticket_ids: row.source_zendesk_ticket_ids ?? [],
    created_at: isoRequired(row.created_at),
    updated_at: isoRequired(row.updated_at),
  };
}

function taskRow(row: any): CrmTask {
  return {
    ...row,
    due_at: isoRequired(row.due_at),
    created_at: isoRequired(row.created_at),
    updated_at: isoRequired(row.updated_at),
    completed_at: iso(row.completed_at),
    cancelled_at: iso(row.cancelled_at),
  };
}

function externalReferenceRow(row: any): CrmExternalReference {
  return {
    ...row,
    metadata: row.metadata ?? {},
    created_at: isoRequired(row.created_at),
    updated_at: isoRequired(row.updated_at),
  };
}

function externalReferenceListItem(
  row: any,
): CrmExternalReferenceListResponse["external_references"][number] {
  const {
    organization_customer_number,
    organization_display_name,
    ...reference
  } = row;
  return {
    reference: externalReferenceRow(reference),
    organization: {
      id: row.organization_id,
      customer_number: organization_customer_number,
      display_name: organization_display_name,
    },
  };
}

function activityRow(row: any): CrmActivity {
  return {
    ...row,
    metadata: row.metadata ?? {},
    occurred_at: isoRequired(row.occurred_at),
    created_at: isoRequired(row.created_at),
  };
}

async function withTransaction<T>(
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

async function prepareRead(reason: unknown): Promise<void> {
  assertSeedAuthority();
  requireReason(reason);
}

async function resolveOrganizationId(
  db: Queryable,
  selector: string,
): Promise<string> {
  const value = bounded(selector, "organization", 500);
  const normalizedDomain = value.replace(/^@/, "").toLowerCase();
  const { rows } = await db.query<{
    id: string;
    customer_number: string;
    display_name: string;
  }>(
    `SELECT DISTINCT o.id,o.customer_number,o.display_name
       FROM crm_organizations o
       LEFT JOIN crm_organization_domains d ON d.organization_id=o.id
      WHERE o.id::text=$1 OR lower(o.customer_number)=lower($1)
         OR lower(o.display_name)=lower($1) OR lower(COALESCE(o.legal_name,''))=lower($1)
         OR lower($1)=ANY(SELECT lower(x) FROM unnest(o.aliases) x)
         OR d.normalized_domain=$2
      ORDER BY o.display_name LIMIT 11`,
    [value, normalizedDomain],
  );
  if (rows.length === 0)
    throw Object.assign(Error(`CRM organization '${value}' was not found`), {
      code: 404,
    });
  if (rows.length > 1) {
    throw Object.assign(
      Error(
        `CRM organization selector '${value}' is ambiguous: ${rows
          .slice(0, 10)
          .map((x) => `${x.customer_number} ${x.display_name}`)
          .join(", ")}`,
      ),
      { code: 409, candidates: rows.slice(0, 10) },
    );
  }
  return rows[0].id;
}

async function resolvePersonId(
  db: Queryable,
  selector: string,
): Promise<string> {
  const value = bounded(selector, "person", 500);
  const { rows } = await db.query<{ id: string; display_name: string }>(
    `SELECT DISTINCT p.id,p.display_name FROM crm_people p
       LEFT JOIN crm_person_emails e ON e.person_id=p.id
      WHERE p.id::text=$1 OR lower(p.display_name)=lower($1) OR e.normalized_email=lower($1)
      ORDER BY p.display_name LIMIT 11`,
    [value],
  );
  if (rows.length === 0)
    throw Object.assign(Error(`CRM person '${value}' was not found`), {
      code: 404,
    });
  if (rows.length > 1)
    throw Object.assign(Error(`CRM person selector '${value}' is ambiguous`), {
      code: 409,
      candidates: rows,
    });
  return rows[0].id;
}

async function assertPersonOrganizationRelationship(
  db: Queryable,
  organizationId: string,
  personId: string,
  lock = false,
): Promise<void> {
  const { rows } = await db.query(
    `SELECT id FROM crm_organization_people
      WHERE organization_id=$1 AND person_id=$2
      ${lock ? "FOR SHARE" : ""}`,
    [organizationId, personId],
  );
  if (rows[0]) return;
  throw Object.assign(
    Error(
      "a person external reference requires a relationship to the selected organization",
    ),
    { code: 409 },
  );
}

async function assertPersonRelationshipCanBeUnlinked(
  db: Queryable,
  organizationId: string,
  personId: string,
  lock = false,
): Promise<void> {
  if (lock) {
    await db.query(
      `SELECT id FROM crm_organization_people
        WHERE organization_id=$1 AND person_id=$2
        FOR UPDATE`,
      [organizationId, personId],
    );
  }
  const { rows } = await db.query(
    `SELECT id FROM crm_external_references
      WHERE organization_id=$1 AND person_id=$2
      LIMIT 1`,
    [organizationId, personId],
  );
  if (!rows[0]) return;
  throw Object.assign(
    Error(
      "remove the person's external references before unlinking the organization relationship",
    ),
    { code: 409 },
  );
}

async function assertOpportunityOrganization(
  db: Queryable,
  organizationId: string,
  opportunityId: string,
  lock = false,
): Promise<void> {
  const { rows } = await db.query(
    `SELECT id FROM crm_opportunities
      WHERE id=$1 AND organization_id=$2
      ${lock ? "FOR SHARE" : ""}`,
    [opportunityId, organizationId],
  );
  if (rows[0]) return;
  throw Object.assign(
    Error("the selected opportunity does not belong to the organization"),
    { code: 409 },
  );
}

async function resolveOpportunityId(
  db: Queryable,
  selector: string,
): Promise<string> {
  const value = bounded(selector, "opportunity", 500);
  const { rows } = await db.query<{ id: string; name: string }>(
    `SELECT id,name FROM crm_opportunities WHERE id::text=$1 OR lower(name)=lower($1) LIMIT 11`,
    [value],
  );
  if (rows.length === 0)
    throw Object.assign(Error(`CRM opportunity '${value}' was not found`), {
      code: 404,
    });
  if (rows.length > 1)
    throw Object.assign(
      Error(`CRM opportunity selector '${value}' is ambiguous`),
      { code: 409, candidates: rows },
    );
  return rows[0].id;
}

async function resolveTaskId(db: Queryable, selector: string): Promise<string> {
  const value = bounded(selector, "task", 500);
  const { rows } = await db.query<{ id: string; subject: string }>(
    `SELECT id,subject FROM crm_tasks WHERE id::text=$1 OR lower(subject)=lower($1) LIMIT 11`,
    [value],
  );
  if (rows.length === 0)
    throw Object.assign(Error(`CRM task '${value}' was not found`), {
      code: 404,
    });
  if (rows.length > 1)
    throw Object.assign(Error(`CRM task selector '${value}' is ambiguous`), {
      code: 409,
      candidates: rows,
    });
  return rows[0].id;
}

async function loadOrganization(
  db: Queryable,
  id: string,
  lock = false,
): Promise<CrmOrganization> {
  const { rows } = await db.query(
    `SELECT * FROM crm_organizations WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`,
    [id],
  );
  if (!rows[0])
    throw Object.assign(Error("CRM organization was not found"), { code: 404 });
  return organizationRow(rows[0]);
}

async function loadPerson(
  db: Queryable,
  id: string,
  lock = false,
): Promise<CrmPerson> {
  const { rows } = await db.query(
    `SELECT * FROM crm_people WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`,
    [id],
  );
  if (!rows[0])
    throw Object.assign(Error("CRM person was not found"), { code: 404 });
  const [emails, accounts, organizations] = await Promise.all([
    db.query(
      "SELECT * FROM crm_person_emails WHERE person_id=$1 ORDER BY is_primary DESC,email_address",
      [id],
    ),
    db.query(
      "SELECT * FROM crm_person_accounts WHERE person_id=$1 ORDER BY created_at",
      [id],
    ),
    db.query(
      "SELECT * FROM crm_organization_people WHERE person_id=$1 ORDER BY created_at",
      [id],
    ),
  ]);
  return {
    ...rows[0],
    created_at: isoRequired(rows[0].created_at),
    updated_at: isoRequired(rows[0].updated_at),
    emails: emails.rows.map(emailRow),
    accounts: accounts.rows.map(accountRow),
    organizations: organizations.rows.map(relationshipRow),
  };
}

async function loadOpportunity(
  db: Queryable,
  id: string,
  lock = false,
): Promise<CrmOpportunity> {
  const { rows } = await db.query(
    `SELECT * FROM crm_opportunities WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`,
    [id],
  );
  if (!rows[0])
    throw Object.assign(Error("CRM opportunity was not found"), { code: 404 });
  return opportunityRow(rows[0]);
}

async function loadTask(
  db: Queryable,
  id: string,
  lock = false,
): Promise<CrmTask> {
  const { rows } = await db.query(
    `SELECT * FROM crm_tasks WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`,
    [id],
  );
  if (!rows[0])
    throw Object.assign(Error("CRM task was not found"), { code: 404 });
  return taskRow(rows[0]);
}

async function insertActivity(
  client: PoolClient,
  input: Omit<CrmActivity, "id" | "created_at" | "metadata"> & {
    metadata?: Json;
  },
): Promise<CrmActivity> {
  const id = randomUUID();
  const { rows } = await client.query(
    `INSERT INTO crm_activities
      (id,organization_id,person_id,opportunity_id,task_id,commercial_order_id,
       site_license_id,zendesk_ticket_id,kind,source,source_id,summary,details,
       actor_account_id,occurred_at,supersedes_activity_id,metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (organization_id,source,source_id) DO UPDATE SET source_id=EXCLUDED.source_id
     RETURNING *`,
    [
      id,
      input.organization_id,
      input.person_id ?? null,
      input.opportunity_id ?? null,
      input.task_id ?? null,
      input.commercial_order_id ?? null,
      input.site_license_id ?? null,
      input.zendesk_ticket_id ?? null,
      input.kind,
      input.source,
      input.source_id,
      bounded(input.summary, "activity summary", 1_000),
      optionalBounded(input.details, "activity details", 10_000),
      input.actor_account_id ?? null,
      input.occurred_at,
      input.supersedes_activity_id ?? null,
      input.metadata ?? {},
    ],
  );
  return activityRow(rows[0]);
}

type MutationOptions<T> = {
  action: string;
  target?: string;
  actor: string;
  reason: string;
  commit?: boolean;
  expectedVersion?: number;
  idempotencyKey?: string;
  organizationId?: string | null;
  proposed: Partial<T> | Json;
  warnings?: string[];
  currentVersion: (db: Queryable) => Promise<number>;
  apply: (client: PoolClient, eventId: string) => Promise<T>;
  resultType: string;
};

function mutationPayloadHash({
  action,
  target,
  proposed,
}: Pick<MutationOptions<unknown>, "action" | "target" | "proposed">): string {
  return payloadHash({ action, target: target ?? null, proposed });
}

async function mutate<T>(
  opts: MutationOptions<T>,
): Promise<CrmMutationResult<T>> {
  assertSeedAuthority();
  const reason = requireReason(opts.reason);
  const actor = requireActor(opts.actor);
  const hash = mutationPayloadHash(opts);
  const key =
    `${opts.idempotencyKey ?? `crm:${opts.action}:${hash.slice(0, 24)}`}`.slice(
      0,
      500,
    );
  if (!opts.commit) {
    return {
      preview: true,
      action: opts.action,
      expected_version: await opts.currentVersion(getPool()),
      proposed: opts.proposed,
      warnings: opts.warnings ?? [],
      idempotency_key: key,
    };
  }
  if (opts.expectedVersion == null || !Number.isInteger(opts.expectedVersion)) {
    throw Error("expected_version is required for a committed CRM mutation");
  }
  if (!opts.idempotencyKey?.trim()) {
    throw Error("idempotency_key is required for a committed CRM mutation");
  }
  return await withTransaction(async (client) => {
    const replay = await client.query<{ payload_hash: string; metadata: Json }>(
      `SELECT payload_hash,metadata FROM crm_mutation_events
        WHERE actor_account_id=$1 AND action=$2 AND idempotency_key=$3`,
      [actor, opts.action, key],
    );
    if (replay.rows[0]) {
      if (replay.rows[0].payload_hash !== hash) {
        throw Object.assign(
          Error(
            "idempotency key was already used with a different CRM mutation",
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
    const currentVersion = await opts.currentVersion(client);
    if (currentVersion !== opts.expectedVersion) {
      throw Object.assign(
        Error(
          `CRM record changed: expected version ${opts.expectedVersion}, current version is ${currentVersion}`,
        ),
        {
          code: 409,
          expected_version: opts.expectedVersion,
          current_version: currentVersion,
        },
      );
    }
    const eventId = randomUUID();
    const result = await opts.apply(client, eventId);
    const metadata = { result };
    if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > 200_000) {
      throw Error("CRM mutation result is too large to audit safely");
    }
    await client.query(
      `INSERT INTO crm_mutation_events
       (id,organization_id,actor_account_id,action,reason,idempotency_key,payload_hash,result_type,result_id,metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        eventId,
        opts.organizationId ?? null,
        actor,
        opts.action,
        reason,
        key,
        hash,
        opts.resultType,
        (result as any)?.id ?? null,
        metadata,
      ],
    );
    return { preview: false, action: opts.action, replayed: false, result };
  });
}

async function summaryForOrganization(
  db: Queryable,
  organization: CrmOrganization,
): Promise<CrmOrganizationSummary> {
  const [domains, contacts, opportunityCount, nextTask, latest, outstanding] =
    await Promise.all([
      db.query<{ normalized_domain: string }>(
        "SELECT normalized_domain FROM crm_organization_domains WHERE organization_id=$1 AND state='verified' ORDER BY kind,normalized_domain",
        [organization.id],
      ),
      db.query<{ id: string; display_name: string }>(
        `SELECT p.id,p.display_name FROM crm_organization_people r JOIN crm_people p ON p.id=r.person_id
        WHERE r.organization_id=$1 AND r.state='active' AND 'primary_contact'=ANY(r.roles)
        ORDER BY p.display_name LIMIT 10`,
        [organization.id],
      ),
      db.query<{ count: string; kinds: CrmOpportunityKind[] }>(
        `SELECT count(*)::text AS count,
                COALESCE(array_agg(DISTINCT kind ORDER BY kind), ARRAY[]::text[]) AS kinds
           FROM crm_opportunities
          WHERE organization_id=$1 AND stage NOT IN ('won','lost')`,
        [organization.id],
      ),
      db.query(
        "SELECT * FROM crm_tasks WHERE organization_id=$1 AND state IN ('open','waiting') ORDER BY due_at,id LIMIT 1",
        [organization.id],
      ),
      db.query<{ occurred_at: Date | string }>(
        "SELECT occurred_at FROM crm_activities WHERE organization_id=$1 ORDER BY occurred_at DESC,id DESC LIMIT 1",
        [organization.id],
      ),
      db.query<{ amount: string }>(
        `SELECT COALESCE(sum(GREATEST(i.amount_due-i.amount_paid,0)),0)::text AS amount
         FROM commercial_invoices i JOIN commercial_orders o ON o.id=i.commercial_order_id
        WHERE o.crm_organization_id=$1 AND i.status IN ('open','creating','draft')`,
        [organization.id],
      ),
    ]);
  return {
    ...organization,
    verified_domains: domains.rows.map((x) => x.normalized_domain),
    primary_contacts: contacts.rows,
    open_opportunity_count: Number(opportunityCount.rows[0]?.count ?? 0),
    open_opportunity_kinds: opportunityCount.rows[0]?.kinds ?? [],
    next_task: nextTask.rows[0] ? taskRow(nextTask.rows[0]) : null,
    latest_activity_at: iso(latest.rows[0]?.occurred_at),
    outstanding_receivables: `${outstanding.rows[0]?.amount ?? "0"}`,
  };
}

function appendOrganizationQueueFilters(
  opts: CrmOrganizationQueueFilters,
  values: unknown[],
  clauses: string[],
): void {
  const add = (clause: string, value: unknown) => {
    values.push(value);
    clauses.push(clause.replace("?", `$${values.length}`));
  };
  if (opts.lifecycle_stages?.length) {
    add("o.lifecycle_stage=ANY(?::text[])", opts.lifecycle_stages);
  }
  if (opts.statuses?.length) {
    add("o.status=ANY(?::text[])", opts.statuses);
  }
  if (opts.organization_types?.length) {
    add("o.organization_type=ANY(?::text[])", opts.organization_types);
  }
  const openOpportunityKinds = opts.opportunity_kinds?.length
    ? "EXISTS (SELECT 1 FROM crm_opportunities q WHERE q.organization_id=o.id AND q.kind=ANY(?::text[]) AND q.stage NOT IN ('won','lost'))"
    : undefined;
  const wonActiveSiteLicenseOffer = opts.include_won_active_site_license_offers
    ? `EXISTS (
         SELECT 1
           FROM crm_opportunities q
           JOIN commercial_orders co ON co.id=q.commercial_order_id
           JOIN site_licenses sl
             ON sl.id=co.site_license_id
             OR (co.site_license_id IS NULL AND sl.metadata->>'commercial_order_id'=co.id::text)
          WHERE q.organization_id=o.id
            AND q.kind='new_site_license'
            AND q.stage='won'
            AND (sl.starts_at IS NULL OR sl.starts_at<=NOW())
            AND (sl.expires_at IS NULL OR sl.expires_at>NOW())
       )`
    : undefined;
  if (openOpportunityKinds && wonActiveSiteLicenseOffer) {
    add(
      `(${openOpportunityKinds} OR ${wonActiveSiteLicenseOffer})`,
      opts.opportunity_kinds,
    );
  } else if (openOpportunityKinds) {
    add(openOpportunityKinds, opts.opportunity_kinds);
  } else if (wonActiveSiteLicenseOffer) {
    clauses.push(wonActiveSiteLicenseOffer);
  }
  if (opts.owner_account_id === null || opts.unassigned) {
    clauses.push("o.relationship_owner_account_id IS NULL");
  } else if (opts.owner_account_id) {
    add("o.relationship_owner_account_id=?::uuid", opts.owner_account_id);
  }
  if (opts.has_overdue_tasks) {
    clauses.push(
      "EXISTS (SELECT 1 FROM crm_tasks t WHERE t.organization_id=o.id AND t.state IN ('open','waiting') AND t.due_at<NOW())",
    );
  }
}

export async function listOrganizations(
  opts: CrmOrganizationListRequest,
): Promise<CrmOrganizationListResponse> {
  await prepareRead(opts.reason);
  const limit = pageLimit(opts.limit);
  const maxBytes = byteLimit(opts.max_bytes);
  const values: unknown[] = [];
  const where: string[] = [];
  if (opts.search?.trim()) {
    const query = `%${opts.search.trim()}%`;
    values.push(query);
    where.push(
      `(o.display_name ILIKE $${values.length} OR o.legal_name ILIKE $${values.length} OR o.customer_number ILIKE $${values.length} OR EXISTS (SELECT 1 FROM unnest(o.aliases) a WHERE a ILIKE $${values.length}))`,
    );
  }
  appendOrganizationQueueFilters(opts, values, where);
  const cursor = decodeCursor(opts.cursor);
  if (cursor) {
    values.push(cursor.updated_at, cursor.id);
    where.push(
      `(o.updated_at,o.id)<($${values.length - 1}::timestamptz,$${values.length}::uuid)`,
    );
  }
  values.push(limit + 1);
  const { rows } = await getPool().query(
    `SELECT o.* FROM crm_organizations o ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY o.updated_at DESC,o.id DESC LIMIT $${values.length}`,
    values,
  );
  const hasMore = rows.length > limit;
  const organizations = await Promise.all(
    rows
      .slice(0, limit)
      .map((row) => summaryForOrganization(getPool(), organizationRow(row))),
  );
  const boundedRows = truncateRows(organizations, maxBytes);
  const last = boundedRows.rows.at(-1);
  return {
    organizations: boundedRows.rows,
    next_cursor:
      last && (hasMore || boundedRows.truncated)
        ? encodeCursor(last.updated_at, last.id)
        : undefined,
    truncated: hasMore || boundedRows.truncated,
    result_bytes: boundedRows.bytes,
  };
}

export async function searchOrganizations(
  opts: CrmOrganizationSearchRequest,
): Promise<CrmOrganizationListResponse> {
  await prepareRead(opts.reason);
  const selector =
    `${opts.query ?? opts.domain ?? opts.email ?? opts.commercial_order ?? opts.site_license_id ?? ""}`.trim();
  const limit = pageLimit(opts.limit);
  const values: unknown[] = [];
  const clauses: string[] = [];
  const linkedSiteLicense = `(sl.crm_organization_id=o.id OR
    (sl.crm_organization_id IS NULL AND EXISTS (
      SELECT 1 FROM commercial_orders co
       WHERE co.crm_organization_id=o.id
         AND (co.site_license_id=sl.id OR
              (co.site_license_id IS NULL AND sl.metadata->>'commercial_order_id'=co.id::text))
    )))`;
  if (selector) {
    values.push(`%${selector.replace(/^@/, "")}%`);
    clauses.push(
      `(o.id::text ILIKE $1 OR o.display_name ILIKE $1 OR o.legal_name ILIKE $1 OR o.customer_number ILIKE $1
        OR EXISTS (SELECT 1 FROM unnest(o.aliases) a WHERE a ILIKE $1)
        OR EXISTS (SELECT 1 FROM crm_organization_domains d WHERE d.organization_id=o.id AND d.normalized_domain ILIKE $1)
        OR EXISTS (SELECT 1 FROM crm_organization_people r JOIN crm_people p ON p.id=r.person_id LEFT JOIN crm_person_emails e ON e.person_id=p.id LEFT JOIN crm_person_accounts pa ON pa.person_id=p.id WHERE r.organization_id=o.id AND (p.display_name ILIKE $1 OR e.normalized_email ILIKE $1 OR pa.account_id::text ILIKE $1))
        OR EXISTS (SELECT 1 FROM crm_external_references x WHERE x.organization_id=o.id AND (x.external_id ILIKE $1 OR x.label ILIKE $1))
        OR EXISTS (SELECT 1 FROM commercial_orders co WHERE co.crm_organization_id=o.id AND (co.id::text ILIKE $1 OR co.order_number ILIKE $1))
        OR EXISTS (SELECT 1 FROM site_licenses sl WHERE ${linkedSiteLicense} AND (sl.id::text ILIKE $1 OR sl.name ILIKE $1)))`,
    );
  }
  if (opts.linked_account_id) {
    values.push(opts.linked_account_id);
    clauses.push(
      `EXISTS (SELECT 1 FROM crm_organization_people r JOIN crm_person_accounts a ON a.person_id=r.person_id WHERE r.organization_id=o.id AND a.account_id=$${values.length}::uuid)`,
    );
  }
  if (opts.zendesk_ticket_id != null) {
    values.push(`${opts.zendesk_ticket_id}`);
    clauses.push(
      `EXISTS (SELECT 1 FROM crm_external_references x WHERE x.organization_id=o.id AND x.provider='zendesk' AND x.object_kind='ticket' AND x.external_id=$${values.length})`,
    );
  }
  if (opts.commercial_order) {
    values.push(opts.commercial_order);
    clauses.push(
      `EXISTS (SELECT 1 FROM commercial_orders co WHERE co.crm_organization_id=o.id AND (co.id::text=$${values.length} OR lower(co.order_number)=lower($${values.length})))`,
    );
  }
  if (opts.site_license_id) {
    values.push(opts.site_license_id);
    clauses.push(
      `EXISTS (SELECT 1 FROM site_licenses sl WHERE ${linkedSiteLicense} AND sl.id=$${values.length}::uuid)`,
    );
  }
  appendOrganizationQueueFilters(opts, values, clauses);
  const cursor = decodeCursor(opts.cursor);
  if (cursor) {
    values.push(cursor.updated_at, cursor.id);
    clauses.push(
      `(o.updated_at,o.id)<($${values.length - 1}::timestamptz,$${values.length}::uuid)`,
    );
  }
  values.push(limit + 1);
  const { rows } = await getPool().query(
    `SELECT DISTINCT o.* FROM crm_organizations o ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
     ORDER BY o.updated_at DESC,o.id DESC LIMIT $${values.length}`,
    values,
  );
  const summaries = await Promise.all(
    rows
      .slice(0, limit)
      .map((row) => summaryForOrganization(getPool(), organizationRow(row))),
  );
  const boundedRows = truncateRows(summaries, byteLimit(opts.max_bytes));
  const hasMore = rows.length > limit;
  const last = boundedRows.rows.at(-1);
  return {
    organizations: boundedRows.rows,
    next_cursor:
      last && (hasMore || boundedRows.truncated)
        ? encodeCursor(last.updated_at, last.id)
        : undefined,
    truncated: hasMore || boundedRows.truncated,
    result_bytes: boundedRows.bytes,
  };
}

export async function getSupportContext(
  opts: CrmSupportContextRequest,
): Promise<CrmSupportCustomerContext> {
  await prepareRead(opts.reason);
  const ticketId = Number(opts.ticket_id);
  if (!Number.isSafeInteger(ticketId) || ticketId <= 0)
    throw Error("ticket_id must be a positive integer");
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 25);
  const values: unknown[] = [`${ticketId}`];
  const evidenceQueries = [
    `SELECT x.organization_id,'zendesk_ticket'::text kind,x.external_id reference,
            concat(initcap(x.verification_state),' CRM ticket link') detail
       FROM crm_external_references x
       JOIN crm_organizations o ON o.id=x.organization_id AND o.status='active'
      WHERE x.provider='zendesk' AND x.object_kind='ticket' AND x.external_id=$1
        AND x.verification_state IN ('suggested','verified')`,
  ];
  const accountId = `${opts.requester_account_id ?? ""}`.trim();
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      accountId,
    )
  ) {
    values.push(accountId);
    evidenceQueries.push(
      `SELECT r.organization_id,'cocalc_account'::text kind,a.account_id::text reference,
              'Verified CoCalc account relationship'::text detail
         FROM crm_person_accounts a
         JOIN crm_organization_people r ON r.person_id=a.person_id AND r.state='active'
         JOIN crm_organizations o ON o.id=r.organization_id AND o.status='active'
        WHERE a.account_id=$${values.length}::uuid AND a.state='verified'`,
    );
  }
  const email = `${opts.requester_email ?? ""}`.trim().toLowerCase();
  if (/^[^@\s]+@[^@\s]+$/.test(email)) {
    values.push(email);
    evidenceQueries.push(
      `SELECT r.organization_id,'verified_email'::text kind,e.normalized_email reference,
              'Verified contact email relationship'::text detail
         FROM crm_person_emails e
         JOIN crm_organization_people r ON r.person_id=e.person_id AND r.state='active'
         JOIN crm_organizations o ON o.id=r.organization_id AND o.status='active'
        WHERE e.normalized_email=$${values.length} AND e.verified`,
    );
    const domain = normalizeDomain(email.split("@")[1]);
    if (!GENERIC_DOMAINS.has(domain)) {
      values.push(domain);
      evidenceQueries.push(
        `SELECT d.organization_id,'verified_domain'::text kind,d.normalized_domain reference,
                'Verified institutional domain; candidate only'::text detail
           FROM crm_organization_domains d
           JOIN crm_organizations o ON o.id=d.organization_id AND o.status='active'
          WHERE d.normalized_domain=$${values.length} AND d.state='verified'
            AND NOT d.generic_domain`,
      );
    }
  }
  const { rows } = await getPool().query<{
    organization_id: string;
    kind: CrmSupportCustomerEvidence["kind"];
    reference: string;
    detail: string;
  }>(evidenceQueries.join(" UNION ALL "), values);
  const evidenceByOrganization = new Map<
    string,
    CrmSupportCustomerEvidence[]
  >();
  for (const row of rows) {
    const evidence = evidenceByOrganization.get(row.organization_id) ?? [];
    if (
      !evidence.some(
        (item) => item.kind === row.kind && item.reference === row.reference,
      )
    ) {
      evidence.push({
        kind: row.kind,
        reference: row.reference,
        detail: row.detail,
      });
    }
    evidenceByOrganization.set(row.organization_id, evidence);
  }
  const sorted = [...evidenceByOrganization.entries()].sort((left, right) => {
    const linked = (value: CrmSupportCustomerEvidence[]) =>
      value.some(({ kind }) => kind === "zendesk_ticket") ? 1 : 0;
    return (
      linked(right[1]) - linked(left[1]) || right[1].length - left[1].length
    );
  });
  const candidates = await Promise.all(
    sorted.slice(0, limit).map(async ([organizationId, evidence]) => ({
      organization: await summaryForOrganization(
        getPool(),
        await loadOrganization(getPool(), organizationId),
      ),
      evidence,
      linked: evidence.some(({ kind }) => kind === "zendesk_ticket"),
    })),
  );
  return {
    ticket_id: ticketId,
    generated_at: new Date().toISOString(),
    candidates,
    truncated: sorted.length > limit,
    inference_note:
      "Candidates are evidence for human review only. Requester email or domain matches never link or merge a customer automatically.",
  };
}

export async function getTimeline(
  opts: CrmTimelineRequest,
): Promise<CrmTimelineResponse> {
  await prepareRead(opts.reason);
  const organizationId = await resolveOrganizationId(
    getPool(),
    opts.organization,
  );
  const limit = pageLimit(opts.limit);
  const values: unknown[] = [organizationId];
  const where = ["organization_id=$1"];
  if (opts.kinds?.length) {
    values.push(opts.kinds);
    where.push(`kind=ANY($${values.length}::text[])`);
  }
  const cursor = decodeCursor(opts.cursor);
  if (cursor) {
    values.push(cursor.updated_at, cursor.id);
    where.push(
      `(occurred_at,id)<($${values.length - 1}::timestamptz,$${values.length}::uuid)`,
    );
  }
  values.push(limit + 1);
  const { rows } = await getPool().query(
    `WITH timeline AS (
       SELECT id,organization_id,person_id,opportunity_id,task_id,
              commercial_order_id,site_license_id,zendesk_ticket_id,kind,
              source,source_id,summary,details,actor_account_id,occurred_at,
              supersedes_activity_id,metadata,created_at
         FROM crm_activities
       UNION ALL
       SELECT e.id,o.crm_organization_id,NULL::uuid,NULL::uuid,NULL::uuid,
              e.commercial_order_id,NULL::uuid,NULL::integer,'commercial_order',
              'commercial_order',e.id::text,
              initcap(replace(e.event_type,'-',' ')),e.reason,
              e.actor_account_id,e.created_at,NULL::uuid,'{}'::jsonb,e.created_at
         FROM commercial_order_events e
         JOIN commercial_orders o ON o.id=e.commercial_order_id
        WHERE o.crm_organization_id IS NOT NULL
       UNION ALL
       SELECT m.id,m.organization_id,NULL::uuid,NULL::uuid,NULL::uuid,
              NULL::uuid,NULL::uuid,NULL::integer,'mutation',
              'crm_mutation',m.id::text,
              initcap(replace(replace(m.action,'.',' '),'-',' ')),m.reason,
              m.actor_account_id,m.created_at,NULL::uuid,'{}'::jsonb,m.created_at
         FROM crm_mutation_events m
        WHERE m.organization_id IS NOT NULL
          AND NOT EXISTS(
            SELECT 1 FROM crm_activities a
             WHERE a.organization_id=m.organization_id AND a.source_id=m.id::text
          )
     )
     SELECT * FROM timeline WHERE ${where.join(" AND ")}
     ORDER BY occurred_at DESC,id DESC LIMIT $${values.length}`,
    values,
  );
  const hasMore = rows.length > limit;
  const boundedRows = truncateRows(
    rows.slice(0, limit).map(activityRow),
    byteLimit(opts.max_bytes),
  );
  const last = boundedRows.rows.at(-1);
  return {
    activities: boundedRows.rows,
    next_cursor:
      last && (hasMore || boundedRows.truncated)
        ? encodeCursor(last.occurred_at, last.id)
        : undefined,
    truncated: hasMore || boundedRows.truncated,
    result_bytes: boundedRows.bytes,
  };
}

export async function listPeople(
  opts: CrmPersonListRequest,
): Promise<CrmPersonListResponse> {
  await prepareRead(opts.reason);
  const limit = pageLimit(opts.limit);
  const values: unknown[] = [];
  const where: string[] = [];
  if (opts.organization) {
    values.push(await resolveOrganizationId(getPool(), opts.organization));
    where.push(
      `EXISTS (SELECT 1 FROM crm_organization_people r WHERE r.person_id=p.id AND r.organization_id=$${values.length})`,
    );
  }
  if (opts.search?.trim()) {
    values.push(`%${opts.search.trim()}%`);
    where.push(
      `(p.id::text ILIKE $${values.length} OR p.display_name ILIKE $${values.length}
        OR EXISTS (SELECT 1 FROM crm_person_emails e WHERE e.person_id=p.id AND e.normalized_email ILIKE $${values.length})
        OR EXISTS (
          SELECT 1 FROM crm_external_references x
           WHERE x.person_id=p.id
             AND x.object_kind='person'
             AND x.verification_state='verified'
             AND (x.external_id ILIKE $${values.length} OR x.label ILIKE $${values.length})
        ))`,
    );
  }
  if (opts.status) {
    values.push(opts.status);
    where.push(`p.status=$${values.length}`);
  }
  const cursor = decodeCursor(opts.cursor);
  if (cursor) {
    values.push(cursor.updated_at, cursor.id);
    where.push(
      `(p.updated_at,p.id)<($${values.length - 1}::timestamptz,$${values.length}::uuid)`,
    );
  }
  values.push(limit + 1);
  const { rows } = await getPool().query(
    `SELECT p.id,p.updated_at FROM crm_people p ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY p.updated_at DESC,p.id DESC LIMIT $${values.length}`,
    values,
  );
  const hasMore = rows.length > limit;
  const people = await Promise.all(
    rows.slice(0, limit).map((row) => loadPerson(getPool(), row.id)),
  );
  const boundedRows = truncateRows(people, byteLimit(opts.max_bytes));
  const last = boundedRows.rows.at(-1);
  return {
    people: boundedRows.rows,
    next_cursor:
      last && (hasMore || boundedRows.truncated)
        ? encodeCursor(last.updated_at, last.id)
        : undefined,
    truncated: hasMore || boundedRows.truncated,
    result_bytes: boundedRows.bytes,
  };
}

export async function getPerson(opts: CrmPersonGetRequest): Promise<CrmPerson> {
  await prepareRead(opts.reason);
  return await loadPerson(
    getPool(),
    await resolvePersonId(getPool(), opts.person),
  );
}

export async function listOpportunities(
  opts: CrmOpportunityListRequest,
): Promise<CrmOpportunityListResponse> {
  await prepareRead(opts.reason);
  const values: unknown[] = [];
  const where: string[] = [];
  if (opts.organization) {
    values.push(await resolveOrganizationId(getPool(), opts.organization));
    where.push(`organization_id=$${values.length}`);
  }
  if (opts.stages?.length) {
    values.push(opts.stages);
    where.push(`stage=ANY($${values.length}::text[])`);
  }
  if (opts.kinds?.length) {
    values.push(opts.kinds);
    where.push(`kind=ANY($${values.length}::text[])`);
  }
  if (opts.owner_account_id) {
    values.push(opts.owner_account_id);
    where.push(`owner_account_id=$${values.length}::uuid`);
  }
  const cursor = decodeCursor(opts.cursor);
  if (cursor) {
    values.push(cursor.updated_at, cursor.id);
    where.push(
      `(updated_at,id)<($${values.length - 1}::timestamptz,$${values.length}::uuid)`,
    );
  }
  const limit = pageLimit(opts.limit);
  values.push(limit + 1);
  const { rows } = await getPool().query(
    `SELECT * FROM crm_opportunities ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC,id DESC LIMIT $${values.length}`,
    values,
  );
  const data = rows.slice(0, limit).map(opportunityRow);
  const boundedRows = truncateRows(data, byteLimit(opts.max_bytes));
  const last = boundedRows.rows.at(-1);
  return {
    opportunities: boundedRows.rows,
    next_cursor:
      last && (rows.length > limit || boundedRows.truncated)
        ? encodeCursor(last.updated_at, last.id)
        : undefined,
    truncated: rows.length > limit || boundedRows.truncated,
    result_bytes: boundedRows.bytes,
  };
}

export async function getOpportunity(opts: {
  opportunity: string;
  reason: string;
}): Promise<CrmOpportunity> {
  await prepareRead(opts.reason);
  return await loadOpportunity(
    getPool(),
    await resolveOpportunityId(getPool(), opts.opportunity),
  );
}

export async function listTasks(
  opts: CrmTaskListRequest,
): Promise<CrmTaskListResponse> {
  await prepareRead(opts.reason);
  const values: unknown[] = [];
  const where: string[] = [];
  if (opts.organization) {
    values.push(await resolveOrganizationId(getPool(), opts.organization));
    where.push(`organization_id=$${values.length}`);
  }
  if (opts.opportunity) {
    values.push(await resolveOpportunityId(getPool(), opts.opportunity));
    where.push(`opportunity_id=$${values.length}`);
  }
  if (opts.assignee_account_id) {
    values.push(opts.assignee_account_id);
    where.push(`assignee_account_id=$${values.length}::uuid`);
  }
  if (opts.states?.length) {
    values.push(opts.states);
    where.push(`state=ANY($${values.length}::text[])`);
  }
  if (opts.types?.length) {
    values.push(opts.types);
    where.push(`type=ANY($${values.length}::text[])`);
  }
  if (opts.due_before) {
    values.push(opts.due_before);
    where.push(`due_at<$${values.length}::timestamptz`);
  }
  if (opts.overdue) where.push("state IN ('open','waiting') AND due_at<NOW()");
  const cursor = decodeCursor(opts.cursor);
  if (cursor) {
    values.push(cursor.updated_at, cursor.id);
    where.push(
      `(updated_at,id)<($${values.length - 1}::timestamptz,$${values.length}::uuid)`,
    );
  }
  const limit = pageLimit(opts.limit);
  values.push(limit + 1);
  const { rows } = await getPool().query(
    `SELECT * FROM crm_tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC,id DESC LIMIT $${values.length}`,
    values,
  );
  const data = rows.slice(0, limit).map(taskRow);
  const boundedRows = truncateRows(data, byteLimit(opts.max_bytes));
  const last = boundedRows.rows.at(-1);
  return {
    tasks: boundedRows.rows,
    next_cursor:
      last && (rows.length > limit || boundedRows.truncated)
        ? encodeCursor(last.updated_at, last.id)
        : undefined,
    truncated: rows.length > limit || boundedRows.truncated,
    result_bytes: boundedRows.bytes,
  };
}

export async function getTask(opts: {
  task: string;
  reason: string;
}): Promise<CrmTask> {
  await prepareRead(opts.reason);
  return await loadTask(getPool(), await resolveTaskId(getPool(), opts.task));
}

export async function listExternalReferences(
  opts: CrmExternalReferenceListRequest,
): Promise<CrmExternalReferenceListResponse> {
  await prepareRead(opts.reason);
  if (opts.external_id != null && opts.external_id_prefix != null) {
    throw Error("external_id and external_id_prefix are mutually exclusive");
  }
  const values: unknown[] = [];
  const where: string[] = [];
  const add = (clause: string, value: unknown) => {
    values.push(value);
    where.push(clause.replace("?", `$${values.length}`));
  };
  if (opts.provider != null) {
    add(
      "x.provider=?",
      assertEnum(opts.provider, CRM_EXTERNAL_PROVIDERS, "provider"),
    );
  }
  if (opts.object_kind != null) {
    add(
      "x.object_kind=?",
      assertEnum(opts.object_kind, CRM_EXTERNAL_OBJECT_KINDS, "object_kind"),
    );
  }
  if (opts.external_id != null) {
    add("x.external_id=?", bounded(opts.external_id, "external_id", 500));
  }
  if (opts.external_id_prefix != null) {
    const prefix = bounded(opts.external_id_prefix, "external_id_prefix", 500);
    add("x.external_id LIKE ? ESCAPE E'\\\\'", `${escapeLikeLiteral(prefix)}%`);
  }
  if (opts.organization != null) {
    add(
      "x.organization_id=?::uuid",
      await resolveOrganizationId(getPool(), opts.organization),
    );
  }
  if (opts.verification_state != null) {
    add(
      "x.verification_state=?",
      assertEnum(
        opts.verification_state,
        CRM_EXTERNAL_REFERENCE_VERIFICATION_STATES,
        "verification_state",
      ),
    );
  }
  const cursor = decodeExternalReferenceCursor(opts.cursor);
  if (cursor) {
    values.push(cursor.provider, cursor.object_kind, cursor.external_id);
    where.push(
      `(x.provider,x.object_kind,x.external_id)>($${values.length - 2},$${values.length - 1},$${values.length})`,
    );
  }
  const limit = pageLimit(opts.limit);
  values.push(limit + 1);
  const { rows } = await getPool().query(
    `SELECT x.*,o.customer_number AS organization_customer_number,
            o.display_name AS organization_display_name
       FROM crm_external_references x
       JOIN crm_organizations o ON o.id=x.organization_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY x.provider,x.object_kind,x.external_id
      LIMIT $${values.length}`,
    values,
  );
  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit).map(externalReferenceListItem);
  const boundedRows = truncateRows(data, byteLimit(opts.max_bytes));
  if (data.length > 0 && boundedRows.rows.length === 0) {
    throw Error(
      "max_bytes is too small for one CRM external reference; increase max_bytes and retry",
    );
  }
  const last = boundedRows.rows.at(-1);
  const truncated = hasMore || boundedRows.truncated;
  return {
    external_references: boundedRows.rows,
    next_cursor:
      last && truncated
        ? encodeExternalReferenceCursor(last.reference)
        : undefined,
    truncated,
    result_bytes: boundedRows.bytes,
  };
}

export async function getCustomerMetrics(
  opts: CrmMetricsRequest,
): Promise<CrmCustomerMetrics> {
  await prepareRead(opts.reason);
  const organizationId = await resolveOrganizationId(
    getPool(),
    opts.organization,
  );
  const [
    payments,
    outstanding,
    orders,
    licenses,
    licensedSeats,
    accounts,
    latestZendesk,
  ] = await Promise.all([
    getPool().query<{ year: string; amount: string }>(
      `SELECT EXTRACT(YEAR FROM p.received_at)::integer::text AS year,COALESCE(sum(p.amount),0)::text AS amount
         FROM commercial_payments p JOIN commercial_orders o ON o.id=p.commercial_order_id
        WHERE o.crm_organization_id=$1
          AND p.status IN ('succeeded','partially_refunded')
        GROUP BY 1 ORDER BY 1`,
      [organizationId],
    ),
    getPool().query<{ amount: string }>(
      `SELECT COALESCE(sum(GREATEST(i.amount_due-i.amount_paid,0)),0)::text AS amount
         FROM commercial_invoices i JOIN commercial_orders o ON o.id=i.commercial_order_id
        WHERE o.crm_organization_id=$1 AND i.status IN ('draft','creating','open')`,
      [organizationId],
    ),
    getPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM commercial_orders WHERE crm_organization_id=$1",
      [organizationId],
    ),
    getPool().query<{ active: string; historical: string }>(
      `SELECT count(*) FILTER (WHERE starts_at<=NOW() AND expires_at>NOW())::text AS active,
              count(*) FILTER (WHERE expires_at<=NOW())::text AS historical
         FROM site_licenses WHERE crm_organization_id=$1`,
      [organizationId],
    ),
    getPool().query<{ seats: string }>(
      `SELECT COALESCE(sum(p.seat_count),0)::text AS seats
           FROM membership_packages p
          WHERE p.kind='site'
            AND p.metadata->>'site_license_id' IN
              (SELECT id::text FROM site_licenses WHERE crm_organization_id=$1)
            AND (p.starts_at IS NULL OR p.starts_at<=NOW())
            AND (p.expires_at IS NULL OR p.expires_at>NOW())`,
      [organizationId],
    ),
    getPool().query<{ count: string }>(
      `SELECT count(DISTINCT a.account_id)::text AS count FROM crm_person_accounts a
        JOIN crm_organization_people r ON r.person_id=a.person_id
       WHERE r.organization_id=$1 AND a.state='verified'`,
      [organizationId],
    ),
    getPool().query<{ occurred_at: Date | string }>(
      "SELECT occurred_at FROM crm_activities WHERE organization_id=$1 AND kind='zendesk' ORDER BY occurred_at DESC LIMIT 1",
      [organizationId],
    ),
  ]);
  const generatedAt = new Date().toISOString();
  const metrics: CrmCustomerMetrics = {
    organization_id: organizationId,
    generated_at: generatedAt,
    scope: "reviewed CRM links on the seed control plane",
    commercial_spend_by_year: Object.fromEntries(
      payments.rows.map((x) => [x.year, x.amount]),
    ),
    outstanding_receivables: `${outstanding.rows[0]?.amount ?? "0"}`,
    commercial_order_count: Number(orders.rows[0]?.count ?? 0),
    active_site_license_count: Number(licenses.rows[0]?.active ?? 0),
    historical_site_license_count: Number(licenses.rows[0]?.historical ?? 0),
    licensed_seats: Number(licensedSeats.rows[0]?.seats ?? 0),
    linked_account_count: Number(accounts.rows[0]?.count ?? 0),
    estimated_domain_account_count: 0,
    recent_zendesk_interaction_at: iso(latestZendesk.rows[0]?.occurred_at),
    provenance: {
      commercial:
        "commercial orders, invoices, and payments linked by reviewed CRM UUID",
      licenses: "site licenses linked by reviewed CRM UUID",
      accounts: "verified CRM person-account relationships",
      domain_usage: "not scanned synchronously; zero means not projected",
      generated_at: generatedAt,
    },
  };
  if (opts.refresh) {
    await getPool().query(
      `INSERT INTO crm_metric_snapshots(id,organization_id,generated_at,scope,metrics,provenance)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        randomUUID(),
        organizationId,
        generatedAt,
        metrics.scope,
        metrics,
        metrics.provenance,
      ],
    );
  }
  return metrics;
}

export async function getOrganization(
  opts: CrmOrganizationGetRequest,
): Promise<CrmCustomer360> {
  await prepareRead(opts.reason);
  const organizationId = await resolveOrganizationId(
    getPool(),
    opts.organization,
  );
  const [
    organization,
    domains,
    relationships,
    opportunities,
    tasks,
    refs,
    timeline,
    orders,
    licenses,
    licensePools,
    metrics,
  ] = await Promise.all([
    loadOrganization(getPool(), organizationId),
    getPool().query(
      "SELECT * FROM crm_organization_domains WHERE organization_id=$1 ORDER BY kind,normalized_domain",
      [organizationId],
    ),
    getPool().query(
      "SELECT * FROM crm_organization_people WHERE organization_id=$1 ORDER BY updated_at DESC",
      [organizationId],
    ),
    listOpportunities({
      organization: organizationId,
      reason: opts.reason,
      limit: 500,
    }),
    listTasks({
      organization: organizationId,
      reason: opts.reason,
      limit: 500,
    }),
    getPool().query(
      "SELECT * FROM crm_external_references WHERE organization_id=$1 ORDER BY provider,object_kind,external_id",
      [organizationId],
    ),
    getTimeline({
      organization: organizationId,
      reason: opts.reason,
      limit: Math.min(opts.activity_limit ?? 100, 500),
    }),
    getPool().query(
      `SELECT id,order_number,organization_name,workflow_state,collection_state,fulfillment_state,currency,agreed_total,assignee_account_id,next_action,next_action_due_at,updated_at FROM commercial_orders WHERE crm_organization_id=$1 ORDER BY updated_at DESC LIMIT 500`,
      [organizationId],
    ),
    getPool().query(
      `SELECT id,name,organization_name,owner_account_id,allowed_domains,starts_at,expires_at,metadata,updated FROM site_licenses WHERE crm_organization_id=$1 ORDER BY updated DESC LIMIT 500`,
      [organizationId],
    ),
    getPool().query(
      `SELECT id,membership_class,seat_count,starts_at,expires_at,
              metadata->>'site_license_id' AS site_license_id,
              metadata->>'pool_name' AS pool_name,
              metadata->>'pool_description' AS pool_description
         FROM membership_packages
        WHERE kind='site'
          AND metadata->>'site_license_id' IN
            (SELECT id::text FROM site_licenses WHERE crm_organization_id=$1)
        ORDER BY metadata->>'site_license_id',metadata->>'pool_name',id
        LIMIT 2000`,
      [organizationId],
    ),
    getCustomerMetrics({ organization: organizationId, reason: opts.reason }),
  ]);
  const relationRows = relationships.rows.map(relationshipRow);
  const people = await Promise.all(
    relationRows.map((row) => loadPerson(getPool(), row.person_id)),
  );
  const parentOrganization = organization.parent_organization_id
    ? await loadOrganization(
        getPool(),
        organization.parent_organization_id,
      ).then(({ id, customer_number, display_name }) => ({
        id,
        customer_number,
        display_name,
      }))
    : null;
  return {
    organization,
    parent_organization: parentOrganization,
    domains: domains.rows.map(domainRow),
    people,
    relationships: relationRows,
    opportunities: opportunities.opportunities,
    tasks: tasks.tasks,
    external_references: refs.rows.map(externalReferenceRow),
    activities: timeline.activities,
    commercial_orders: orders.rows.map((x) => ({
      ...x,
      updated_at: iso(x.updated_at),
    })),
    site_licenses: licenses.rows.map((x) => ({
      ...x,
      starts_at: iso(x.starts_at),
      expires_at: iso(x.expires_at),
      updated: iso(x.updated),
      pools: licensePools.rows
        .filter((pool) => pool.site_license_id === x.id)
        .map((pool) => ({
          ...pool,
          starts_at: iso(pool.starts_at),
          expires_at: iso(pool.expires_at),
        })),
    })),
    metrics,
  };
}

export async function createOrganization(
  opts: CrmOrganizationCreateRequest,
): Promise<CrmMutationResult<CrmOrganization>> {
  const actor = requireActor(opts.account_id);
  const displayName = bounded(opts.display_name, "display_name", 500);
  const organizationType = assertEnum(
    opts.organization_type,
    CRM_ORGANIZATION_TYPES,
    "organization_type",
  );
  const lifecycleStage = assertEnum(
    opts.lifecycle_stage ?? "prospect",
    CRM_LIFECYCLE_STAGES,
    "lifecycle_stage",
  );
  const proposed: Partial<CrmOrganization> = {
    display_name: displayName,
    legal_name: optionalBounded(opts.legal_name, "legal_name", 500),
    aliases: (opts.aliases ?? [])
      .map((x) => bounded(x, "alias", 500))
      .slice(0, 50),
    website: normalizeWebsite(opts.website),
    timezone: optionalBounded(opts.timezone, "timezone", 100),
    organization_type: organizationType,
    lifecycle_stage: lifecycleStage,
    relationship_owner_account_id: opts.relationship_owner_account_id ?? null,
  };
  if (
    proposed.relationship_owner_account_id != null &&
    !isValidUUID(proposed.relationship_owner_account_id)
  ) {
    throw Error("relationship_owner_account_id must be a UUID");
  }
  let parentId: string | null = null;
  await prepareRead(opts.reason);
  if (opts.parent_organization)
    parentId = await resolveOrganizationId(getPool(), opts.parent_organization);
  return await mutate({
    action: "organization.create",
    actor,
    reason: opts.reason,
    commit: opts.commit,
    expectedVersion: opts.expected_version,
    idempotencyKey: opts.idempotency_key,
    proposed: { ...proposed, parent_organization_id: parentId },
    resultType: "organization",
    currentVersion: async () => 0,
    apply: async (client, eventId) => {
      const id = randomUUID();
      const { rows } = await client.query(
        `INSERT INTO crm_organizations
         (id,customer_number,display_name,legal_name,aliases,website,timezone,organization_type,lifecycle_stage,
          relationship_owner_account_id,parent_organization_id,created_by_account_id,updated_by_account_id)
         VALUES ($1,'CRM-'||EXTRACT(YEAR FROM NOW())::integer::text||'-'||lpad(nextval('crm_customer_number_seq')::text,6,'0'),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
         RETURNING *`,
        [
          id,
          proposed.display_name,
          proposed.legal_name,
          proposed.aliases,
          proposed.website,
          proposed.timezone,
          proposed.organization_type,
          proposed.lifecycle_stage,
          proposed.relationship_owner_account_id,
          parentId,
          actor,
        ],
      );
      const organization = organizationRow(rows[0]);
      await insertActivity(client, {
        organization_id: id,
        kind: "mutation",
        source: "crm",
        source_id: eventId,
        summary: `Created customer ${organization.customer_number}`,
        details: opts.reason,
        actor_account_id: actor,
        occurred_at: new Date().toISOString(),
      });
      return organization;
    },
  });
}

export async function updateOrganization(
  opts: CrmOrganizationUpdateRequest,
): Promise<CrmMutationResult<CrmOrganization>> {
  await prepareRead(opts.reason);
  const id = await resolveOrganizationId(getPool(), opts.organization);
  const changes: Json = {};
  const allowed = [
    "display_name",
    "legal_name",
    "aliases",
    "website",
    "timezone",
    "organization_type",
    "lifecycle_stage",
    "relationship_owner_account_id",
    "parent_organization_id",
  ] as const;
  for (const key of allowed)
    if (Object.hasOwn(opts.changes, key))
      changes[key] = (opts.changes as any)[key];
  if (changes.display_name != null)
    changes.display_name = bounded(changes.display_name, "display_name", 500);
  if (Object.hasOwn(changes, "legal_name"))
    changes.legal_name = optionalBounded(changes.legal_name, "legal_name", 500);
  if (Object.hasOwn(changes, "aliases")) {
    if (!Array.isArray(changes.aliases))
      throw Error("aliases must be an array");
    changes.aliases = changes.aliases
      .map((value) => bounded(value, "alias", 500))
      .slice(0, 50);
  }
  if (Object.hasOwn(changes, "website"))
    changes.website = normalizeWebsite(changes.website);
  if (Object.hasOwn(changes, "timezone"))
    changes.timezone = optionalBounded(changes.timezone, "timezone", 100);
  if (changes.organization_type != null)
    assertEnum(
      changes.organization_type,
      CRM_ORGANIZATION_TYPES,
      "organization_type",
    );
  if (changes.lifecycle_stage != null)
    assertEnum(
      changes.lifecycle_stage,
      CRM_LIFECYCLE_STAGES,
      "lifecycle_stage",
    );
  for (const key of [
    "relationship_owner_account_id",
    "parent_organization_id",
  ] as const) {
    if (changes[key] != null && !isValidUUID(`${changes[key]}`)) {
      throw Error(`${key} must be a UUID`);
    }
  }
  if (changes.parent_organization_id === id)
    throw Error("an organization cannot be its own parent");
  return await mutate({
    action: "organization.update",
    target: `organization:${id}`,
    actor: requireActor(opts.account_id),
    reason: opts.reason,
    commit: opts.commit,
    expectedVersion: opts.expected_version,
    idempotencyKey: opts.idempotency_key,
    organizationId: id,
    proposed: changes,
    resultType: "organization",
    currentVersion: async (db) =>
      (await loadOrganization(db, id, db !== getPool())).version,
    apply: async (client, eventId) => {
      const keys = Object.keys(changes);
      if (!keys.length) return await loadOrganization(client, id);
      const values = keys.map((key) => changes[key]);
      values.push(requireActor(opts.account_id), id);
      await client.query(
        `UPDATE crm_organizations SET ${keys.map((key, index) => `${key}=$${index + 1}`).join(",")},updated_by_account_id=$${keys.length + 1},updated_at=NOW(),version=version+1 WHERE id=$${keys.length + 2}`,
        values,
      );
      const result = await loadOrganization(client, id);
      await insertActivity(client, {
        organization_id: id,
        kind: "mutation",
        source: "crm",
        source_id: eventId,
        summary: "Updated customer profile",
        details: opts.reason,
        actor_account_id: opts.account_id,
        occurred_at: new Date().toISOString(),
        metadata: { fields: keys },
      });
      return result;
    },
  });
}

export async function archiveOrganization(
  opts: CrmOrganizationArchiveRequest,
): Promise<CrmMutationResult<CrmOrganization>> {
  await prepareRead(opts.reason);
  const id = await resolveOrganizationId(getPool(), opts.organization);
  return await mutate({
    action: "organization.archive",
    target: `organization:${id}`,
    actor: requireActor(opts.account_id),
    reason: opts.reason,
    commit: opts.commit,
    expectedVersion: opts.expected_version,
    idempotencyKey: opts.idempotency_key,
    organizationId: id,
    proposed: { status: "archived", lifecycle_stage: "inactive" },
    warnings: [
      "Archived customers remain available in history and may be restored by an administrator.",
    ],
    resultType: "organization",
    currentVersion: async (db) =>
      (await loadOrganization(db, id, db !== getPool())).version,
    apply: async (client, eventId) => {
      await client.query(
        `UPDATE crm_organizations SET status='archived',lifecycle_stage='inactive',
         updated_by_account_id=$1,updated_at=NOW(),version=version+1 WHERE id=$2`,
        [opts.account_id, id],
      );
      const result = await loadOrganization(client, id);
      await insertActivity(client, {
        organization_id: id,
        kind: "mutation",
        source: "crm",
        source_id: eventId,
        summary: "Archived customer",
        details: opts.reason,
        actor_account_id: opts.account_id,
        occurred_at: new Date().toISOString(),
      });
      return result;
    },
  });
}

export async function mergeOrganizations(
  opts: CrmOrganizationMergeRequest,
): Promise<CrmMutationResult<CrmOrganization>> {
  await prepareRead(opts.reason);
  const sourceId = await resolveOrganizationId(
    getPool(),
    opts.source_organization,
  );
  const destinationId = await resolveOrganizationId(
    getPool(),
    opts.destination_organization,
  );
  if (sourceId === destinationId)
    throw Error("source and destination organizations must differ");
  const cycle = await getPool().query(
    `WITH RECURSIVE ancestors AS (
       SELECT id,parent_organization_id FROM crm_organizations WHERE id=$1
       UNION ALL
       SELECT o.id,o.parent_organization_id
         FROM crm_organizations o JOIN ancestors a ON o.id=a.parent_organization_id
     )
     SELECT 1 FROM ancestors WHERE id=$2 LIMIT 1`,
    [destinationId, sourceId],
  );
  if (cycle.rows.length) {
    throw Error(
      "merge destination is a descendant of the source; change the hierarchy before merging",
    );
  }
  return await mutate({
    action: "organization.merge",
    actor: requireActor(opts.account_id),
    reason: opts.reason,
    commit: opts.commit,
    expectedVersion: opts.expected_version,
    idempotencyKey: opts.idempotency_key,
    organizationId: sourceId,
    proposed: {
      source_organization_id: sourceId,
      destination_organization_id: destinationId,
    },
    warnings: [
      "All relationships move to the destination; the source remains as a merged redirect.",
    ],
    resultType: "organization",
    currentVersion: async (db) =>
      (await loadOrganization(db, sourceId, db !== getPool())).version,
    apply: async (client, eventId) => {
      const destination = await loadOrganization(client, destinationId, true);
      if (destination.status !== "active")
        throw Error("merge destination must be active");
      const source = await loadOrganization(client, sourceId, true);
      if (source.status !== "active")
        throw Error("merge source must be active");

      const sourceDomains = await client.query(
        "SELECT * FROM crm_organization_domains WHERE organization_id=$1 ORDER BY created_at,id",
        [sourceId],
      );
      await client.query(
        "DELETE FROM crm_organization_domains WHERE organization_id=$1",
        [sourceId],
      );
      for (const domain of sourceDomains.rows) {
        await client.query(
          `INSERT INTO crm_organization_domains
             (id,organization_id,normalized_domain,display_domain,kind,state,verification_method,evidence_reference,generic_domain,created_by_account_id,updated_by_account_id,created_at,updated_at,verified_at,retired_at,version)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),$13,$14,$15)
           ON CONFLICT(organization_id,normalized_domain) DO UPDATE SET
             state=CASE
               WHEN crm_organization_domains.state='verified' OR EXCLUDED.state='verified' THEN 'verified'
               WHEN crm_organization_domains.state='suggested' OR EXCLUDED.state='suggested' THEN 'suggested'
               ELSE crm_organization_domains.state
             END,
             evidence_reference=COALESCE(crm_organization_domains.evidence_reference,EXCLUDED.evidence_reference),
             verification_method=COALESCE(crm_organization_domains.verification_method,EXCLUDED.verification_method),
             updated_by_account_id=EXCLUDED.updated_by_account_id,
             updated_at=NOW(),
             verified_at=COALESCE(crm_organization_domains.verified_at,EXCLUDED.verified_at),
             version=crm_organization_domains.version+1`,
          [
            domain.id,
            destinationId,
            domain.normalized_domain,
            domain.display_domain,
            domain.kind,
            domain.state,
            domain.verification_method,
            domain.evidence_reference,
            domain.generic_domain,
            domain.created_by_account_id,
            opts.account_id,
            domain.created_at,
            domain.verified_at,
            domain.retired_at,
            domain.version,
          ],
        );
      }

      const sourceRelationships = await client.query(
        "SELECT * FROM crm_organization_people WHERE organization_id=$1 ORDER BY created_at,id",
        [sourceId],
      );
      await client.query(
        "DELETE FROM crm_organization_people WHERE organization_id=$1",
        [sourceId],
      );
      for (const relationship of sourceRelationships.rows) {
        await client.query(
          `INSERT INTO crm_organization_people
             (id,organization_id,person_id,roles,title,department,state,created_at,updated_at,version)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9)
           ON CONFLICT (organization_id,person_id) DO UPDATE SET
             roles=(SELECT ARRAY(SELECT DISTINCT unnest(crm_organization_people.roles||EXCLUDED.roles))),
             title=COALESCE(crm_organization_people.title,EXCLUDED.title),
             department=COALESCE(crm_organization_people.department,EXCLUDED.department),
             updated_at=NOW(),
             version=crm_organization_people.version+1`,
          [
            relationship.id,
            destinationId,
            relationship.person_id,
            relationship.roles,
            relationship.title,
            relationship.department,
            relationship.state,
            relationship.created_at,
            relationship.version,
          ],
        );
      }

      for (const table of [
        "crm_opportunities",
        "crm_tasks",
        "crm_external_references",
        "crm_activities",
        "crm_metric_snapshots",
        "crm_mutation_events",
      ]) {
        await client.query(
          `UPDATE ${table} SET organization_id=$1 WHERE organization_id=$2`,
          [destinationId, sourceId],
        );
      }
      await client.query(
        "UPDATE crm_organizations SET parent_organization_id=$1 WHERE parent_organization_id=$2",
        [destinationId, sourceId],
      );
      await client.query(
        "UPDATE commercial_orders SET crm_organization_id=$1 WHERE crm_organization_id=$2",
        [destinationId, sourceId],
      );
      await client.query(
        "UPDATE site_licenses SET crm_organization_id=$1 WHERE crm_organization_id=$2",
        [destinationId, sourceId],
      );
      await client.query(
        "UPDATE crm_organizations SET status='merged',merged_into_organization_id=$1,updated_by_account_id=$3,updated_at=NOW(),version=version+1 WHERE id=$2",
        [destinationId, sourceId, opts.account_id],
      );
      await insertActivity(client, {
        organization_id: destinationId,
        kind: "mutation",
        source: "crm",
        source_id: eventId,
        summary: "Merged a duplicate customer record",
        details: opts.reason,
        actor_account_id: opts.account_id,
        occurred_at: new Date().toISOString(),
        metadata: { source_organization_id: sourceId },
      });
      return await loadOrganization(client, destinationId);
    },
  });
}

export async function mutateDomain(
  opts: CrmDomainMutationRequest,
): Promise<CrmMutationResult<CrmOrganizationDomain>> {
  await prepareRead(opts.reason);
  const organizationId = await resolveOrganizationId(
    getPool(),
    opts.organization,
  );
  const domain = normalizeDomain(opts.domain);
  const existing = await getPool().query(
    "SELECT * FROM crm_organization_domains WHERE organization_id=$1 AND normalized_domain=$2",
    [organizationId, domain],
  );
  const current = existing.rows[0] ? domainRow(existing.rows[0]) : undefined;
  const destinationId = opts.destination_organization
    ? await resolveOrganizationId(getPool(), opts.destination_organization)
    : undefined;
  const nextState =
    opts.action === "verify"
      ? "verified"
      : opts.action === "reject"
        ? "rejected"
        : opts.action === "retire"
          ? "retired"
          : (opts.state ?? "suggested");
  const kind = assertEnum(
    opts.kind ?? current?.kind ?? "secondary",
    CRM_DOMAIN_KINDS,
    "kind",
  );
  assertEnum(nextState, CRM_DOMAIN_STATES, "state");
  const verificationMethod = optionalBounded(
    opts.verification_method,
    "verification_method",
    100,
  );
  const evidenceReference = optionalBounded(
    opts.evidence_reference,
    "evidence_reference",
    1_000,
  );
  if (opts.action === "transfer" && !destinationId)
    throw Error("destination_organization is required for transfer");
  return await mutate({
    action: `domain.${opts.action}`,
    actor: requireActor(opts.account_id),
    reason: opts.reason,
    commit: opts.commit,
    expectedVersion: opts.expected_version,
    idempotencyKey: opts.idempotency_key,
    organizationId,
    proposed: {
      organization_id: destinationId ?? organizationId,
      normalized_domain: domain,
      kind,
      state: nextState,
      verification_method: verificationMethod,
      evidence_reference: evidenceReference,
      generic_domain: GENERIC_DOMAINS.has(domain),
    },
    warnings: GENERIC_DOMAINS.has(domain)
      ? [
          "Generic email domains must not be used as organization identity evidence.",
        ]
      : [],
    resultType: "domain",
    currentVersion: async () => current?.version ?? 0,
    apply: async (client, eventId) => {
      if (nextState === "verified" && GENERIC_DOMAINS.has(domain))
        throw Error(
          "generic email domains cannot be verified as organization domains",
        );
      const target = destinationId ?? organizationId;
      const id = current?.id ?? randomUUID();
      if (opts.action === "transfer" && target !== organizationId && current) {
        await client.query(
          "DELETE FROM crm_organization_domains WHERE id=$1 AND organization_id=$2",
          [current.id, organizationId],
        );
      }
      const { rows } = await client.query(
        `INSERT INTO crm_organization_domains
         (id,organization_id,normalized_domain,display_domain,kind,state,verification_method,evidence_reference,generic_domain,created_by_account_id,updated_by_account_id,verified_at,retired_at)
         VALUES ($1,$2,$3,$4,$5::varchar(24),$6::varchar(24),$7,$8,$9,$10,$10,CASE WHEN $6::text='verified' THEN NOW() END,CASE WHEN $6::text='retired' THEN NOW() END)
         ON CONFLICT (organization_id,normalized_domain) DO UPDATE SET kind=EXCLUDED.kind,state=EXCLUDED.state,verification_method=EXCLUDED.verification_method,evidence_reference=EXCLUDED.evidence_reference,generic_domain=EXCLUDED.generic_domain,updated_by_account_id=EXCLUDED.updated_by_account_id,updated_at=NOW(),verified_at=CASE WHEN EXCLUDED.state='verified' THEN NOW() ELSE crm_organization_domains.verified_at END,retired_at=CASE WHEN EXCLUDED.state='retired' THEN NOW() ELSE NULL END,version=crm_organization_domains.version+1 RETURNING *`,
        [
          id,
          target,
          domain,
          domain,
          kind,
          nextState,
          verificationMethod,
          evidenceReference,
          GENERIC_DOMAINS.has(domain),
          opts.account_id,
        ],
      );
      const result = domainRow(rows[0]);
      await insertActivity(client, {
        organization_id: target,
        kind: "mutation",
        source: "crm",
        source_id: eventId,
        summary: `${opts.action} domain ${domain}`,
        details: opts.reason,
        actor_account_id: opts.account_id,
        occurred_at: new Date().toISOString(),
      });
      return result;
    },
  });
}

export async function createPerson(
  opts: CrmPersonCreateRequest,
): Promise<CrmMutationResult<CrmPerson>> {
  await prepareRead(opts.reason);
  const organizationId = opts.organization
    ? await resolveOrganizationId(getPool(), opts.organization)
    : null;
  const proposed = {
    display_name: bounded(opts.display_name, "display_name", 500),
    website: normalizeHttpUrl(opts.website, "website"),
    linkedin_url: normalizeHttpUrl(opts.linkedin_url, "linkedin_url"),
    facebook_url: normalizeHttpUrl(opts.facebook_url, "facebook_url"),
    x_url: normalizeHttpUrl(opts.x_url, "x_url"),
    note: normalizePersonNote(opts.note),
    timezone: optionalBounded(opts.timezone, "timezone", 100),
    organization_id: organizationId,
    email: opts.email ? normalizeEmail(opts.email) : null,
    cocalc_account_id: opts.cocalc_account_id ?? null,
    roles: opts.roles ?? [],
    title: optionalBounded(opts.title, "title", 300),
    department: optionalBounded(opts.department, "department", 300),
  };
  if (
    proposed.cocalc_account_id != null &&
    !isValidUUID(proposed.cocalc_account_id)
  ) {
    throw Error("cocalc_account_id must be a UUID");
  }
  for (const role of proposed.roles) assertEnum(role, CRM_PERSON_ROLES, "role");
  return await mutate({
    action: "person.create",
    actor: requireActor(opts.account_id),
    reason: opts.reason,
    commit: opts.commit,
    expectedVersion: opts.expected_version,
    idempotencyKey: opts.idempotency_key,
    organizationId,
    proposed,
    resultType: "person",
    currentVersion: async () => 0,
    apply: async (client, eventId) => {
      const id = randomUUID();
      await client.query(
        `INSERT INTO crm_people
          (id,display_name,website,linkedin_url,facebook_url,x_url,note,timezone,
           created_by_account_id,updated_by_account_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
        [
          id,
          proposed.display_name,
          proposed.website,
          proposed.linkedin_url,
          proposed.facebook_url,
          proposed.x_url,
          proposed.note,
          proposed.timezone,
          opts.account_id,
        ],
      );
      if (proposed.email)
        await client.query(
          "INSERT INTO crm_person_emails(id,person_id,email_address,normalized_email,kind,is_primary,verified) VALUES ($1,$2,$3,$3,'work',TRUE,FALSE)",
          [randomUUID(), id, proposed.email],
        );
      if (proposed.cocalc_account_id)
        await client.query(
          "INSERT INTO crm_person_accounts(id,person_id,account_id,state,evidence_reference) VALUES ($1,$2,$3,'suggested',$4)",
          [
            randomUUID(),
            id,
            proposed.cocalc_account_id,
            "Created with CRM person",
          ],
        );
      if (organizationId)
        await client.query(
          "INSERT INTO crm_organization_people(id,organization_id,person_id,roles,title,department,state) VALUES ($1,$2,$3,$4,$5,$6,'active')",
          [
            randomUUID(),
            organizationId,
            id,
            proposed.roles,
            proposed.title,
            proposed.department,
          ],
        );
      if (organizationId)
        await insertActivity(client, {
          organization_id: organizationId,
          person_id: id,
          kind: "mutation",
          source: "crm",
          source_id: eventId,
          summary: `Added contact ${proposed.display_name}`,
          details: opts.reason,
          actor_account_id: opts.account_id,
          occurred_at: new Date().toISOString(),
        });
      return await loadPerson(client, id);
    },
  });
}

export async function updatePerson(
  opts: CrmPersonUpdateRequest,
): Promise<CrmMutationResult<CrmPerson>> {
  await prepareRead(opts.reason);
  const id = await resolvePersonId(getPool(), opts.person);
  const changes: Json = {};
  for (const key of [
    "display_name",
    "website",
    "linkedin_url",
    "facebook_url",
    "x_url",
    "note",
    "timezone",
    "status",
  ])
    if (Object.hasOwn(opts.changes, key))
      changes[key] = (opts.changes as any)[key];
  if (changes.display_name != null)
    changes.display_name = bounded(changes.display_name, "display_name", 500);
  if (Object.hasOwn(changes, "timezone"))
    changes.timezone = optionalBounded(changes.timezone, "timezone", 100);
  for (const key of ["website", "linkedin_url", "facebook_url", "x_url"]) {
    if (Object.hasOwn(changes, key)) {
      changes[key] = normalizeHttpUrl(changes[key], key);
    }
  }
  if (Object.hasOwn(changes, "note")) {
    changes.note = normalizePersonNote(changes.note);
  }
  if (
    changes.status != null &&
    !["active", "merged", "archived"].includes(`${changes.status}`)
  ) {
    throw Error("status must be one of: active, merged, archived");
  }
  return await mutate({
    action: "person.update",
    target: `person:${id}`,
    actor: requireActor(opts.account_id),
    reason: opts.reason,
    commit: opts.commit,
    expectedVersion: opts.expected_version,
    idempotencyKey: opts.idempotency_key,
    proposed: changes,
    resultType: "person",
    currentVersion: async (db) =>
      (await loadPerson(db, id, db !== getPool())).version,
    apply: async (client) => {
      const keys = Object.keys(changes);
      if (keys.length) {
        const values = keys.map((key) => changes[key]);
        values.push(opts.account_id, id);
        await client.query(
          `UPDATE crm_people SET ${keys.map((key, index) => `${key}=$${index + 1}`).join(",")},updated_by_account_id=$${keys.length + 1},updated_at=NOW(),version=version+1 WHERE id=$${keys.length + 2}`,
          values,
        );
      }
      return await loadPerson(client, id);
    },
  });
}

export async function mutatePersonEmail(
  opts: CrmPersonEmailMutationRequest,
): Promise<CrmMutationResult<CrmPersonEmail>> {
  await prepareRead(opts.reason);
  const personId = await resolvePersonId(getPool(), opts.person);
  const email = normalizeEmail(opts.email);
  const existing = await getPool().query(
    "SELECT * FROM crm_person_emails WHERE person_id=$1 AND normalized_email=$2",
    [personId, email],
  );
  const current = existing.rows[0] ? emailRow(existing.rows[0]) : undefined;
  if (opts.action === "remove" && !current)
    throw Error("person email was not found");
  const kind = assertEnum(
    opts.kind ?? current?.kind ?? "work",
    ["work", "billing", "personal", "other"] as const,
    "kind",
  );
  const isPrimary = opts.is_primary ?? current?.is_primary ?? false;
  const verified = opts.verified ?? current?.verified ?? false;
  const proposed = {
    person_id: personId,
    email_address: email,
    action: opts.action,
    kind,
    is_primary: isPrimary,
    verified,
  };
  return await mutate({
    action: `person-email.${opts.action}`,
    actor: requireActor(opts.account_id),
    reason: opts.reason,
    commit: opts.commit,
    expectedVersion: opts.expected_version,
    idempotencyKey: opts.idempotency_key,
    proposed,
    resultType: "person-email",
    currentVersion: async () => current?.version ?? 0,
    apply: async (client) => {
      if (opts.action === "remove") {
        await client.query("DELETE FROM crm_person_emails WHERE id=$1", [
          current!.id,
        ]);
        return current!;
      }
      const id = current?.id ?? randomUUID();
      if (proposed.is_primary)
        await client.query(
          "UPDATE crm_person_emails SET is_primary=FALSE,updated_at=NOW(),version=version+1 WHERE person_id=$1 AND id<>$2",
          [personId, id],
        );
      const { rows } = await client.query(
        `INSERT INTO crm_person_emails(id,person_id,email_address,normalized_email,kind,is_primary,verified) VALUES($1,$2,$3,$3,$4,$5,$6) ON CONFLICT(person_id,normalized_email) DO UPDATE SET email_address=EXCLUDED.email_address,kind=EXCLUDED.kind,is_primary=EXCLUDED.is_primary,verified=EXCLUDED.verified,updated_at=NOW(),version=crm_person_emails.version+1 RETURNING *`,
        [
          id,
          personId,
          email,
          proposed.kind,
          proposed.is_primary,
          proposed.verified,
        ],
      );
      return emailRow(rows[0]);
    },
  });
}

export async function mutatePersonAccount(
  opts: CrmPersonAccountMutationRequest,
): Promise<CrmMutationResult<CrmPersonAccount>> {
  await prepareRead(opts.reason);
  const personId = await resolvePersonId(getPool(), opts.person);
  const existing = await getPool().query(
    "SELECT * FROM crm_person_accounts WHERE person_id=$1 AND account_id=$2",
    [personId, opts.linked_account_id],
  );
  const current = existing.rows[0] ? accountRow(existing.rows[0]) : undefined;
  if (!isValidUUID(opts.linked_account_id))
    throw Error("linked_account_id must be a UUID");
  if (opts.action === "unlink" && !current)
    throw Error("person account link was not found");
  const state =
    opts.action === "verify"
      ? "verified"
      : opts.action === "reject"
        ? "rejected"
        : opts.action === "retire"
          ? "retired"
          : "suggested";
  const evidenceReference = optionalBounded(
    opts.evidence_reference,
    "evidence_reference",
    1_000,
  );
  const proposed = {
    person_id: personId,
    account_id: opts.linked_account_id,
    action: opts.action,
    state,
    evidence_reference: evidenceReference,
  };
  return await mutate({
    action: `person-account.${opts.action}`,
    actor: requireActor(opts.account_id),
    reason: opts.reason,
    commit: opts.commit,
    expectedVersion: opts.expected_version,
    idempotencyKey: opts.idempotency_key,
    proposed,
    resultType: "person-account",
    currentVersion: async () => current?.version ?? 0,
    apply: async (client) => {
      if (opts.action === "unlink") {
        await client.query("DELETE FROM crm_person_accounts WHERE id=$1", [
          current!.id,
        ]);
        return current!;
      }
      const { rows } = await client.query(
        `INSERT INTO crm_person_accounts(id,person_id,account_id,state,evidence_reference) VALUES($1,$2,$3,$4,$5) ON CONFLICT(person_id,account_id) DO UPDATE SET state=EXCLUDED.state,evidence_reference=EXCLUDED.evidence_reference,updated_at=NOW(),version=crm_person_accounts.version+1 RETURNING *`,
        [
          current?.id ?? randomUUID(),
          personId,
          proposed.account_id,
          proposed.state,
          proposed.evidence_reference,
        ],
      );
      return accountRow(rows[0]);
    },
  });
}

export async function mutateOrganizationPerson(
  opts: CrmOrganizationPersonMutationRequest,
): Promise<CrmMutationResult<CrmOrganizationPerson>> {
  await prepareRead(opts.reason);
  const organizationId = await resolveOrganizationId(
    getPool(),
    opts.organization,
  );
  const personId = await resolvePersonId(getPool(), opts.person);
  const existing = await getPool().query(
    "SELECT * FROM crm_organization_people WHERE organization_id=$1 AND person_id=$2",
    [organizationId, personId],
  );
  const current = existing.rows[0]
    ? relationshipRow(existing.rows[0])
    : undefined;
  if (opts.action === "unlink" && !current)
    throw Error("organization contact link was not found");
  if (opts.action === "unlink") {
    await assertPersonRelationshipCanBeUnlinked(
      getPool(),
      organizationId,
      personId,
    );
  }
  const roles = opts.roles ?? current?.roles ?? [];
  for (const role of roles) assertEnum(role, CRM_PERSON_ROLES, "role");
  const state = assertEnum(
    opts.state ?? current?.state ?? "active",
    ["active", "former", "retired"] as const,
    "state",
  );
  const proposed = {
    organization_id: organizationId,
    person_id: personId,
    action: opts.action,
    roles,
    title: optionalBounded(opts.title, "title", 300),
    department: optionalBounded(opts.department, "department", 300),
    state,
  };
  return await mutate({
    action: `organization-person.${opts.action}`,
    actor: requireActor(opts.account_id),
    reason: opts.reason,
    commit: opts.commit,
    expectedVersion: opts.expected_version,
    idempotencyKey: opts.idempotency_key,
    organizationId,
    proposed,
    resultType: "organization-person",
    currentVersion: async (db) => {
      const { rows } = await db.query<{ version: number }>(
        "SELECT version FROM crm_organization_people WHERE organization_id=$1 AND person_id=$2",
        [organizationId, personId],
      );
      return rows[0]?.version ?? 0;
    },
    apply: async (client, eventId) => {
      if (opts.action === "unlink") {
        await assertPersonRelationshipCanBeUnlinked(
          client,
          organizationId,
          personId,
          true,
        );
        const { rows } = await client.query(
          `DELETE FROM crm_organization_people
            WHERE id=$1 AND version=$2
            RETURNING *`,
          [current!.id, opts.expected_version],
        );
        if (!rows[0]) {
          throw Object.assign(
            Error(
              "organization contact link changed before it could be removed",
            ),
            { code: 409 },
          );
        }
        return relationshipRow(rows[0]);
      }
      const { rows } = await client.query(
        `INSERT INTO crm_organization_people(id,organization_id,person_id,roles,title,department,state)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(organization_id,person_id) DO UPDATE SET
           roles=EXCLUDED.roles,
           title=EXCLUDED.title,
           department=EXCLUDED.department,
           state=EXCLUDED.state,
           updated_at=NOW(),
           version=crm_organization_people.version+1
         WHERE crm_organization_people.version=$8
         RETURNING *`,
        [
          current?.id ?? randomUUID(),
          organizationId,
          personId,
          proposed.roles,
          proposed.title,
          proposed.department,
          proposed.state,
          opts.expected_version,
        ],
      );
      if (!rows[0]) {
        throw Object.assign(
          Error("organization contact link changed before it could be updated"),
          { code: 409 },
        );
      }
      await insertActivity(client, {
        organization_id: organizationId,
        person_id: personId,
        kind: "mutation",
        source: "crm",
        source_id: eventId,
        summary: `${opts.action} customer contact`,
        details: opts.reason,
        actor_account_id: opts.account_id,
        occurred_at: new Date().toISOString(),
      });
      return relationshipRow(rows[0]);
    },
  });
}

export async function createOpportunity(
  opts: CrmOpportunityCreateRequest,
): Promise<CrmMutationResult<CrmOpportunity>> {
  await prepareRead(opts.reason);
  const organizationId = await resolveOrganizationId(
    getPool(),
    opts.organization,
  );
  const proposed = {
    organization_id: organizationId,
    name: bounded(opts.name, "name", 500),
    kind: assertEnum(opts.kind, CRM_OPPORTUNITY_KINDS, "kind"),
    owner_account_id: opts.owner_account_id,
    expected_value: normalizeMoney(opts.expected_value),
    currency: `${opts.currency ?? "usd"}`.toLowerCase(),
    expected_close_date: dateOnly(opts.expected_close_date),
    service_starts_at:
      opts.service_starts_at == null
        ? null
        : isoRequired(opts.service_starts_at),
    service_ends_at:
      opts.service_ends_at == null ? null : isoRequired(opts.service_ends_at),
    source_zendesk_ticket_ids: [
      ...new Set(opts.source_zendesk_ticket_ids ?? []),
    ],
    description: optionalBounded(opts.description, "description", 10000),
  };
  if (!isValidUUID(proposed.owner_account_id))
    throw Error("owner_account_id must be a UUID");
  if (!/^[a-z]{3}$/.test(proposed.currency))
    throw Error("currency must be a three-letter ISO currency code");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(proposed.expected_close_date))
    throw Error("expected_close_date must be an ISO date");
  if (
    proposed.source_zendesk_ticket_ids.some(
      (id) => !Number.isInteger(id) || id <= 0,
    )
  ) {
    throw Error("source_zendesk_ticket_ids must contain positive integers");
  }
  return await mutate({
    action: "opportunity.create",
    actor: requireActor(opts.account_id),
    reason: opts.reason,
    commit: opts.commit,
    expectedVersion: opts.expected_version,
    idempotencyKey: opts.idempotency_key,
    organizationId,
    proposed,
    resultType: "opportunity",
    currentVersion: async () => 0,
    apply: async (client, eventId) => {
      const id = randomUUID();
      const { rows } = await client.query(
        `INSERT INTO crm_opportunities(id,organization_id,name,kind,stage,owner_account_id,expected_value,currency,expected_close_date,service_starts_at,service_ends_at,source_zendesk_ticket_ids,description,created_by_account_id,updated_by_account_id) VALUES($1,$2,$3,$4,'discovery',$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) RETURNING *`,
        [
          id,
          organizationId,
          proposed.name,
          proposed.kind,
          proposed.owner_account_id,
          proposed.expected_value,
          proposed.currency,
          proposed.expected_close_date,
          proposed.service_starts_at,
          proposed.service_ends_at,
          proposed.source_zendesk_ticket_ids,
          proposed.description,
          opts.account_id,
        ],
      );
      const result = opportunityRow(rows[0]);
      await insertActivity(client, {
        organization_id: organizationId,
        opportunity_id: id,
        kind: "opportunity",
        source: "crm",
        source_id: eventId,
        summary: `Created opportunity ${result.name}`,
        details: opts.reason,
        actor_account_id: opts.account_id,
        occurred_at: new Date().toISOString(),
      });
      return result;
    },
  });
}

export async function updateOpportunity(
  opts: CrmOpportunityUpdateRequest,
): Promise<CrmMutationResult<CrmOpportunity>> {
  await prepareRead(opts.reason);
  const id = await resolveOpportunityId(getPool(), opts.opportunity);
  const original = await loadOpportunity(getPool(), id);
  const changes: Json = {};
  for (const key of [
    "name",
    "kind",
    "owner_account_id",
    "expected_value",
    "currency",
    "expected_close_date",
    "service_starts_at",
    "service_ends_at",
    "source_zendesk_ticket_ids",
    "description",
  ])
    if (Object.hasOwn(opts.changes, key))
      changes[key] = (opts.changes as any)[key];
  if (changes.name != null) changes.name = bounded(changes.name, "name", 500);
  if (changes.expected_value != null)
    changes.expected_value = normalizeMoney(changes.expected_value);
  if (changes.kind != null)
    changes.kind = assertEnum(changes.kind, CRM_OPPORTUNITY_KINDS, "kind");
  if (
    changes.owner_account_id != null &&
    !isValidUUID(`${changes.owner_account_id}`)
  ) {
    throw Error("owner_account_id must be a UUID");
  }
  if (changes.currency != null) {
    changes.currency = bounded(changes.currency, "currency", 3).toLowerCase();
    if (!/^[a-z]{3}$/.test(`${changes.currency}`))
      throw Error("currency must be a three-letter ISO currency code");
  }
  if (changes.expected_close_date != null)
    changes.expected_close_date = dateOnly(changes.expected_close_date);
  for (const key of ["service_starts_at", "service_ends_at"] as const) {
    if (Object.hasOwn(changes, key))
      changes[key] = changes[key] == null ? null : isoRequired(changes[key]);
  }
  if (Object.hasOwn(changes, "source_zendesk_ticket_ids")) {
    if (!Array.isArray(changes.source_zendesk_ticket_ids))
      throw Error("source_zendesk_ticket_ids must be an array");
    const ticketIds = [...new Set(changes.source_zendesk_ticket_ids)];
    if (
      ticketIds.some((ticketId) => !Number.isInteger(ticketId) || ticketId <= 0)
    ) {
      throw Error("source_zendesk_ticket_ids must contain positive integers");
    }
    changes.source_zendesk_ticket_ids = ticketIds;
  }
  if (Object.hasOwn(changes, "description"))
    changes.description = optionalBounded(
      changes.description,
      "description",
      10_000,
    );
  return await mutate({
    action: "opportunity.update",
    target: `opportunity:${id}`,
    actor: requireActor(opts.account_id),
    reason: opts.reason,
    commit: opts.commit,
    expectedVersion: opts.expected_version,
    idempotencyKey: opts.idempotency_key,
    organizationId: original.organization_id,
    proposed: changes,
    resultType: "opportunity",
    currentVersion: async (db) =>
      (await loadOpportunity(db, id, db !== getPool())).version,
    apply: async (client) => {
      const keys = Object.keys(changes);
      if (keys.length) {
        const values = keys.map((k) => changes[k]);
        values.push(opts.account_id, id);
        await client.query(
          `UPDATE crm_opportunities SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(",")},updated_by_account_id=$${keys.length + 1},updated_at=NOW(),version=version+1 WHERE id=$${keys.length + 2}`,
          values,
        );
      }
      return await loadOpportunity(client, id);
    },
  });
}

const OPPORTUNITY_TRANSITIONS: Record<
  CrmOpportunityStage,
  readonly CrmOpportunityStage[]
> = {
  discovery: ["qualified", "lost", "on_hold"],
  qualified: ["proposal", "lost", "on_hold"],
  proposal: ["verbal_commitment", "lost", "on_hold"],
  verbal_commitment: ["procurement", "lost", "on_hold"],
  procurement: ["won", "lost", "on_hold"],
  on_hold: [
    "discovery",
    "qualified",
    "proposal",
    "verbal_commitment",
    "procurement",
    "lost",
  ],
  won: [],
  lost: [],
};

export async function transitionOpportunity(
  opts: CrmOpportunityTransitionRequest,
): Promise<CrmMutationResult<CrmOpportunity>> {
  await prepareRead(opts.reason);
  const id = await resolveOpportunityId(getPool(), opts.opportunity);
  const original = await loadOpportunity(getPool(), id);
  const stage = assertEnum(opts.stage, CRM_OPPORTUNITY_STAGES, "stage");
  if (!OPPORTUNITY_TRANSITIONS[original.stage].includes(stage))
    throw Error(
      `opportunity cannot transition from ${original.stage} to ${stage}`,
    );
  if (stage === "lost" && !`${opts.loss_reason ?? ""}`.trim())
    throw Error("loss_reason is required when an opportunity is lost");
  const lossReason = optionalBounded(opts.loss_reason, "loss_reason", 1_000);
  return await mutate({
    action: "opportunity.transition",
    target: `opportunity:${id}`,
    actor: requireActor(opts.account_id),
    reason: opts.reason,
    commit: opts.commit,
    expectedVersion: opts.expected_version,
    idempotencyKey: opts.idempotency_key,
    organizationId: original.organization_id,
    proposed: { stage, loss_reason: lossReason },
    resultType: "opportunity",
    currentVersion: async (db) =>
      (await loadOpportunity(db, id, db !== getPool())).version,
    apply: async (client, eventId) => {
      await client.query(
        "UPDATE crm_opportunities SET stage=$1,loss_reason=$2,updated_by_account_id=$3,updated_at=NOW(),version=version+1 WHERE id=$4",
        [stage, lossReason, opts.account_id, id],
      );
      const result = await loadOpportunity(client, id);
      await insertActivity(client, {
        organization_id: original.organization_id,
        opportunity_id: id,
        kind: "opportunity",
        source: "crm",
        source_id: eventId,
        summary: `Opportunity moved from ${original.stage} to ${stage}`,
        details: opts.reason,
        actor_account_id: opts.account_id,
        occurred_at: new Date().toISOString(),
      });
      return result;
    },
  });
}

export async function createTask(
  opts: CrmTaskCreateRequest,
): Promise<CrmMutationResult<CrmTask>> {
  await prepareRead(opts.reason);
  const organizationId = await resolveOrganizationId(
    getPool(),
    opts.organization,
  );
  const personId = opts.person
    ? await resolvePersonId(getPool(), opts.person)
    : null;
  const opportunityId = opts.opportunity
    ? await resolveOpportunityId(getPool(), opts.opportunity)
    : null;
  const commercialOrderId = optionalBounded(
    opts.commercial_order_id,
    "commercial_order_id",
    36,
  );
  if (commercialOrderId != null && !isValidUUID(commercialOrderId)) {
    throw Error("commercial_order_id must be a UUID");
  }
  const zendeskTicketId = opts.zendesk_ticket_id ?? null;
  if (
    zendeskTicketId != null &&
    (!Number.isInteger(zendeskTicketId) || zendeskTicketId <= 0)
  ) {
    throw Error("zendesk_ticket_id must be a positive integer");
  }
  const proposed = {
    organization_id: organizationId,
    person_id: personId,
    opportunity_id: opportunityId,
    commercial_order_id: commercialOrderId,
    zendesk_ticket_id: zendeskTicketId,
    type: assertEnum(opts.type, CRM_TASK_TYPES, "type"),
    assignee_account_id: opts.assignee_account_id,
    due_at: rfc3339TimestampRequired(opts.due_at, "due_at"),
    priority: assertEnum(
      opts.priority ?? "normal",
      CRM_TASK_PRIORITIES,
      "priority",
    ),
    subject: bounded(opts.subject, "subject", 500),
    details: optionalBounded(opts.details, "details", 10000),
  };
  if (!isValidUUID(proposed.assignee_account_id))
    throw Error("assignee_account_id must be a UUID");
  return await mutate({
    action: "task.create",
    actor: requireActor(opts.account_id),
    reason: opts.reason,
    commit: opts.commit,
    expectedVersion: opts.expected_version,
    idempotencyKey: opts.idempotency_key,
    organizationId,
    proposed,
    resultType: "task",
    currentVersion: async () => 0,
    apply: async (client, eventId) => {
      const id = randomUUID();
      const { rows } = await client.query(
        `INSERT INTO crm_tasks(id,organization_id,person_id,opportunity_id,commercial_order_id,zendesk_ticket_id,type,state,assignee_account_id,due_at,priority,subject,details,created_by_account_id,updated_by_account_id) VALUES($1,$2,$3,$4,$5,$6,$7,'open',$8,$9,$10,$11,$12,$13,$13) RETURNING *`,
        [
          id,
          organizationId,
          personId,
          opportunityId,
          proposed.commercial_order_id,
          proposed.zendesk_ticket_id,
          proposed.type,
          proposed.assignee_account_id,
          proposed.due_at,
          proposed.priority,
          proposed.subject,
          proposed.details,
          opts.account_id,
        ],
      );
      const result = taskRow(rows[0]);
      await insertActivity(client, {
        organization_id: organizationId,
        person_id: personId,
        opportunity_id: opportunityId,
        task_id: id,
        kind: "task",
        source: "crm",
        source_id: eventId,
        summary: `Created task: ${result.subject}`,
        details: opts.reason,
        actor_account_id: opts.account_id,
        occurred_at: new Date().toISOString(),
      });
      return result;
    },
  });
}

export async function updateTask(
  opts: CrmTaskUpdateRequest,
): Promise<CrmMutationResult<CrmTask>> {
  await prepareRead(opts.reason);
  const id = await resolveTaskId(getPool(), opts.task);
  const original = await loadTask(getPool(), id);
  const changes: Json = {};
  for (const key of [
    "type",
    "assignee_account_id",
    "due_at",
    "priority",
    "subject",
    "details",
  ])
    if (Object.hasOwn(opts.changes, key))
      changes[key] = (opts.changes as any)[key];
  if (changes.type != null)
    changes.type = assertEnum(changes.type, CRM_TASK_TYPES, "type");
  if (changes.priority != null)
    changes.priority = assertEnum(
      changes.priority,
      CRM_TASK_PRIORITIES,
      "priority",
    );
  if (
    changes.assignee_account_id != null &&
    !isValidUUID(`${changes.assignee_account_id}`)
  ) {
    throw Error("assignee_account_id must be a UUID");
  }
  if (changes.due_at != null)
    changes.due_at = rfc3339TimestampRequired(changes.due_at, "due_at");
  if (changes.subject != null)
    changes.subject = bounded(changes.subject, "subject", 500);
  if (Object.hasOwn(changes, "details"))
    changes.details = optionalBounded(changes.details, "details", 10_000);
  return await mutate({
    action: "task.update",
    target: `task:${id}`,
    actor: requireActor(opts.account_id),
    reason: opts.reason,
    commit: opts.commit,
    expectedVersion: opts.expected_version,
    idempotencyKey: opts.idempotency_key,
    organizationId: original.organization_id,
    proposed: changes,
    resultType: "task",
    currentVersion: async (db) =>
      (await loadTask(db, id, db !== getPool())).version,
    apply: async (client) => {
      const keys = Object.keys(changes);
      if (keys.length) {
        const values = keys.map((k) => changes[k]);
        values.push(opts.account_id, id);
        await client.query(
          `UPDATE crm_tasks SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(",")},updated_by_account_id=$${keys.length + 1},updated_at=NOW(),version=version+1 WHERE id=$${keys.length + 2}`,
          values,
        );
      }
      return await loadTask(client, id);
    },
  });
}

export async function transitionTask(
  opts: CrmTaskTransitionRequest,
): Promise<CrmMutationResult<CrmTask>> {
  await prepareRead(opts.reason);
  const id = await resolveTaskId(getPool(), opts.task);
  const original = await loadTask(getPool(), id);
  if (["completed", "cancelled"].includes(original.state)) {
    throw Error(`cannot ${opts.action} a ${original.state} task`);
  }
  if (opts.action === "assign" && !opts.assignee_account_id) {
    throw Error("assignee_account_id is required when assigning a task");
  }
  if (opts.action === "reschedule" && !opts.due_at) {
    throw Error("due_at is required when rescheduling a task");
  }
  const dueAt =
    opts.action === "reschedule"
      ? rfc3339TimestampRequired(opts.due_at, "due_at")
      : original.due_at;
  const assigneeAccountId =
    opts.assignee_account_id ?? original.assignee_account_id;
  if (!isValidUUID(assigneeAccountId))
    throw Error("assignee_account_id must be a UUID");
  const state =
    opts.action === "complete"
      ? "completed"
      : opts.action === "cancel"
        ? "cancelled"
        : original.state;
  return await mutate({
    action: `task.${opts.action}`,
    target: `task:${id}`,
    actor: requireActor(opts.account_id),
    reason: opts.reason,
    commit: opts.commit,
    expectedVersion: opts.expected_version,
    idempotencyKey: opts.idempotency_key,
    organizationId: original.organization_id,
    proposed: {
      state,
      assignee_account_id: assigneeAccountId,
      due_at: dueAt,
    },
    resultType: "task",
    currentVersion: async (db) =>
      (await loadTask(db, id, db !== getPool())).version,
    apply: async (client, eventId) => {
      await client.query(
        `UPDATE crm_tasks SET state=$1,assignee_account_id=$2,due_at=$3,updated_by_account_id=$4,updated_at=NOW(),version=version+1,completed_at=CASE WHEN $1='completed' THEN NOW() ELSE completed_at END,completed_by_account_id=CASE WHEN $1='completed' THEN $4::uuid ELSE completed_by_account_id END,cancelled_at=CASE WHEN $1='cancelled' THEN NOW() ELSE cancelled_at END,cancelled_by_account_id=CASE WHEN $1='cancelled' THEN $4::uuid ELSE cancelled_by_account_id END WHERE id=$5`,
        [state, assigneeAccountId, dueAt, opts.account_id, id],
      );
      const result = await loadTask(client, id);
      await insertActivity(client, {
        organization_id: original.organization_id,
        task_id: id,
        kind: "task",
        source: "crm",
        source_id: eventId,
        summary: `${opts.action} task: ${original.subject}`,
        details: opts.reason,
        actor_account_id: opts.account_id,
        occurred_at: new Date().toISOString(),
      });
      return result;
    },
  });
}

export async function addActivity(
  opts: CrmActivityCreateRequest,
): Promise<CrmMutationResult<CrmActivity>> {
  await prepareRead(opts.reason);
  const organizationId = await resolveOrganizationId(
    getPool(),
    opts.organization,
  );
  const personId = opts.person
    ? await resolvePersonId(getPool(), opts.person)
    : null;
  const opportunityId = opts.opportunity
    ? await resolveOpportunityId(getPool(), opts.opportunity)
    : null;
  const taskId = opts.task ? await resolveTaskId(getPool(), opts.task) : null;
  const kind = assertEnum(
    opts.kind,
    ["note", "call", "meeting"] as const,
    "kind",
  );
  assertSafeText(opts.summary, "summary");
  assertSafeText(opts.details, "details");
  if (
    opts.supersedes_activity_id != null &&
    !isValidUUID(opts.supersedes_activity_id)
  ) {
    throw Error("supersedes_activity_id must be a UUID");
  }
  const proposed = {
    organization_id: organizationId,
    person_id: personId,
    opportunity_id: opportunityId,
    task_id: taskId,
    kind,
    source: "manual",
    summary: bounded(opts.summary, "summary", 1_000),
    details: optionalBounded(opts.details, "details", 10_000),
    occurred_at: rfc3339TimestampRequired(opts.occurred_at, "occurred_at"),
    supersedes_activity_id: opts.supersedes_activity_id ?? null,
  };
  return await mutate({
    action: `activity.${kind}`,
    actor: requireActor(opts.account_id),
    reason: opts.reason,
    commit: opts.commit,
    expectedVersion: opts.expected_version,
    idempotencyKey: opts.idempotency_key,
    organizationId,
    proposed,
    resultType: "activity",
    currentVersion: async () => 0,
    apply: async (client, eventId) =>
      await insertActivity(client, {
        organization_id: organizationId,
        person_id: proposed.person_id,
        opportunity_id: proposed.opportunity_id,
        task_id: proposed.task_id,
        kind: proposed.kind,
        source: proposed.source,
        source_id: eventId,
        summary: proposed.summary,
        details: proposed.details,
        actor_account_id: opts.account_id,
        occurred_at: proposed.occurred_at,
        supersedes_activity_id: proposed.supersedes_activity_id,
      }),
  });
}

export async function mutateExternalReference(
  opts: CrmExternalReferenceMutationRequest,
): Promise<CrmMutationResult<CrmExternalReference>> {
  await prepareRead(opts.reason);
  const organizationId = await resolveOrganizationId(
    getPool(),
    opts.organization,
  );
  const resolvedPersonId = opts.person
    ? await resolvePersonId(getPool(), opts.person)
    : null;
  const personId =
    opts.object_kind === "person" && opts.action === "reject"
      ? null
      : resolvedPersonId;
  if (opts.object_kind === "person" && opts.opportunity) {
    throw Error("opportunity is not allowed for a person external reference");
  }
  const opportunityId = opts.opportunity
    ? await resolveOpportunityId(getPool(), opts.opportunity)
    : null;
  assertEnum(opts.provider, CRM_EXTERNAL_PROVIDERS, "provider");
  assertEnum(opts.object_kind, CRM_EXTERNAL_OBJECT_KINDS, "object_kind");
  if (opts.action !== "remove" && personId) {
    await assertPersonOrganizationRelationship(
      getPool(),
      organizationId,
      personId,
    );
  }
  if (opts.action !== "remove" && opportunityId) {
    await assertOpportunityOrganization(
      getPool(),
      organizationId,
      opportunityId,
    );
  }
  if (
    opts.object_kind === "person" &&
    opts.action !== "reject" &&
    opts.action !== "remove"
  ) {
    if (!personId) {
      throw Error("person is required for a person external reference");
    }
  }
  let externalId = bounded(opts.external_id, "external_id", 500);
  if (opts.provider === "cocalc" && opts.object_kind === "commercial_order") {
    const { rows } = await getPool().query<{
      id: string;
      crm_organization_id: string | null;
    }>(
      "SELECT id,crm_organization_id FROM commercial_orders WHERE id::text=$1 OR lower(order_number)=lower($1) LIMIT 2",
      [externalId],
    );
    if (!rows[0]) throw Error(`commercial order '${externalId}' was not found`);
    if (rows.length > 1)
      throw Error(`commercial order selector '${externalId}' is ambiguous`);
    if (
      rows[0].crm_organization_id &&
      rows[0].crm_organization_id !== organizationId
    ) {
      throw Object.assign(
        Error("commercial order is already linked to another customer"),
        { code: 409 },
      );
    }
    externalId = rows[0].id;
  }
  if (opts.provider === "cocalc" && opts.object_kind === "site_license") {
    const { rows } = await getPool().query<{
      id: string;
      crm_organization_id: string | null;
    }>(
      "SELECT id,crm_organization_id FROM site_licenses WHERE id::text=$1 OR lower(name)=lower($1) LIMIT 2",
      [externalId],
    );
    if (!rows[0]) throw Error(`site license '${externalId}' was not found`);
    if (rows.length > 1)
      throw Error(`site license selector '${externalId}' is ambiguous`);
    if (
      rows[0].crm_organization_id &&
      rows[0].crm_organization_id !== organizationId
    ) {
      throw Object.assign(
        Error("site license is already linked to another customer"),
        { code: 409 },
      );
    }
    externalId = rows[0].id;
  }
  const metadata = opts.metadata ?? {};
  if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > 10000)
    throw Error("metadata must be at most 10000 bytes");
  assertSafeText(JSON.stringify(metadata), "metadata");
  const existing = await getPool().query(
    "SELECT * FROM crm_external_references WHERE provider=$1 AND object_kind=$2 AND external_id=$3",
    [opts.provider, opts.object_kind, externalId],
  );
  const current = existing.rows[0]
    ? externalReferenceRow(existing.rows[0])
    : undefined;
  if (current && current.organization_id !== organizationId) {
    throw Object.assign(
      Error(
        `${opts.provider} ${opts.object_kind} '${externalId}' is already linked to another customer; remove that reviewed link before reassigning it`,
      ),
      {
        code: 409,
        current_organization_id: current.organization_id,
      },
    );
  }
  if (
    opts.object_kind === "person" &&
    opts.action !== "reject" &&
    opts.action !== "remove" &&
    current?.person_id != null &&
    current.person_id !== personId
  ) {
    throw Object.assign(
      Error(
        `${opts.provider} person '${externalId}' is already linked to another person; remove that reviewed link before reassigning it`,
      ),
      { code: 409, current_person_id: current.person_id },
    );
  }
  const state =
    opts.action === "verify"
      ? "verified"
      : opts.action === "reject"
        ? "rejected"
        : "suggested";
  if (
    opts.provider === "zendesk" &&
    opts.object_kind === "ticket" &&
    (!/^\d+$/.test(externalId) || Number(externalId) <= 0)
  ) {
    throw Error("Zendesk ticket external_id must be a positive integer");
  }
  if (opts.action === "remove" && !current)
    throw Error("external reference was not found");
  const label = optionalBounded(opts.label, "label", 500);
  const proposed = {
    organization_id: organizationId,
    person_id: personId,
    opportunity_id: opportunityId,
    action: opts.action,
    provider: opts.provider,
    object_kind: opts.object_kind,
    external_id: externalId,
    label,
    metadata,
    verification_state: state,
  };
  return await mutate({
    action: `external-reference.${opts.action}`,
    actor: requireActor(opts.account_id),
    reason: opts.reason,
    commit: opts.commit,
    expectedVersion: opts.expected_version,
    idempotencyKey: opts.idempotency_key,
    organizationId,
    proposed,
    resultType: "external-reference",
    currentVersion: async (db) => {
      const { rows } = await db.query<{ version: number }>(
        "SELECT version FROM crm_external_references WHERE provider=$1 AND object_kind=$2 AND external_id=$3",
        [proposed.provider, proposed.object_kind, proposed.external_id],
      );
      return rows[0]?.version ?? 0;
    },
    apply: async (client, eventId) => {
      if (opts.action !== "remove" && personId) {
        await assertPersonOrganizationRelationship(
          client,
          organizationId,
          personId,
          true,
        );
      }
      if (opts.action !== "remove" && opportunityId) {
        await assertOpportunityOrganization(
          client,
          organizationId,
          opportunityId,
          true,
        );
      }
      if (opts.action === "remove") {
        const removed = await client.query(
          `DELETE FROM crm_external_references
            WHERE id=$1 AND organization_id=$2 AND version=$3
            RETURNING *`,
          [current!.id, organizationId, opts.expected_version],
        );
        if (!removed.rows[0]) {
          throw Object.assign(
            Error("CRM external reference changed before it could be removed"),
            { code: 409 },
          );
        }
        if (
          opts.provider === "cocalc" &&
          opts.object_kind === "commercial_order"
        )
          await client.query(
            "UPDATE commercial_orders SET crm_organization_id=NULL WHERE id=$1 AND crm_organization_id=$2",
            [externalId, organizationId],
          );
        if (opts.provider === "cocalc" && opts.object_kind === "site_license")
          await client.query(
            "UPDATE site_licenses SET crm_organization_id=NULL WHERE id=$1 AND crm_organization_id=$2",
            [externalId, organizationId],
          );
        return externalReferenceRow(removed.rows[0]);
      }
      const { rows } = await client.query(
        `INSERT INTO crm_external_references(id,organization_id,person_id,opportunity_id,provider,object_kind,external_id,label,metadata,verification_state,created_by_account_id,updated_by_account_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
         ON CONFLICT(provider,object_kind,external_id) DO UPDATE SET
           person_id=EXCLUDED.person_id,
           opportunity_id=EXCLUDED.opportunity_id,
           label=EXCLUDED.label,
           metadata=EXCLUDED.metadata,
           verification_state=EXCLUDED.verification_state,
           updated_by_account_id=EXCLUDED.updated_by_account_id,
           updated_at=NOW(),
           version=crm_external_references.version+1
         WHERE crm_external_references.organization_id=EXCLUDED.organization_id
           AND crm_external_references.version=$12
           AND (EXCLUDED.verification_state='rejected'
             OR crm_external_references.object_kind<>'person'
             OR crm_external_references.person_id IS NULL
             OR crm_external_references.person_id=EXCLUDED.person_id)
         RETURNING *`,
        [
          current?.id ?? randomUUID(),
          organizationId,
          personId,
          opportunityId,
          proposed.provider,
          proposed.object_kind,
          proposed.external_id,
          proposed.label,
          proposed.metadata,
          proposed.verification_state,
          opts.account_id,
          opts.expected_version,
        ],
      );
      if (!rows[0]) {
        const conflict = await client.query<{
          organization_id: string;
          version: number;
        }>(
          "SELECT organization_id,version FROM crm_external_references WHERE provider=$1 AND object_kind=$2 AND external_id=$3",
          [proposed.provider, proposed.object_kind, proposed.external_id],
        );
        const actual = conflict.rows[0];
        const message =
          actual?.organization_id !== organizationId
            ? `${opts.provider} ${opts.object_kind} '${externalId}' became linked to another customer`
            : "CRM external reference changed before it could be updated";
        throw Object.assign(Error(message), {
          code: 409,
          expected_version: opts.expected_version,
          current_version: actual?.version,
          current_organization_id: actual?.organization_id,
        });
      }
      if (
        opts.provider === "cocalc" &&
        ["commercial_order", "site_license"].includes(opts.object_kind)
      ) {
        const table =
          opts.object_kind === "commercial_order"
            ? "commercial_orders"
            : "site_licenses";
        const backlink = await client.query(
          `UPDATE ${table}
              SET crm_organization_id=$1
            WHERE id=$2
              AND (crm_organization_id IS NULL OR crm_organization_id=$3)
            RETURNING id`,
          [
            proposed.verification_state === "verified" ? organizationId : null,
            externalId,
            organizationId,
          ],
        );
        if (!backlink.rows[0]) {
          throw Object.assign(
            Error(
              `${opts.object_kind} changed or was linked to another customer`,
            ),
            { code: 409 },
          );
        }
      }
      const result = externalReferenceRow(rows[0]);
      const activityVerb =
        proposed.verification_state === "verified"
          ? "Verified"
          : proposed.verification_state === "rejected"
            ? "Rejected"
            : "Suggested";
      await insertActivity(client, {
        organization_id: organizationId,
        person_id: personId,
        opportunity_id: opportunityId,
        commercial_order_id:
          opts.object_kind === "commercial_order" ? externalId : null,
        site_license_id:
          opts.object_kind === "site_license" ? externalId : null,
        zendesk_ticket_id:
          opts.provider === "zendesk" && opts.object_kind === "ticket"
            ? Number(externalId)
            : null,
        kind:
          opts.provider === "zendesk"
            ? "zendesk"
            : opts.provider === "stripe"
              ? "stripe"
              : "mutation",
        source: "crm",
        source_id: eventId,
        summary: `${activityVerb} ${opts.provider} ${opts.object_kind} ${externalId}`,
        details: opts.reason,
        actor_account_id: opts.account_id,
        occurred_at: new Date().toISOString(),
      });
      return result;
    },
  });
}

export async function createOrderFromOpportunity(
  opts: CrmOrderFromOpportunityRequest,
): Promise<CrmMutationResult<any>> {
  await prepareRead(opts.reason);
  const opportunityId = await resolveOpportunityId(getPool(), opts.opportunity);
  const opportunity = await loadOpportunity(getPool(), opportunityId);
  const organization = await loadOrganization(
    getPool(),
    opportunity.organization_id,
  );
  let billingPerson: CrmPerson | undefined;
  if (opts.billing_contact_person)
    billingPerson = await loadPerson(
      getPool(),
      await resolvePersonId(getPool(), opts.billing_contact_person),
    );
  if (opportunity.commercial_order_id)
    throw Error("opportunity already has a commercial order");
  if (opportunity.stage !== "procurement") {
    throw Error(
      `opportunity must be in procurement before creating a commercial order (current stage: ${opportunity.stage})`,
    );
  }
  const primaryEmail =
    billingPerson?.emails.find((x) => x.is_primary) ?? billingPerson?.emails[0];
  const collectionMode = assertEnum(
    opts.collection_mode ?? "stripe_invoice",
    COMMERCIAL_COLLECTION_MODES,
    "collection_mode",
  );
  const nextAction = assertEnum(
    opts.next_action,
    COMMERCIAL_NEXT_ACTIONS,
    "next_action",
  );
  const nextActionDueAt = opts.next_action_due_at
    ? isoRequired(opts.next_action_due_at)
    : null;
  const paymentTermsDays = opts.payment_terms_days ?? 21;
  if (
    !Number.isInteger(paymentTermsDays) ||
    paymentTermsDays < 0 ||
    paymentTermsDays > 365
  ) {
    throw Error("payment_terms_days must be an integer from 0 to 365");
  }
  const contacts =
    billingPerson && primaryEmail
      ? [
          {
            crm_person_id: billingPerson.id,
            role: "billing" as const,
            name_snapshot: billingPerson.display_name,
            email_snapshot: primaryEmail.email_address,
          },
        ]
      : [];
  const proposed = {
    opportunity_id: opportunityId,
    organization_id: organization.id,
    organization_name: organization.legal_name ?? organization.display_name,
    opportunity_stage: opportunity.stage,
    resulting_opportunity_stage: "won",
    currency: opportunity.currency,
    agreed_subtotal: opportunity.expected_value,
    agreed_total: opportunity.expected_value,
    service_starts_at: opportunity.service_starts_at ?? null,
    service_ends_at: opportunity.service_ends_at ?? null,
    zendesk_ticket_ids: opportunity.source_zendesk_ticket_ids,
    collection_mode: collectionMode,
    payment_terms_days: paymentTermsDays,
    assignee_account_id: opportunity.owner_account_id,
    next_action: nextAction,
    next_action_due_at: nextActionDueAt,
    contacts,
    items: [
      {
        description: opportunity.name,
        product_kind: "custom",
        quantity: "1",
        unit_amount: opportunity.expected_value,
        subtotal: opportunity.expected_value,
      },
    ],
  };
  return await mutate({
    action: "opportunity.create-order",
    actor: requireActor(opts.account_id),
    reason: opts.reason,
    commit: opts.commit,
    expectedVersion: opts.expected_version,
    idempotencyKey: opts.idempotency_key,
    organizationId: organization.id,
    proposed,
    resultType: "commercial-order",
    currentVersion: async (db) =>
      (await loadOpportunity(db, opportunityId, db !== getPool())).version,
    apply: async (client, eventId) => {
      const order = await createCommercialOrder({
        account_id: opts.account_id,
        reason: opts.reason,
        source: "cli",
        idempotency_key: `crm-order:${opts.idempotency_key}`,
        organization_name: proposed.organization_name,
        crm_organization_id: proposed.organization_id,
        zendesk_ticket_ids: proposed.zendesk_ticket_ids,
        workflow_state: "draft",
        collection_mode: proposed.collection_mode,
        currency: proposed.currency,
        agreed_subtotal: proposed.agreed_subtotal,
        agreed_total: proposed.agreed_total,
        service_starts_at: proposed.service_starts_at ?? undefined,
        service_ends_at: proposed.service_ends_at ?? undefined,
        payment_terms_days: proposed.payment_terms_days,
        assignee_account_id: proposed.assignee_account_id,
        next_action: proposed.next_action,
        next_action_due_at: proposed.next_action_due_at ?? undefined,
        items: proposed.items,
        contacts: proposed.contacts,
      });
      await client.query(
        "UPDATE crm_opportunities SET stage='won',commercial_order_id=$1,updated_by_account_id=$2,updated_at=NOW(),version=version+1 WHERE id=$3",
        [order.id, opts.account_id, opportunityId],
      );
      await insertActivity(client, {
        organization_id: organization.id,
        opportunity_id: opportunityId,
        commercial_order_id: order.id,
        kind: "commercial_order",
        source: "crm",
        source_id: eventId,
        summary: `Created commercial order ${order.order_number}`,
        details: opts.reason,
        actor_account_id: opts.account_id,
        occurred_at: new Date().toISOString(),
      });
      return order;
    },
  });
}

function digestTaskRow(row: any): CrmDailyDigest["overdue_tasks"][number] {
  const {
    digest_organization_id,
    digest_customer_number,
    digest_organization_name,
    ...task
  } = row;
  return {
    task: taskRow(task),
    organization: {
      id: digest_organization_id,
      customer_number: digest_customer_number,
      display_name: digest_organization_name,
    },
  };
}

function digestOpportunityRow(
  row: any,
): CrmDailyDigest["renewal_opportunities"][number] {
  const {
    digest_organization_id,
    digest_customer_number,
    digest_organization_name,
    ...opportunity
  } = row;
  return {
    opportunity: opportunityRow(opportunity),
    organization: {
      id: digest_organization_id,
      customer_number: digest_customer_number,
      display_name: digest_organization_name,
    },
  };
}

export async function getDailyDigest(
  opts: CrmDailyDigestRequest,
): Promise<CrmDailyDigest> {
  await prepareRead(opts.reason);
  const asOfDate = opts.as_of ? new Date(opts.as_of) : new Date();
  if (!Number.isFinite(asOfDate.valueOf())) {
    throw Error("as_of must be a valid ISO timestamp");
  }
  const boundedDays = (value: unknown, fallback: number, max: number) => {
    const parsed = Number(value ?? fallback);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) {
      throw Error(`digest day windows must be integers from 0 through ${max}`);
    }
    return parsed;
  };
  const dueDays = boundedDays(opts.due_within_days, 1, 31);
  const renewalDays = boundedDays(opts.renewal_within_days, 90, 730);
  const limit = pageLimit(opts.limit);
  const asOf = asOfDate.toISOString();
  const dueBefore = new Date(
    asOfDate.valueOf() + dueDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const renewalBefore = new Date(
    asOfDate.valueOf() + renewalDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const assignee = `${opts.assignee_account_id ?? ""}`.trim() || null;
  const taskSelect = `SELECT t.*,o.id digest_organization_id,o.customer_number digest_customer_number,
                             o.display_name digest_organization_name
                        FROM crm_tasks t JOIN crm_organizations o ON o.id=t.organization_id
                       WHERE t.state IN ('open','waiting') AND o.status='active'
                         AND ($3::uuid IS NULL OR t.assignee_account_id=$3::uuid)`;
  const orderSelect = `SELECT c.id,c.order_number,c.organization_name,c.workflow_state,
                              c.collection_state,c.fulfillment_state,c.assignee_account_id,
                              c.next_action,c.next_action_due_at,c.crm_organization_id,
                              o.customer_number,o.display_name crm_organization_name
                         FROM commercial_orders c
                         LEFT JOIN crm_organizations o ON o.id=c.crm_organization_id
                        WHERE c.workflow_state NOT IN ('complete','cancelled')
                          AND c.next_action_due_at IS NOT NULL
                          AND ($3::uuid IS NULL OR c.assignee_account_id=$3::uuid)`;
  const opportunitySelect = `SELECT q.*,o.id digest_organization_id,o.customer_number digest_customer_number,
                                     o.display_name digest_organization_name
                                FROM crm_opportunities q JOIN crm_organizations o ON o.id=q.organization_id
                               WHERE q.stage NOT IN ('won','lost') AND o.status='active'
                                 AND ($3::uuid IS NULL OR q.owner_account_id=$3::uuid)`;
  const [
    overdueTasksResult,
    dueSoonTasksResult,
    overdueOrdersResult,
    dueSoonOrdersResult,
    renewalResult,
    expansionResult,
    unassignedResult,
  ] = await Promise.all([
    getPool().query(
      `${taskSelect} AND t.due_at<$1::timestamptz ORDER BY t.due_at,t.id LIMIT $2`,
      [asOf, limit + 1, assignee],
    ),
    getPool().query(
      `${taskSelect} AND t.due_at>=$1::timestamptz AND t.due_at<=$4::timestamptz ORDER BY t.due_at,t.id LIMIT $2`,
      [asOf, limit + 1, assignee, dueBefore],
    ),
    getPool().query(
      `${orderSelect} AND c.next_action_due_at<$1::timestamptz ORDER BY c.next_action_due_at,c.id LIMIT $2`,
      [asOf, limit + 1, assignee],
    ),
    getPool().query(
      `${orderSelect} AND c.next_action_due_at>=$1::timestamptz AND c.next_action_due_at<=$4::timestamptz ORDER BY c.next_action_due_at,c.id LIMIT $2`,
      [asOf, limit + 1, assignee, dueBefore],
    ),
    getPool().query(
      `${opportunitySelect} AND q.kind='renewal' AND q.expected_close_date>=$1::date AND q.expected_close_date<=$4::date ORDER BY q.expected_close_date,q.id LIMIT $2`,
      [asOf, limit + 1, assignee, renewalBefore],
    ),
    getPool().query(
      `SELECT q.*,o.id digest_organization_id,o.customer_number digest_customer_number,
              o.display_name digest_organization_name
         FROM crm_opportunities q JOIN crm_organizations o ON o.id=q.organization_id
        WHERE q.stage NOT IN ('won','lost') AND o.status='active'
          AND ($1::uuid IS NULL OR q.owner_account_id=$1::uuid)
          AND q.kind='expansion'
        ORDER BY q.expected_close_date,q.id LIMIT $2`,
      [assignee, limit + 1],
    ),
    listOrganizations({
      reason: opts.reason,
      statuses: ["active"],
      unassigned: true,
      limit,
    }),
  ]);
  const overdueTasks = overdueTasksResult.rows
    .slice(0, limit)
    .map(digestTaskRow);
  const dueSoonTasks = dueSoonTasksResult.rows
    .slice(0, limit)
    .map(digestTaskRow);
  const overdueOrders = overdueOrdersResult.rows.slice(0, limit).map((row) => ({
    ...row,
    next_action_due_at: iso(row.next_action_due_at),
  }));
  const dueSoonOrders = dueSoonOrdersResult.rows.slice(0, limit).map((row) => ({
    ...row,
    next_action_due_at: iso(row.next_action_due_at),
  }));
  const renewals = renewalResult.rows.slice(0, limit).map(digestOpportunityRow);
  const expansions = expansionResult.rows
    .slice(0, limit)
    .map(digestOpportunityRow);
  const truncated =
    overdueTasksResult.rows.length > limit ||
    dueSoonTasksResult.rows.length > limit ||
    overdueOrdersResult.rows.length > limit ||
    dueSoonOrdersResult.rows.length > limit ||
    renewalResult.rows.length > limit ||
    expansionResult.rows.length > limit ||
    unassignedResult.truncated;
  return {
    generated_at: new Date().toISOString(),
    as_of: asOf,
    due_before: dueBefore,
    renewal_before: renewalBefore,
    overdue_tasks: overdueTasks,
    due_soon_tasks: dueSoonTasks,
    overdue_commercial_actions: overdueOrders,
    due_soon_commercial_actions: dueSoonOrders,
    renewal_opportunities: renewals,
    expansion_opportunities: expansions,
    unassigned_organizations: unassignedResult.organizations,
    counts: {
      overdue_tasks: overdueTasks.length,
      due_soon_tasks: dueSoonTasks.length,
      overdue_commercial_actions: overdueOrders.length,
      due_soon_commercial_actions: dueSoonOrders.length,
      renewal_opportunities: renewals.length,
      expansion_opportunities: expansions.length,
      unassigned_organizations: unassignedResult.organizations.length,
    },
    truncated,
    provenance: {
      authority: "seed control plane",
      tasks: "open and waiting CRM tasks",
      commercial_actions: "nonterminal commercial-order next actions",
      opportunities: "nonterminal reviewed CRM opportunities",
      unassigned_customers: "active CRM organizations without an owner",
      counts: truncated
        ? `bounded to ${limit} records per section`
        : "complete within the requested windows",
    },
  };
}

export async function getDiagnostics(
  opts: CrmDiagnosticsRequest,
): Promise<CrmDiagnostics> {
  await prepareRead(opts.reason);
  const limit = Math.min(opts.limit ?? 100, 500);
  const [
    runtimeContract,
    duplicates,
    conflicts,
    unowned,
    noTask,
    overdue,
    wonNoOrder,
    ordersNoOrg,
    licensesNoOrg,
    merged,
    peopleConflicts,
    timelineGaps,
    duplicateTimelineSources,
    failedExternalSync,
    stale,
  ] = await Promise.all([
    getCrmRuntimeContract(),
    getPool().query(
      `SELECT normalized_domain,array_agg(organization_id) organization_ids,count(*)::integer count FROM crm_organization_domains WHERE state='verified' GROUP BY normalized_domain HAVING count(*)>1 LIMIT $1`,
      [limit],
    ),
    getPool().query(
      `SELECT provider,object_kind,external_id,array_agg(organization_id) organization_ids,count(*)::integer count FROM crm_external_references WHERE verification_state='verified' GROUP BY provider,object_kind,external_id HAVING count(*)>1 LIMIT $1`,
      [limit],
    ),
    listOrganizations({
      reason: opts.reason,
      owner_account_id: null,
      statuses: ["active"],
      limit,
    }),
    getPool().query(
      `SELECT o.* FROM crm_opportunities o WHERE stage NOT IN('won','lost') AND NOT EXISTS(SELECT 1 FROM crm_tasks t WHERE t.opportunity_id=o.id AND t.state IN('open','waiting')) LIMIT $1`,
      [limit],
    ),
    getPool().query(
      `SELECT * FROM crm_tasks WHERE state IN('open','waiting') AND due_at<NOW() ORDER BY due_at LIMIT $1`,
      [limit],
    ),
    getPool().query(
      `SELECT * FROM crm_opportunities WHERE stage='won' AND commercial_order_id IS NULL LIMIT $1`,
      [limit],
    ),
    getPool().query(
      `SELECT id,order_number,organization_name,updated_at FROM commercial_orders WHERE crm_organization_id IS NULL ORDER BY updated_at DESC LIMIT $1`,
      [limit],
    ),
    getPool().query(
      `SELECT id,name,organization_name,updated FROM site_licenses WHERE crm_organization_id IS NULL ORDER BY updated DESC LIMIT $1`,
      [limit],
    ),
    getPool().query(
      `SELECT id,customer_number,status,merged_into_organization_id FROM crm_organizations o WHERE status='merged' AND (EXISTS(SELECT 1 FROM commercial_orders c WHERE c.crm_organization_id=o.id) OR EXISTS(SELECT 1 FROM site_licenses s WHERE s.crm_organization_id=o.id)) LIMIT $1`,
      [limit],
    ),
    getPool().query(
      `SELECT 'email' kind,normalized_email reference,array_agg(person_id) person_ids,count(*)::integer count
         FROM crm_person_emails WHERE verified
        GROUP BY normalized_email HAVING count(DISTINCT person_id)>1
       UNION ALL
       SELECT 'account' kind,account_id::text reference,array_agg(person_id) person_ids,count(*)::integer count
         FROM crm_person_accounts WHERE state='verified'
        GROUP BY account_id HAVING count(DISTINCT person_id)>1
       LIMIT $1`,
      [limit],
    ),
    getPool().query(
      `SELECT 'commercial_order' kind,o.id::text source_id,o.crm_organization_id organization_id
         FROM commercial_orders o
        WHERE o.crm_organization_id IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM commercial_order_events e WHERE e.commercial_order_id=o.id)
       UNION ALL
       SELECT 'site_license' kind,s.id::text source_id,s.crm_organization_id organization_id
         FROM site_licenses s
        WHERE s.crm_organization_id IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM crm_activities a WHERE a.site_license_id=s.id)
       LIMIT $1`,
      [limit],
    ),
    getPool().query(
      `SELECT organization_id,source,source_id,array_agg(id) activity_ids,count(*)::integer count
         FROM crm_activities WHERE source_id IS NOT NULL
        GROUP BY organization_id,source,source_id HAVING count(*)>1 LIMIT $1`,
      [limit],
    ),
    getPool().query(
      `SELECT id,organization_id,provider,object_kind,external_id,
              metadata->>'sync_state' sync_state,metadata->>'sync_error' sync_error
         FROM crm_external_references
        WHERE metadata->>'sync_state' IN ('failed','indeterminate')
           OR COALESCE(metadata->>'sync_error','')<>''
        ORDER BY updated_at DESC LIMIT $1`,
      [limit],
    ),
    getPool().query<{ organization_id: string }>(
      `SELECT o.id organization_id FROM crm_organizations o LEFT JOIN LATERAL(SELECT generated_at FROM crm_metric_snapshots m WHERE m.organization_id=o.id ORDER BY generated_at DESC LIMIT 1)m ON TRUE WHERE o.status='active' AND (m.generated_at IS NULL OR m.generated_at<NOW()-INTERVAL '2 days') LIMIT $1`,
      [limit],
    ),
  ]);
  return {
    checked_at: new Date().toISOString(),
    runtime_contract: runtimeContract,
    duplicate_verified_domains: duplicates.rows,
    conflicting_external_references: conflicts.rows,
    active_organizations_without_owner: unowned.organizations,
    open_opportunities_without_task: noTask.rows.map(opportunityRow),
    overdue_tasks: overdue.rows.map(taskRow),
    won_opportunities_without_order: wonNoOrder.rows.map(opportunityRow),
    commercial_orders_without_organization: ordersNoOrg.rows,
    site_licenses_without_organization: licensesNoOrg.rows,
    merged_records_still_referenced: merged.rows,
    conflicting_person_relationships: peopleConflicts.rows,
    timeline_source_gaps: timelineGaps.rows,
    duplicate_timeline_sources: duplicateTimelineSources.rows,
    failed_external_reference_sync: failedExternalSync.rows,
    stale_metric_projections: stale.rows.map((x) => x.organization_id),
  };
}

export async function backfill(
  opts: CrmBackfillRequest,
): Promise<CrmBackfillResponse> {
  await prepareRead(opts.reason);
  const limit = Math.min(opts.limit ?? 100, 500);
  const [orders, licenses] = await Promise.all([
    getPool().query(
      `SELECT id,organization_name,customer_account_id,zendesk_ticket_ids,stripe_customer_id FROM commercial_orders WHERE crm_organization_id IS NULL ORDER BY updated_at DESC LIMIT $1`,
      [limit],
    ),
    getPool().query(
      `SELECT id,organization_name,owner_account_id,allowed_domains FROM site_licenses WHERE crm_organization_id IS NULL ORDER BY updated DESC LIMIT $1`,
      [limit],
    ),
  ]);
  const byName = new Map<string, CrmBackfillCandidate>();
  const add = (name: string) => {
    const key = name.trim().toLowerCase();
    let candidate = byName.get(key);
    if (!candidate) {
      candidate = {
        candidate_key: `organization:${payloadHash(key).slice(0, 20)}`,
        display_name: name.trim(),
        organization_type: "other",
        lifecycle_stage: "customer",
        domains: [],
        account_ids: [],
        zendesk_ticket_ids: [],
        commercial_order_ids: [],
        site_license_ids: [],
        stripe_customer_ids: [],
        evidence: [],
        confidence: "medium",
      };
      byName.set(key, candidate);
    }
    return candidate;
  };
  for (const row of orders.rows) {
    const c = add(row.organization_name);
    c.commercial_order_ids.push(row.id);
    if (row.customer_account_id) c.account_ids.push(row.customer_account_id);
    c.zendesk_ticket_ids.push(...(row.zendesk_ticket_ids ?? []));
    if (row.stripe_customer_id)
      c.stripe_customer_ids.push(row.stripe_customer_id);
    c.evidence.push({
      source: "commercial_order",
      reference: row.id,
      detail: `Reviewed order for ${row.organization_name}`,
    });
  }
  for (const row of licenses.rows) {
    const c = add(row.organization_name);
    c.site_license_ids.push(row.id);
    if (row.owner_account_id) c.account_ids.push(row.owner_account_id);
    c.domains.push(...(row.allowed_domains ?? []));
    c.evidence.push({
      source: "site_license",
      reference: row.id,
      detail: `Site license for ${row.organization_name}`,
    });
    if (c.commercial_order_ids.length) c.confidence = "high";
  }
  const candidates = [...byName.values()].slice(0, limit);
  for (const candidate of candidates) {
    candidate.domains = [...new Set(candidate.domains.map(normalizeDomain))];
    candidate.account_ids = [...new Set(candidate.account_ids)];
    candidate.zendesk_ticket_ids = [...new Set(candidate.zendesk_ticket_ids)];
    candidate.commercial_order_ids = [
      ...new Set(candidate.commercial_order_ids),
    ];
    candidate.site_license_ids = [...new Set(candidate.site_license_ids)];
    candidate.stripe_customer_ids = [...new Set(candidate.stripe_customer_ids)];
    const existing = await getPool().query<{ id: string }>(
      `SELECT DISTINCT o.id
         FROM crm_organizations o
         LEFT JOIN crm_organization_domains d ON d.organization_id=o.id
        WHERE o.status='active' AND
          (lower(o.display_name)=lower($1)
           OR lower(COALESCE(o.legal_name,''))=lower($1)
           OR d.normalized_domain=ANY($2::text[]))
        ORDER BY o.id LIMIT 2`,
      [candidate.display_name, candidate.domains.map(normalizeDomain)],
    );
    if (existing.rows.length === 1) {
      candidate.existing_organization_id = existing.rows[0].id;
      candidate.confidence = "high";
    } else if (existing.rows.length > 1) {
      candidate.confidence = "low";
      candidate.evidence.push({
        source: "crm",
        reference: "ambiguous-existing-customer",
        detail: "Multiple existing customers match this candidate",
      });
    }
  }
  if (!opts.commit)
    return { preview: true, candidates, created: [], skipped: [] };
  const selected = new Set(opts.candidate_keys ?? []);
  if (!selected.size)
    throw Error("candidate_keys are required for committed backfill");
  if (opts.expected_version !== 0)
    throw Error("committed backfill requires expected_version 0");
  const idempotencyKey = `${opts.idempotency_key ?? ""}`.trim();
  if (!idempotencyKey)
    throw Error("idempotency_key is required for committed backfill");
  const actor = requireActor(opts.account_id);
  const hash = payloadHash({
    action: "backfill",
    candidate_keys: [...selected].sort(),
  });
  const replay = await getPool().query<{
    payload_hash: string;
    metadata: Json;
  }>(
    `SELECT payload_hash,metadata FROM crm_mutation_events
      WHERE actor_account_id=$1 AND action='backfill' AND idempotency_key=$2`,
    [actor, idempotencyKey],
  );
  if (replay.rows[0]) {
    if (replay.rows[0].payload_hash !== hash)
      throw Error(
        "idempotency key was already used with a different CRM backfill selection",
      );
    return {
      ...(replay.rows[0].metadata.result as CrmBackfillResponse),
      replayed: true,
    };
  }
  const created: CrmOrganization[] = [];
  const skipped: Array<{ candidate_key: string; reason: string }> = [];
  for (const candidate of candidates) {
    if (!selected.has(candidate.candidate_key)) continue;
    try {
      let organization: CrmOrganization;
      if (candidate.existing_organization_id) {
        organization = await loadOrganization(
          getPool(),
          candidate.existing_organization_id,
        );
      } else {
        const result = await createOrganization({
          account_id: actor,
          reason: opts.reason,
          source: opts.source,
          commit: true,
          expected_version: 0,
          idempotency_key: `${idempotencyKey}:${candidate.candidate_key}:organization`,
          display_name: candidate.display_name,
          organization_type: candidate.organization_type,
          lifecycle_stage: candidate.lifecycle_stage,
        });
        if (result.preview) throw Error("unexpected preview");
        organization = result.result;
        created.push(organization);
      }
      for (const domain of [...new Set(candidate.domains)]) {
        const preview = await mutateDomain({
          account_id: actor,
          organization: organization.id,
          domain,
          action: "add",
          kind: "secondary",
          reason: opts.reason,
        });
        if (!preview.preview) throw Error("unexpected domain commit");
        await mutateDomain({
          account_id: actor,
          organization: organization.id,
          domain,
          action: "add",
          kind: "secondary",
          reason: opts.reason,
          commit: true,
          expected_version: preview.expected_version,
          idempotency_key: `${idempotencyKey}:${candidate.candidate_key}:domain:${domain}`,
        });
      }
      const references: Array<{
        provider: "zendesk" | "stripe" | "cocalc";
        object_kind:
          | "ticket"
          | "customer"
          | "commercial_order"
          | "site_license";
        external_id: string;
      }> = [
        ...candidate.zendesk_ticket_ids.map((id) => ({
          provider: "zendesk" as const,
          object_kind: "ticket" as const,
          external_id: `${id}`,
        })),
        ...candidate.stripe_customer_ids.map((id) => ({
          provider: "stripe" as const,
          object_kind: "customer" as const,
          external_id: id,
        })),
        ...candidate.commercial_order_ids.map((id) => ({
          provider: "cocalc" as const,
          object_kind: "commercial_order" as const,
          external_id: id,
        })),
        ...candidate.site_license_ids.map((id) => ({
          provider: "cocalc" as const,
          object_kind: "site_license" as const,
          external_id: id,
        })),
      ];
      for (const reference of references) {
        const preview = await mutateExternalReference({
          account_id: actor,
          organization: organization.id,
          action: "verify",
          ...reference,
          reason: opts.reason,
        });
        if (!preview.preview) throw Error("unexpected reference commit");
        await mutateExternalReference({
          account_id: actor,
          organization: organization.id,
          action: "verify",
          ...reference,
          reason: opts.reason,
          commit: true,
          expected_version: preview.expected_version,
          idempotency_key: `${idempotencyKey}:${candidate.candidate_key}:${reference.provider}:${reference.object_kind}:${reference.external_id}`,
        });
      }
    } catch (err) {
      skipped.push({
        candidate_key: candidate.candidate_key,
        reason: `${err}`,
      });
    }
  }
  const auditId = randomUUID();
  const result: CrmBackfillResponse = {
    preview: false,
    replayed: false,
    audit_id: auditId,
    candidates,
    created,
    skipped,
  };
  await getPool().query(
    `INSERT INTO crm_mutation_events
       (id,actor_account_id,action,reason,idempotency_key,payload_hash,result_type,metadata)
     VALUES($1,$2,'backfill',$3,$4,$5,'backfill',$6)`,
    [auditId, actor, opts.reason, idempotencyKey, hash, { result }],
  );
  return result;
}

export async function exportData(
  opts: CrmExportRequest,
): Promise<CrmExportResponse> {
  await prepareRead(opts.reason);
  const limit = Math.min(opts.limit ?? 100, 500);
  let selectors: string[] = [];
  if (opts.organization)
    selectors = [await resolveOrganizationId(getPool(), opts.organization)];
  else {
    const listed = await listOrganizations({
      reason: opts.reason,
      limit,
      max_bytes: opts.max_bytes,
    });
    selectors = listed.organizations.map((x) => x.id);
  }
  const organizations: CrmCustomer360[] = [];
  let bytes = 0;
  let truncated = false;
  for (const id of selectors) {
    const value = await getOrganization({
      organization: id,
      reason: opts.reason,
      activity_limit: opts.include_activities ? 500 : 1,
    });
    if (!opts.include_people) {
      value.people = [];
      value.relationships = [];
    }
    if (!opts.include_activities) value.activities = [];
    const size = Buffer.byteLength(JSON.stringify(value), "utf8");
    if (bytes + size > byteLimit(opts.max_bytes)) {
      truncated = true;
      break;
    }
    organizations.push(value);
    bytes += size;
  }
  return {
    schema_version: CRM_SCHEMA_CONTRACT_VERSION,
    generated_at: new Date().toISOString(),
    sensitive: true,
    organizations,
    truncated,
    result_bytes: bytes,
  };
}

export const __test__ = {
  mutationPayloadHash,
  normalizeDomain,
  normalizeEmail,
  normalizeWebsite,
  OPPORTUNITY_TRANSITIONS,
  payloadHash,
  truncateRows,
};
