/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createHash } from "crypto";
import type {
  Attachment,
  CreateOrUpdateTicket,
  Ticket,
  TicketComment,
} from "node-zendesk/dist/types/clients/core/tickets";

import getLogger from "@cocalc/backend/logger";
import type {
  AdminSupportCategory,
  AdminSupportGetImageRequest,
  AdminSupportGetImageResponse,
  AdminSupportImageReference,
  AdminSupportListRequest,
  AdminSupportListResponse,
  AdminSupportMergePlanRequest,
  AdminSupportMergePlanResponse,
  AdminSupportMergeRequest,
  AdminSupportMergeResponse,
  AdminSupportMutationPreview,
  AdminSupportMutableTicketStatus,
  AdminSupportSearchRequest,
  AdminSupportSearchResponse,
  AdminSupportShowRequest,
  AdminSupportShowResponse,
  AdminSupportSpamPlanRequest,
  AdminSupportSpamPlanResponse,
  AdminSupportSpamRequest,
  AdminSupportSpamResponse,
  AdminSupportTicketPriority,
  AdminSupportTicketComment,
  AdminSupportTicketSignals,
  AdminSupportTicketStatus,
  AdminSupportTicketSummary,
  AdminSupportTriageGroup,
  AdminSupportTriageRequest,
  AdminSupportTriageResponse,
  AdminSupportUpdateChanges,
  AdminSupportUpdatePlanRequest,
  AdminSupportUpdatePlanResponse,
  AdminSupportUpdateRequest,
  AdminSupportUpdateResponse,
} from "@cocalc/conat/hub/api/admin-support";
import {
  ADMIN_SUPPORT_MUTABLE_TICKET_STATUSES,
  ADMIN_SUPPORT_TICKET_PRIORITIES,
  ADMIN_SUPPORT_TICKET_STATUSES,
} from "@cocalc/conat/hub/api/admin-support";
import getPool from "@cocalc/database/pool";
import siteURL from "@cocalc/database/settings/site-url";
import centralLog from "@cocalc/database/postgres/central-log";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { detectRasterImage } from "@cocalc/server/blobs/media";
import getZendeskClient from "@cocalc/server/support/zendesk-client";
import { isValidUUID, uuid } from "@cocalc/util/misc";

import { requireDangerousSessionAuth } from "./dangerous-session-auth";
import { getSupportContext as getCrmSupportContext } from "./crm";

const logger = getLogger("server:conat:api:admin-support");

const DEFAULT_SINCE_MINUTES = 24 * 60;
const MAX_SINCE_MINUTES = 7 * 24 * 60;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const DEFAULT_MAX_BYTES = 256 * 1024;
const MAX_MAX_BYTES = 1024 * 1024;
const MIN_MAX_BYTES = 16 * 1024;
const DEFAULT_MAX_COMMENTS = 50;
const MAX_MAX_COMMENTS = 100;
const MAX_REASON_LENGTH = 500;
const MAX_SUBJECT_CHARS = 500;
const MAX_PREVIEW_CHARS = 2_000;
const MAX_DESCRIPTION_CHARS = 50_000;
const MAX_COMMENT_CHARS = 20_000;
const MAX_MUTATION_COMMENT_CHARS = 100_000;
const MAX_SEARCH_QUERY_CHARS = 2_000;
const MAX_TAGS_PER_MUTATION = 100;
const MAX_TAG_CHARS = 100;
const MAX_IDEMPOTENCY_KEY_CHARS = 200;
const MAX_IMAGES_PER_COMMENT = 20;
const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const ZENDESK_TIMEOUT_MS = 20_000;
const ZENDESK_MERGE_TIMEOUT_MS = 60_000;
const MUTATION_TABLE = "admin_support_mutations";
const DEFAULT_STATUSES: AdminSupportTicketStatus[] = [
  "new",
  "open",
  "pending",
  "hold",
];

type AuthOpts = {
  account_id?: string;
  browser_id?: string;
  session_hash?: string;
};
type ZendeskSearchResult = { response: unknown; result: Ticket[] };
type ZendeskShowResult = { response: unknown; result: Ticket };
type ZendeskCommentsResult = { response: unknown; result: TicketComment[] };
type ZendeskUserResult = {
  response?: unknown;
  result?: { email?: string; external_id?: string | null };
};
type ZendeskUpdateResult = {
  response?: { ticket?: Ticket; audit?: { id?: number } };
  result?: Ticket;
};
type ZendeskMergeJob = {
  id?: string;
  status?: string;
  message?: string;
  results?: unknown;
};

type SupportMutationOperation = "update" | "merge" | "spam";

let activeZendeskReads = 0;
const MAX_ACTIVE_ZENDESK_READS = 2;

function positiveInt({
  value,
  fallback,
  max,
}: {
  value?: number;
  fallback: number;
  max: number;
}): number {
  const n = Math.floor(Number(value ?? fallback));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
}

function requiredReason(value: unknown): string {
  const reason = `${value ?? ""}`.trim();
  if (!reason) {
    throw new Error("a human-readable audit reason is required");
  }
  if (reason.length > MAX_REASON_LENGTH) {
    throw new Error(`audit reason must be at most ${MAX_REASON_LENGTH} chars`);
  }
  return reason;
}

function positiveTicketId(value: unknown, name = "ticket_id"): number {
  const ticketId = Math.floor(Number(value));
  if (!Number.isSafeInteger(ticketId) || ticketId <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return ticketId;
}

function normalizedExpectedUpdatedAt(
  value: unknown,
  { required = false }: { required?: boolean } = {},
): string | undefined {
  const text = `${value ?? ""}`.trim();
  if (!text) {
    if (required)
      throw new Error("expected_updated_at is required with --commit");
    return undefined;
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid expected_updated_at '${text}'`);
  }
  return date.toISOString();
}

function normalizedIdempotencyKey(value: unknown): string {
  const key = `${value ?? ""}`.trim();
  if (
    key.length < 8 ||
    key.length > MAX_IDEMPOTENCY_KEY_CHARS ||
    !/^[A-Za-z0-9._:-]+$/.test(key)
  ) {
    throw new Error(
      `idempotency_key must contain 8 to ${MAX_IDEMPOTENCY_KEY_CHARS} safe characters`,
    );
  }
  return key;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function payloadHash(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function normalizedComment(value: unknown): string | undefined {
  if (value == null) return undefined;
  const text = `${value}`.replace(/\r\n/g, "\n").trim();
  if (!text) return undefined;
  const literalNewlineEscapes = text.match(/(?:\\r\\n|\\n)/g)?.length ?? 0;
  if (!text.includes("\n") && literalNewlineEscapes >= 2) {
    throw new Error(
      "support comment contains multiple literal \\n escapes; send actual line breaks, preferably using a comment file",
    );
  }
  if (text.length > MAX_MUTATION_COMMENT_CHARS) {
    throw new Error(
      `support comment must be at most ${MAX_MUTATION_COMMENT_CHARS} chars`,
    );
  }
  return text;
}

function normalizedTags(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("support tags must be an array");
  if (value.length > MAX_TAGS_PER_MUTATION) {
    throw new Error(`at most ${MAX_TAGS_PER_MUTATION} tags may be changed`);
  }
  return [
    ...new Set(
      value.map((raw) => {
        const tag = `${raw}`.trim().toLowerCase();
        if (!tag || tag.length > MAX_TAG_CHARS || !/^[a-z0-9_:-]+$/.test(tag)) {
          throw new Error(`invalid Zendesk tag '${tag}'`);
        }
        return tag;
      }),
    ),
  ].sort();
}

function normalizeUpdateChanges(
  opts: AdminSupportUpdateChanges,
): AdminSupportUpdateChanges & {
  add_tags: string[];
  remove_tags: string[];
} {
  const publicReply = normalizedComment(opts.public_reply);
  const privateNote = normalizedComment(opts.private_note);
  if (publicReply && privateNote) {
    throw new Error("specify only one public reply or private note per update");
  }
  let status: AdminSupportMutableTicketStatus | undefined;
  if (opts.status != null) {
    const candidate = `${opts.status}`;
    if (!ADMIN_SUPPORT_MUTABLE_TICKET_STATUSES.includes(candidate as any)) {
      throw new Error(
        `invalid mutable support status '${candidate}'; expected ${ADMIN_SUPPORT_MUTABLE_TICKET_STATUSES.join(", ")}`,
      );
    }
    status = candidate as AdminSupportMutableTicketStatus;
  }
  let priority: AdminSupportTicketPriority | null | undefined;
  if (opts.priority === null) {
    priority = null;
  } else if (opts.priority != null) {
    const candidate = `${opts.priority}`;
    if (!ADMIN_SUPPORT_TICKET_PRIORITIES.includes(candidate as any)) {
      throw new Error(
        `invalid support priority '${candidate}'; expected ${ADMIN_SUPPORT_TICKET_PRIORITIES.join(", ")}`,
      );
    }
    priority = candidate as AdminSupportTicketPriority;
  }
  let assigneeId: number | null | undefined;
  if (opts.assignee_id === null) {
    assigneeId = null;
  } else if (opts.assignee_id != null) {
    assigneeId = positiveTicketId(opts.assignee_id, "assignee_id");
  }
  const addTags = normalizedTags(opts.add_tags);
  const removeTags = normalizedTags(opts.remove_tags);
  const overlap = addTags.find((tag) => removeTags.includes(tag));
  if (overlap) throw new Error(`tag '${overlap}' cannot be added and removed`);
  const changes = {
    ...(publicReply ? { public_reply: publicReply } : {}),
    ...(privateNote ? { private_note: privateNote } : {}),
    ...(status != null ? { status } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(assigneeId !== undefined ? { assignee_id: assigneeId } : {}),
    add_tags: addTags,
    remove_tags: removeTags,
  };
  if (
    !publicReply &&
    !privateNote &&
    status == null &&
    priority === undefined &&
    assigneeId === undefined &&
    addTags.length === 0 &&
    removeTags.length === 0
  ) {
    throw new Error("at least one support ticket change is required");
  }
  return changes;
}

function commentPreview(
  body: string,
  kind: "public_reply" | "private_note",
): AdminSupportMutationPreview {
  return {
    comment_kind: kind,
    comment_chars: body.length,
    comment_sha256: sha256(body),
    comment_preview: redactSupportText(body, 1_000),
    add_tags: [],
    remove_tags: [],
  };
}

async function requireAdmin({ account_id }: AuthOpts): Promise<string> {
  const accountId = `${account_id ?? ""}`.trim();
  if (!accountId) throw new Error("must be signed in");
  if (!(await isAdmin(accountId))) {
    throw Object.assign(new Error("admin privileges required"), { code: 403 });
  }
  return accountId;
}

async function requireFreshAdmin(opts: AuthOpts): Promise<string> {
  const accountId = await requireAdmin(opts);
  await requireDangerousSessionAuth({
    account_id: accountId,
    browser_id: opts.browser_id,
    session_hash: opts.session_hash,
    require_second_factor: "if_enabled",
  });
  return accountId;
}

let mutationSchemaReady: Promise<void> | undefined;

async function ensureMutationSchema(): Promise<void> {
  // Keep approved comment bodies in Zendesk only; this ledger stores hashes and
  // redacted final state so retries can be resolved without duplicating replies.
  mutationSchemaReady ??= getPool().query(`
    CREATE TABLE IF NOT EXISTS ${MUTATION_TABLE} (
      idempotency_key TEXT PRIMARY KEY,
      operation TEXT NOT NULL CHECK (operation IN ('update', 'merge', 'spam')),
      account_id UUID NOT NULL,
      payload_hash TEXT NOT NULL,
      audit_id UUID NOT NULL,
      ticket_id BIGINT NOT NULL,
      source_ticket_id BIGINT,
      status TEXT NOT NULL CHECK (
        status IN ('reserved', 'remote_started', 'succeeded', 'rejected', 'indeterminate')
      ),
      zendesk_audit_id BIGINT,
      zendesk_job_id TEXT,
      safe_response JSONB,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS admin_support_mutations_created_idx
      ON ${MUTATION_TABLE} (created_at DESC);
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = '${MUTATION_TABLE}'::regclass
          AND conname = 'admin_support_mutations_operation_check'
          AND pg_get_constraintdef(oid) LIKE '%spam%'
      ) THEN
        ALTER TABLE ${MUTATION_TABLE}
          DROP CONSTRAINT IF EXISTS admin_support_mutations_operation_check;
        ALTER TABLE ${MUTATION_TABLE}
          ADD CONSTRAINT admin_support_mutations_operation_check
          CHECK (operation IN ('update', 'merge', 'spam'));
      END IF;
    END $$;
  `) as unknown as Promise<void>;
  await mutationSchemaReady;
}

type MutationLedgerRow = {
  idempotency_key: string;
  operation: SupportMutationOperation;
  account_id: string;
  payload_hash: string;
  audit_id: string;
  status:
    | "reserved"
    | "remote_started"
    | "succeeded"
    | "rejected"
    | "indeterminate";
  safe_response?: unknown;
  error?: string | null;
  updated_at?: string | Date;
};

async function reserveMutation({
  idempotencyKey,
  operation,
  accountId,
  hash,
  auditId,
  ticketId,
  sourceTicketId,
}: {
  idempotencyKey: string;
  operation: SupportMutationOperation;
  accountId: string;
  hash: string;
  auditId: string;
  ticketId: number;
  sourceTicketId?: number;
}): Promise<{ row: MutationLedgerRow; created: boolean }> {
  await ensureMutationSchema();
  const pool = getPool();
  const inserted = await pool.query(
    `INSERT INTO ${MUTATION_TABLE}
       (idempotency_key, operation, account_id, payload_hash, audit_id,
        ticket_id, source_ticket_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'reserved')
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING *`,
    [
      idempotencyKey,
      operation,
      accountId,
      hash,
      auditId,
      ticketId,
      sourceTicketId ?? null,
    ],
  );
  if (inserted.rows[0]) {
    return { row: inserted.rows[0] as MutationLedgerRow, created: true };
  }
  const existing = await pool.query(
    `SELECT * FROM ${MUTATION_TABLE} WHERE idempotency_key=$1`,
    [idempotencyKey],
  );
  const row = existing.rows[0] as MutationLedgerRow | undefined;
  if (!row) throw new Error("unable to reserve support mutation");
  if (
    row.operation !== operation ||
    row.account_id !== accountId ||
    row.payload_hash !== hash
  ) {
    throw new Error(
      "idempotency_key was already used for a different support mutation",
    );
  }
  const updatedAt = new Date(row.updated_at ?? 0).getTime();
  const staleReservation =
    row.status === "reserved" &&
    Number.isFinite(updatedAt) &&
    updatedAt < Date.now() - 5 * 60_000;
  if (row.status === "rejected" || staleReservation) {
    const reclaimed = await pool.query(
      `UPDATE ${MUTATION_TABLE}
          SET audit_id=$2, status='reserved', error=NULL, updated_at=NOW()
        WHERE idempotency_key=$1
          AND (status='rejected' OR
               (status='reserved' AND updated_at < NOW() - INTERVAL '5 minutes'))
        RETURNING *`,
      [idempotencyKey, auditId],
    );
    if (reclaimed.rows[0]) {
      return { row: reclaimed.rows[0] as MutationLedgerRow, created: true };
    }
  }
  return { row, created: false };
}

async function setMutationStatus({
  idempotencyKey,
  status,
  zendeskAuditId,
  zendeskJobId,
  safeResponse,
  error,
}: {
  idempotencyKey: string;
  status: MutationLedgerRow["status"];
  zendeskAuditId?: number;
  zendeskJobId?: string;
  safeResponse?: unknown;
  error?: unknown;
}): Promise<void> {
  await getPool().query(
    `UPDATE ${MUTATION_TABLE}
        SET status=$2, zendesk_audit_id=COALESCE($3,zendesk_audit_id),
            zendesk_job_id=COALESCE($4,zendesk_job_id),
            safe_response=COALESCE($5,safe_response), error=$6,
            updated_at=NOW()
      WHERE idempotency_key=$1`,
    [
      idempotencyKey,
      status,
      zendeskAuditId ?? null,
      zendeskJobId ?? null,
      safeResponse == null ? null : JSON.stringify(safeResponse),
      error == null ? null : redactSupportText(error, 2_000),
    ],
  );
}

function replayOrRejectMutation<T>(row: MutationLedgerRow): T | undefined {
  if (row.status === "succeeded" && row.safe_response != null) {
    const response =
      typeof row.safe_response === "string"
        ? JSON.parse(row.safe_response)
        : row.safe_response;
    return { ...(response as object), idempotent_replay: true } as T;
  }
  if (row.status === "reserved") {
    throw new Error(
      "this support mutation is already reserved; wait and retry with the same idempotency key",
    );
  }
  if (row.status === "remote_started" || row.status === "indeterminate") {
    throw new Error(
      "this support mutation may have reached Zendesk; inspect the ticket before using a new idempotency key",
    );
  }
  throw new Error(
    `this support mutation was rejected previously: ${row.error ?? "unknown error"}`,
  );
}

function normalizeStatuses(
  values: AdminSupportTicketStatus[] | undefined,
): AdminSupportTicketStatus[] {
  if (values == null || values.length === 0) return [...DEFAULT_STATUSES];
  const allowed = new Set<string>(ADMIN_SUPPORT_TICKET_STATUSES);
  const statuses = [...new Set(values.map((value) => `${value}`.trim()))];
  for (const status of statuses) {
    if (!allowed.has(status)) {
      throw new Error(
        `invalid support status '${status}'; expected one of ${ADMIN_SUPPORT_TICKET_STATUSES.join(", ")}`,
      );
    }
  }
  return statuses as AdminSupportTicketStatus[];
}

function hashFingerprint(namespace: string, value: string): string {
  return `${namespace}_${createHash("sha256")
    .update(`${namespace}\0${value}`)
    .digest("hex")
    .slice(0, 16)}`;
}

function sanitizeUrl(raw: string): string {
  const trailing = raw.match(/[.,;:!?)]*$/)?.[0] ?? "";
  const value = trailing ? raw.slice(0, -trailing.length) : raw;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.hash = "";
    if (url.search) url.search = "?REDACTED";
    const projectMatch = url.pathname.match(
      /^(.*\/projects\/[0-9a-f-]{36})(?:\/.*)?$/i,
    );
    if (projectMatch) url.pathname = `${projectMatch[1]}/[REDACTED_PATH]`;
    return `${url.toString()}${trailing}`;
  } catch {
    return `[REDACTED_URL]${trailing}`;
  }
}

const SAFE_SUPPORT_IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
]);

const SUPPORT_IMAGE_MIME_EXTENSIONS = new Map([
  ["image/avif", ".avif"],
  ["image/bmp", ".bmp"],
  ["image/gif", ".gif"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["image/x-icon", ".ico"],
  ["image/vnd.microsoft.icon", ".ico"],
]);

function supportImageExtension(filename: string): string {
  const match = filename.toLowerCase().match(/(\.[a-z0-9]+)$/);
  return match?.[1] ?? "";
}

function stripTrailingUrlPunctuation(value: string): string {
  return value.replace(/[.,;:!?)\]}]+$/, "");
}

export function extractSupportImages(
  value: unknown,
  configuredSiteUrl: string,
): AdminSupportImageReference[] {
  let base: URL;
  try {
    base = new URL(configuredSiteUrl);
  } catch {
    return [];
  }
  base.username = "";
  base.password = "";
  base.hash = "";
  base.search = "";
  const basePath = base.pathname.replace(/\/+$/, "");
  const blobPrefix = `${basePath}/blobs/`.replace(/^\/\//, "/");
  const images = new Map<string, AdminSupportImageReference>();
  const text = `${value ?? ""}`;
  const candidates =
    text.match(/(?:https?:\/\/[^\s<>"']+|\/blobs\/[^\s<>"']+)/gi) ?? [];
  for (const raw of candidates) {
    if (images.size >= MAX_IMAGES_PER_COMMENT) break;
    const candidate = stripTrailingUrlPunctuation(raw);
    let url: URL;
    try {
      url = new URL(candidate, base);
    } catch {
      continue;
    }
    if (url.origin !== base.origin || !url.pathname.startsWith(blobPrefix)) {
      continue;
    }
    const encodedFilename = url.pathname.slice(blobPrefix.length);
    if (!encodedFilename || encodedFilename.includes("/")) continue;
    let filename: string;
    try {
      filename = decodeURIComponent(encodedFilename);
    } catch {
      continue;
    }
    if (
      !filename ||
      filename.length > 255 ||
      /[\u0000-\u001f\u007f/\\]/.test(filename) ||
      !SAFE_SUPPORT_IMAGE_EXTENSIONS.has(supportImageExtension(filename))
    ) {
      continue;
    }
    const uuid = url.searchParams.get("uuid") ?? "";
    if (!isValidUUID(uuid)) continue;
    const safeUrl = new URL(
      `${blobPrefix}${encodeURIComponent(filename)}`,
      base.origin,
    );
    safeUrl.searchParams.set("uuid", uuid);
    if (!images.has(uuid)) {
      images.set(uuid, {
        filename,
        source: "cocalc_blob",
        url: safeUrl.toString(),
      });
    }
  }
  return [...images.values()];
}

function normalizedImageContentType(value: unknown): string | undefined {
  const contentType = `${value ?? ""}`.split(";", 1)[0].trim().toLowerCase();
  return SUPPORT_IMAGE_MIME_EXTENSIONS.has(contentType)
    ? contentType
    : undefined;
}

function zendeskAttachmentImageReference(
  attachment: Attachment,
): AdminSupportImageReference | undefined {
  const attachmentId = Number(attachment?.id);
  const contentType = normalizedImageContentType(attachment?.content_type);
  if (
    !Number.isSafeInteger(attachmentId) ||
    attachmentId <= 0 ||
    !contentType ||
    attachment?.deleted === true ||
    attachment?.malware_scan_result === "malware_found"
  ) {
    return undefined;
  }
  const size = Math.max(0, Math.floor(Number(attachment?.size) || 0));
  return {
    filename: `zendesk-attachment-${attachmentId}${SUPPORT_IMAGE_MIME_EXTENSIONS.get(contentType)}`,
    source: "zendesk_attachment",
    attachment_id: attachmentId,
    content_type: contentType,
    size,
    inline: attachment?.inline === true,
  };
}

function zendeskAttachmentImages(
  attachments: Attachment[],
): AdminSupportImageReference[] {
  return attachments
    .map(zendeskAttachmentImageReference)
    .filter((image): image is AdminSupportImageReference => image != null)
    .slice(0, MAX_IMAGES_PER_COMMENT);
}

export function redactSupportText(value: unknown, maxChars: number): string {
  let text = `${value ?? ""}`;
  text = text.replace(/https?:\/\/[^\s<>"']+/gi, sanitizeUrl);
  text = text.replace(
    /\b(account[_ -]?id)\s*[:=]\s*["']?[0-9a-f-]{36}["']?/gi,
    "$1=[REDACTED_ACCOUNT_ID]",
  );
  text = text.replace(
    /\b(authorization|api[_ -]?key|access[_ -]?token|token|password|passwd|secret)\b\s*[:=]\s*[^\s,;]+/gi,
    "$1=[REDACTED_SECRET]",
  );
  text = text.replace(
    /\b[A-Z][A-Z0-9+/_-]*\.[A-Z0-9+/_-]+\.[A-Z0-9+/_-]+\b/gi,
    "[REDACTED_TOKEN]",
  );
  text = text.replace(
    /\b(?:sk|rk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/g,
    "[REDACTED_TOKEN]",
  );
  text = text.replace(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    "[REDACTED_EMAIL]",
  );
  text = text.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[REDACTED_IP]");
  text = text.replace(/\b(?:\d[ -]*?){13,19}\b/g, "[REDACTED_NUMBER]");
  if (text.length > maxChars) {
    return `${text.slice(0, Math.max(0, maxChars - 20))}\n[TRUNCATED]`;
  }
  return text;
}

function projectIdsFromText(value: unknown): string[] {
  const ids = new Set<string>();
  const text = `${value ?? ""}`;
  const pattern = /\/projects\/([0-9a-f-]{36})(?:\/|\b)/gi;
  for (const match of text.matchAll(pattern)) {
    const projectId = `${match[1] ?? ""}`.toLowerCase();
    if (isValidUUID(projectId)) ids.add(projectId);
  }
  return [...ids].slice(0, 20);
}

const CATEGORY_PATTERNS: Array<[AdminSupportCategory, RegExp]> = [
  [
    "availability",
    /\b(down|offline|outage|unavailable|not responding|502|503|504|disconnected)\b/i,
  ],
  ["performance", /\b(slow|latency|lag|hanging|unresponsive|timeout)\b/i],
  [
    "project_start",
    /\b(project (?:will not|won't|does not|doesn't|cannot|can't) start|start(?:ing)? project|stuck (?:starting|loading))\b/i,
  ],
  ["files", /\b(file listing|files? (?:missing|not showing)|file server)\b/i],
  ["terminal", /\b(terminal|shell command|console)\b/i],
  ["codex", /\b(codex|acp-worker|acp worker|ai assistant|agent turn)\b/i],
  ["jupyter", /\b(jupyter|notebook|kernel)\b/i],
  [
    "billing",
    /\b(billing|invoice|payment|purchase|subscription|membership|credit card|refund|charge)\b/i,
  ],
  [
    "account_access",
    /\b(login|log in|sign in|password|account access|two-factor|2fa|verification email)\b/i,
  ],
  [
    "abuse_security",
    /\b(abuse|security|hacked|compromised|phishing|spam|crypto ?mining|malware)\b/i,
  ],
  ["bug", /\b(bug|exception|traceback|stack trace|error|broken|regression)\b/i],
  [
    "how_to",
    /\b(how (?:do|can|to)|is it possible|where can|documentation|help me)\b/i,
  ],
];

const ERROR_SIGNATURES: Array<[string, RegExp]> = [
  ["ENOSPC", /\bENOSPC\b|no space left on device/i],
  ["SQLITE_FULL", /\bSQLITE_FULL\b/i],
  ["SQLITE_IOERR", /\bSQLITE_IOERR\b|disk I\/O error/i],
  ["ECONNRESET", /\bECONNRESET\b|connection reset/i],
  ["ETIMEDOUT", /\bETIMEDOUT\b|timed out/i],
  ["MODULE_NOT_FOUND", /\bMODULE_NOT_FOUND\b|cannot find module/i],
  ["FILE_SERVER_NOT_INITIALIZED", /file server not initialized/i],
  ["WEBSOCKET_ERROR", /websocket (?:connection )?(?:failed|error)/i],
  ["PERMISSION_DENIED", /permission denied/i],
  ["OUT_OF_MEMORY", /out of memory|oom[- ]kill/i],
  ["HTTP_5XX", /\b(?:500|502|503|504)\b/],
];

export function deriveSupportSignals(
  value: unknown,
): AdminSupportTicketSignals {
  const text = `${value ?? ""}`;
  const categories = CATEGORY_PATTERNS.filter(([, pattern]) =>
    pattern.test(text),
  ).map(([category]) => category);
  return {
    categories: categories.length > 0 ? categories : ["other"],
    error_signatures: ERROR_SIGNATURES.filter(([, pattern]) =>
      pattern.test(text),
    ).map(([signature]) => signature),
  };
}

function safeDate(value: unknown): string {
  const date = new Date(`${value ?? ""}`);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function agentUrl(ticket: Ticket): string {
  try {
    return `${new URL(ticket.url).origin}/agent/tickets/${ticket.id}`;
  } catch {
    return `ticket:${ticket.id}`;
  }
}

function summarizeTicket(ticket: Ticket): AdminSupportTicketSummary {
  const sourceText = `${ticket.subject ?? ""}\n${ticket.description ?? ""}`;
  const externalId = `${ticket.external_id ?? ""}`.trim();
  const status = ADMIN_SUPPORT_TICKET_STATUSES.includes(ticket.status as any)
    ? (ticket.status as AdminSupportTicketStatus)
    : "unknown";
  return {
    id: Number(ticket.id),
    agent_url: agentUrl(ticket),
    status,
    ...(ticket.type ? { type: `${ticket.type}` } : {}),
    ...(ticket.priority ? { priority: `${ticket.priority}` } : {}),
    assignee_id: ticket.assignee_id == null ? null : Number(ticket.assignee_id),
    tags: Array.isArray(ticket.tags)
      ? ticket.tags
          .map((tag) => redactSupportText(tag, MAX_TAG_CHARS))
          .sort()
          .slice(0, 500)
      : [],
    subject: redactSupportText(ticket.subject, MAX_SUBJECT_CHARS),
    description_preview: redactSupportText(
      ticket.description,
      MAX_PREVIEW_CHARS,
    ),
    created_at: safeDate(ticket.created_at),
    updated_at: safeDate(ticket.updated_at),
    ...(externalId
      ? { account_fingerprint: hashFingerprint("account", externalId) }
      : {}),
    project_ids: projectIdsFromText(sourceText),
    signals: deriveSupportSignals(sourceText),
  };
}

function normalizeTicketComment(
  comment: TicketComment,
  requesterId: number,
  configuredSiteUrl: string,
): AdminSupportTicketComment {
  const attachments = Array.isArray(comment.attachments)
    ? comment.attachments
    : [];
  const body = comment.plain_body || comment.body;
  const imageBody = comment.html_body ? `${body}\n${comment.html_body}` : body;
  const images = [
    ...extractSupportImages(imageBody, configuredSiteUrl),
    ...zendeskAttachmentImages(attachments),
  ].slice(0, MAX_IMAGES_PER_COMMENT);
  return {
    id: Number(comment.id),
    author:
      Number(comment.author_id) === requesterId
        ? "requester"
        : "staff_or_system",
    public: !!comment.public,
    created_at: safeDate(comment.created_at),
    body: redactSupportText(body, MAX_COMMENT_CHARS),
    images,
    attachment_count: attachments.length,
    attachment_bytes: attachments.reduce(
      (sum, attachment) => sum + (Number(attachment?.size) || 0),
      0,
    ),
  };
}

function findAppliedComment(
  comments: TicketComment[],
  body: string,
  isPublic: boolean,
): AdminSupportUpdateResponse["comment"] {
  const expectedHash = sha256(body);
  const match = [...comments]
    .sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    )
    .find((comment) => {
      const actualBody = `${comment.plain_body || comment.body || ""}`.trim();
      return (
        !!comment.public === isPublic && sha256(actualBody) === expectedHash
      );
    });
  if (!match) return undefined;
  return {
    id: Number(match.id),
    public: !!match.public,
    created_at: safeDate(match.created_at),
    body_sha256: expectedHash,
    body_preview: redactSupportText(
      match.plain_body || match.body,
      MAX_PREVIEW_CHARS,
    ),
  };
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function limitItemsByBytes<T>({
  items,
  maxBytes,
  envelopeBytes,
}: {
  items: T[];
  maxBytes: number;
  envelopeBytes: number;
}): { items: T[]; bytes: number; truncated: boolean } {
  const selected: T[] = [];
  let bytes = envelopeBytes;
  for (const item of items) {
    const itemBytes = serializedBytes(item) + 1;
    if (bytes + itemBytes > maxBytes) {
      return { items: selected, bytes, truncated: true };
    }
    selected.push(item);
    bytes += itemBytes;
  }
  return { items: selected, bytes, truncated: false };
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`${label} timed out after ${ZENDESK_TIMEOUT_MS}ms`),
            ),
          ZENDESK_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

async function withZendeskReadSlot<T>(
  fn: () => Promise<T>,
  timeoutLabel: string,
): Promise<T> {
  if (activeZendeskReads >= MAX_ACTIVE_ZENDESK_READS) {
    throw Object.assign(
      new Error("support diagnostics are busy; retry later"),
      {
        code: 503,
      },
    );
  }
  activeZendeskReads += 1;
  const operation = fn();
  const release = () => {
    activeZendeskReads -= 1;
  };
  void operation.then(release, release);
  return await withTimeout(operation, timeoutLabel);
}

async function searchRecentTickets(since: Date): Promise<Ticket[]> {
  const client = await getZendeskClient();
  const query = `type:ticket created>=${since.toISOString().slice(0, 10)}`;
  const response = (await client.search.get([
    "search",
    { query, sort_by: "updated_at", sort_order: "desc" },
  ])) as unknown as ZendeskSearchResult;
  return Array.isArray(response?.result) ? response.result : [];
}

function normalizedSearchQuery(value: unknown): string {
  const query = `${value ?? ""}`.trim();
  if (!query) throw new Error("Zendesk search query must be non-empty");
  if (query.length > MAX_SEARCH_QUERY_CHARS) {
    throw new Error(
      `Zendesk search query must be at most ${MAX_SEARCH_QUERY_CHARS} chars`,
    );
  }
  return /(?:^|\s)type:ticket(?:\s|$)/i.test(query)
    ? query
    : `type:ticket ${query}`;
}

async function searchTickets(query: string): Promise<Ticket[]> {
  const client = await getZendeskClient();
  const response = (await client.search.get([
    "search",
    { query, sort_by: "updated_at", sort_order: "desc" },
  ])) as unknown as ZendeskSearchResult;
  return Array.isArray(response?.result) ? response.result : [];
}

async function loadTicket(ticketId: number): Promise<{
  ticket: Ticket;
  comments: TicketComment[];
}> {
  const client = await getZendeskClient();
  const [ticketResponse, commentResponse] = await Promise.all([
    client.tickets.show(ticketId) as Promise<ZendeskShowResult>,
    client.tickets.get([
      "tickets",
      ticketId,
      "comments",
      { sort_order: "desc", include_inline_images: true },
    ]) as unknown as Promise<ZendeskCommentsResult>,
  ]);
  if (!ticketResponse?.result) throw new Error(`ticket ${ticketId} not found`);
  return {
    ticket: ticketResponse.result,
    comments: Array.isArray(commentResponse?.result)
      ? commentResponse.result
      : [],
  };
}

async function loadRequesterIdentity(requesterId: number): Promise<{
  email?: string;
  account_id?: string;
}> {
  try {
    const client = await getZendeskClient();
    const response = (await client.users.show(
      requesterId,
    )) as unknown as ZendeskUserResult;
    const externalId = `${response.result?.external_id ?? ""}`.trim();
    return {
      email: `${response.result?.email ?? ""}`.trim() || undefined,
      account_id: isValidUUID(externalId) ? externalId : undefined,
    };
  } catch (err) {
    logger.debug("unable to load Zendesk requester identity for CRM context", {
      requesterId,
      err,
    });
    return {};
  }
}

async function recordAudit({
  auditId,
  accountId,
  mode,
  reason,
  ticketId,
  sinceMinutes,
  statuses,
  resultCount,
  resultBytes,
  truncated,
  durationMs,
  error,
  queryHash,
  payloadHash: approvedPayloadHash,
  idempotencyKey,
  priorUpdatedAt,
  zendeskAuditId,
  zendeskJobId,
  resultStatus,
  sourceTicketId,
}: {
  auditId: string;
  accountId: string;
  mode:
    | "list"
    | "show"
    | "get_image"
    | "triage"
    | "search"
    | "plan_update"
    | "update"
    | "plan_merge"
    | "merge"
    | "plan_spam"
    | "spam";
  reason: string;
  ticketId?: number;
  sinceMinutes?: number;
  statuses?: AdminSupportTicketStatus[];
  resultCount?: number;
  resultBytes?: number;
  truncated?: boolean;
  durationMs: number;
  error?: unknown;
  queryHash?: string;
  payloadHash?: string;
  idempotencyKey?: string;
  priorUpdatedAt?: string | string[];
  zendeskAuditId?: number;
  zendeskJobId?: string;
  resultStatus?: string;
  sourceTicketId?: number;
}): Promise<void> {
  try {
    await centralLog({
      event: "admin_support_operator",
      value: {
        audit_id: auditId,
        account_id: accountId,
        mode,
        reason,
        ticket_id: ticketId ?? null,
        source_ticket_id: sourceTicketId ?? null,
        since_minutes: sinceMinutes ?? null,
        statuses: statuses ?? null,
        result_count: resultCount ?? null,
        result_bytes: resultBytes ?? null,
        truncated: truncated ?? null,
        duration_ms: durationMs,
        query_hash: queryHash ?? null,
        payload_hash: approvedPayloadHash ?? null,
        idempotency_key: idempotencyKey ?? null,
        prior_updated_at: priorUpdatedAt ?? null,
        zendesk_audit_id: zendeskAuditId ?? null,
        zendesk_job_id: zendeskJobId ?? null,
        result_status: resultStatus ?? null,
        error: error == null ? null : redactSupportText(error, 2_000),
      },
    });
  } catch (err) {
    logger.warn("failed to write admin support audit event", {
      audit_id: auditId,
      err,
    });
  }
}

async function listTicketsInternal({
  sinceMinutes,
  limit,
  statuses,
  maxBytes,
}: {
  sinceMinutes: number;
  limit: number;
  statuses: AdminSupportTicketStatus[];
  maxBytes: number;
}): Promise<Omit<AdminSupportListResponse, "audit_id">> {
  const since = new Date(Date.now() - sinceMinutes * 60_000);
  const source = await withZendeskReadSlot(
    () => searchRecentTickets(since),
    "Zendesk ticket search",
  );
  const statusSet = new Set(statuses);
  const filtered = source
    .filter((ticket) => {
      const createdAt = new Date(ticket.created_at).getTime();
      return (
        Number.isFinite(createdAt) &&
        createdAt >= since.getTime() &&
        statusSet.has(ticket.status as AdminSupportTicketStatus)
      );
    })
    .sort(
      (a, b) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    )
    .slice(0, limit)
    .map(summarizeTicket);
  const envelope = {
    server_time: new Date().toISOString(),
    since: since.toISOString(),
    statuses,
    source_candidates: source.length,
    redaction: "best_effort" as const,
  };
  const bounded = limitItemsByBytes({
    items: filtered,
    maxBytes,
    envelopeBytes: serializedBytes(envelope),
  });
  return {
    ...envelope,
    tickets: bounded.items,
    result_bytes: bounded.bytes,
    truncated:
      bounded.truncated || filtered.length >= limit || source.length >= 100,
  };
}

export async function list(
  opts: AdminSupportListRequest & AuthOpts,
): Promise<AdminSupportListResponse> {
  const started = Date.now();
  const auditId = uuid();
  const accountId = await requireAdmin(opts);
  const reason = requiredReason(opts.reason);
  const sinceMinutes = positiveInt({
    value: opts.since_minutes,
    fallback: DEFAULT_SINCE_MINUTES,
    max: MAX_SINCE_MINUTES,
  });
  const limit = positiveInt({
    value: opts.limit,
    fallback: DEFAULT_LIMIT,
    max: MAX_LIMIT,
  });
  const maxBytes = Math.max(
    MIN_MAX_BYTES,
    positiveInt({
      value: opts.max_bytes,
      fallback: DEFAULT_MAX_BYTES,
      max: MAX_MAX_BYTES,
    }),
  );
  const statuses = normalizeStatuses(opts.statuses);
  try {
    const result = await listTicketsInternal({
      sinceMinutes,
      limit,
      statuses,
      maxBytes,
    });
    await recordAudit({
      auditId,
      accountId,
      mode: "list",
      reason,
      sinceMinutes,
      statuses,
      resultCount: result.tickets.length,
      resultBytes: result.result_bytes,
      truncated: result.truncated,
      durationMs: Date.now() - started,
    });
    return { audit_id: auditId, ...result };
  } catch (error) {
    await recordAudit({
      auditId,
      accountId,
      mode: "list",
      reason,
      sinceMinutes,
      statuses,
      durationMs: Date.now() - started,
      error,
    });
    throw error;
  }
}

export async function search(
  opts: AdminSupportSearchRequest & AuthOpts,
): Promise<AdminSupportSearchResponse> {
  const started = Date.now();
  const auditId = uuid();
  const accountId = await requireAdmin(opts);
  const reason = requiredReason(opts.reason);
  const query = normalizedSearchQuery(opts.query);
  const limit = positiveInt({
    value: opts.limit,
    fallback: DEFAULT_LIMIT,
    max: MAX_LIMIT,
  });
  const maxBytes = Math.max(
    MIN_MAX_BYTES,
    positiveInt({
      value: opts.max_bytes,
      fallback: DEFAULT_MAX_BYTES,
      max: MAX_MAX_BYTES,
    }),
  );
  const queryHash = sha256(query);
  try {
    const source = await withZendeskReadSlot(
      () => searchTickets(query),
      "Zendesk ticket search",
    );
    const tickets = source.slice(0, limit).map(summarizeTicket);
    const envelope = {
      server_time: new Date().toISOString(),
      query,
      source_candidates: source.length,
      redaction: "best_effort" as const,
      indexing_note:
        "Zendesk search indexing can lag ticket changes by several minutes and returns at most 1,000 matches.",
    };
    const bounded = limitItemsByBytes({
      items: tickets,
      maxBytes,
      envelopeBytes: serializedBytes(envelope),
    });
    const result: AdminSupportSearchResponse = {
      audit_id: auditId,
      ...envelope,
      tickets: bounded.items,
      result_bytes: bounded.bytes,
      truncated:
        bounded.truncated || tickets.length >= limit || source.length >= 100,
    };
    await recordAudit({
      auditId,
      accountId,
      mode: "search",
      reason,
      queryHash,
      resultCount: result.tickets.length,
      resultBytes: result.result_bytes,
      truncated: result.truncated,
      durationMs: Date.now() - started,
    });
    return result;
  } catch (error) {
    await recordAudit({
      auditId,
      accountId,
      mode: "search",
      reason,
      queryHash,
      durationMs: Date.now() - started,
      error,
    });
    throw error;
  }
}

export async function show(
  opts: AdminSupportShowRequest & AuthOpts,
): Promise<AdminSupportShowResponse> {
  const started = Date.now();
  const auditId = uuid();
  const accountId = await requireAdmin(opts);
  const reason = requiredReason(opts.reason);
  const ticketId = Math.floor(Number(opts.ticket_id));
  if (!Number.isSafeInteger(ticketId) || ticketId <= 0) {
    throw new Error("ticket_id must be a positive integer");
  }
  const maxComments = positiveInt({
    value: opts.max_comments,
    fallback: DEFAULT_MAX_COMMENTS,
    max: MAX_MAX_COMMENTS,
  });
  const maxBytes = Math.max(
    MIN_MAX_BYTES,
    positiveInt({
      value: opts.max_bytes,
      fallback: DEFAULT_MAX_BYTES,
      max: MAX_MAX_BYTES,
    }),
  );
  try {
    const [{ ticket, comments: rawComments }, configuredSiteUrl] =
      await Promise.all([
        withZendeskReadSlot(
          () => loadTicket(ticketId),
          "Zendesk ticket and comments read",
        ),
        siteURL(),
      ]);
    const summary = summarizeTicket(ticket);
    const requester = await withZendeskReadSlot(
      () => loadRequesterIdentity(Number(ticket.requester_id)),
      "Zendesk requester identity read",
    );
    let crmContext: AdminSupportShowResponse["crm_context"];
    try {
      crmContext = await getCrmSupportContext({
        account_id: opts.account_id,
        browser_id: opts.browser_id,
        session_hash: opts.session_hash,
        ticket_id: ticketId,
        requester_email: requester.email,
        requester_account_id:
          requester.account_id ??
          (isValidUUID(`${ticket.external_id ?? ""}`)
            ? `${ticket.external_id}`
            : undefined),
        reason: `${reason}; correlate support ticket with reviewed CRM evidence`,
        limit: 10,
      });
    } catch (err) {
      logger.debug("CRM customer context is unavailable for support ticket", {
        ticketId,
        err,
      });
    }
    const ticketDetail = {
      ...summary,
      description: redactSupportText(
        ticket.description,
        Math.min(MAX_DESCRIPTION_CHARS, Math.floor(maxBytes / 2)),
      ),
      images: extractSupportImages(ticket.description, configuredSiteUrl),
    };
    const comments = rawComments
      .sort(
        (a, b) =>
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      )
      .slice(-maxComments)
      .map((comment) =>
        normalizeTicketComment(comment, ticket.requester_id, configuredSiteUrl),
      );
    const envelope = {
      server_time: new Date().toISOString(),
      ticket: ticketDetail,
      ...(crmContext ? { crm_context: crmContext } : {}),
      redaction: "best_effort" as const,
    };
    const bounded = limitItemsByBytes({
      items: comments,
      maxBytes,
      envelopeBytes: serializedBytes(envelope),
    });
    const result: AdminSupportShowResponse = {
      audit_id: auditId,
      ...envelope,
      comments: bounded.items,
      result_bytes: bounded.bytes,
      truncated:
        bounded.truncated ||
        rawComments.length > maxComments ||
        rawComments.length >= 100,
    };
    await recordAudit({
      auditId,
      accountId,
      mode: "show",
      reason,
      ticketId,
      resultCount: result.comments.length,
      resultBytes: result.result_bytes,
      truncated: result.truncated,
      durationMs: Date.now() - started,
    });
    return result;
  } catch (error) {
    await recordAudit({
      auditId,
      accountId,
      mode: "show",
      reason,
      ticketId,
      durationMs: Date.now() - started,
      error,
    });
    throw error;
  }
}

function allowedZendeskAttachmentHost(
  hostname: string,
  subdomain: string,
): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === `${subdomain.toLowerCase()}.zendesk.com` ||
    normalized.endsWith(".zdusercontent.com")
  );
}

async function fetchZendeskAttachmentImage({
  client,
  attachment,
  maxBytes,
}: {
  client: Awaited<ReturnType<typeof getZendeskClient>>;
  attachment: Attachment;
  maxBytes: number;
}): Promise<{ data: Buffer; contentType: string }> {
  const configuredType = normalizedImageContentType(attachment.content_type);
  if (!configuredType) {
    throw new Error("Zendesk attachment is not a supported image type");
  }
  if (attachment.deleted === true) {
    throw new Error("Zendesk attachment was deleted");
  }
  if (attachment.malware_scan_result === "malware_found") {
    throw new Error("Zendesk rejected the attachment as malware");
  }
  const declaredSize = Math.max(0, Math.floor(Number(attachment.size) || 0));
  if (declaredSize > maxBytes) {
    throw new Error(
      `Zendesk image is ${declaredSize} bytes; maximum is ${maxBytes}`,
    );
  }
  const rawUrl =
    `${attachment.mapped_content_url || attachment.content_url || ""}`.trim();
  if (!rawUrl) throw new Error("Zendesk attachment has no content URL");

  const subdomain = `${client.config.subdomain ?? ""}`.trim();
  const username = `${client.config.username ?? ""}`;
  const token = `${client.config.token ?? ""}`;
  if (!subdomain || !username || !token) {
    throw new Error("Zendesk attachment authentication is not configured");
  }
  let current = new URL(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ZENDESK_TIMEOUT_MS);
  timer.unref?.();
  try {
    for (let redirects = 0; redirects <= 4; redirects += 1) {
      if (
        current.protocol !== "https:" ||
        !allowedZendeskAttachmentHost(current.hostname, subdomain)
      ) {
        throw new Error("Zendesk attachment URL uses an untrusted host");
      }
      // Zendesk attachment endpoints negotiate redirects, not image variants.
      // A specific image Accept header can cause HTTP 406 before the redirect.
      const headers: Record<string, string> = { Accept: "*/*" };
      if (current.hostname === `${subdomain.toLowerCase()}.zendesk.com`) {
        headers.Authorization = `Basic ${Buffer.from(`${username}/token:${token}`).toString("base64")}`;
      }
      const response = await fetch(current, {
        headers,
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || redirects === 4) {
          throw new Error("Zendesk attachment redirect was invalid");
        }
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) {
        throw new Error(
          `Zendesk attachment download failed with HTTP ${response.status}`,
        );
      }
      const responseLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(responseLength) && responseLength > maxBytes) {
        throw new Error(
          `Zendesk image is ${responseLength} bytes; maximum is ${maxBytes}`,
        );
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Zendesk attachment response had no body");
      const chunks: Buffer[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        size += chunk.length;
        if (size > maxBytes) {
          await reader.cancel();
          throw new Error(`Zendesk image exceeds the ${maxBytes}-byte maximum`);
        }
        chunks.push(chunk);
      }
      if (size === 0) throw new Error("Zendesk attachment image was empty");
      const data = Buffer.concat(chunks, size);
      const image = detectRasterImage(data);
      if (!image) {
        throw new Error(
          "Zendesk attachment did not contain a supported raster image",
        );
      }
      return { data, contentType: image.contentType };
    }
  } finally {
    clearTimeout(timer);
  }
  throw new Error("Zendesk attachment download did not complete");
}

export async function getImage(
  opts: AdminSupportGetImageRequest & AuthOpts,
): Promise<AdminSupportGetImageResponse> {
  const started = Date.now();
  const auditId = uuid();
  const accountId = await requireAdmin(opts);
  const reason = requiredReason(opts.reason);
  const ticketId = positiveTicketId(opts.ticket_id);
  const attachmentId = positiveTicketId(opts.attachment_id, "attachment_id");
  const maxBytes = positiveInt({
    value: opts.max_bytes,
    fallback: DEFAULT_MAX_IMAGE_BYTES,
    max: MAX_MAX_IMAGE_BYTES,
  });
  try {
    const client = await getZendeskClient();
    const { comments } = await withZendeskReadSlot(
      () => loadTicket(ticketId),
      "Zendesk image attachment lookup",
    );
    let commentId: number | undefined;
    let attachment: Attachment | undefined;
    for (const comment of comments) {
      const match = (comment.attachments ?? []).find(
        (candidate) => Number(candidate.id) === attachmentId,
      );
      if (match) {
        commentId = Number(comment.id);
        attachment = match;
        break;
      }
    }
    if (!attachment || !commentId) {
      throw new Error(
        `image attachment ${attachmentId} is not part of ticket ${ticketId}`,
      );
    }
    if (!zendeskAttachmentImageReference(attachment)) {
      throw new Error("Zendesk attachment is not a safe supported image");
    }
    const detail = (await withTimeout(
      client.attachments.show(attachmentId),
      "Zendesk attachment metadata read",
    )) as any;
    const detailedAttachment = (detail?.result?.attachment ??
      detail?.result ??
      detail?.response?.attachment ??
      attachment) as Attachment;
    if (
      Number(detailedAttachment?.id) !== attachmentId ||
      !zendeskAttachmentImageReference(detailedAttachment)
    ) {
      throw new Error("Zendesk attachment metadata did not match the image");
    }
    const { data, contentType } = await fetchZendeskAttachmentImage({
      client,
      attachment: detailedAttachment,
      maxBytes,
    });
    const filename = `ticket-${ticketId}-attachment-${attachmentId}${SUPPORT_IMAGE_MIME_EXTENSIONS.get(contentType)}`;
    const result: AdminSupportGetImageResponse = {
      audit_id: auditId,
      ticket_id: ticketId,
      comment_id: commentId,
      attachment_id: attachmentId,
      filename,
      content_type: contentType,
      size: data.length,
      sha256: sha256(data),
      data_base64: data.toString("base64"),
    };
    await recordAudit({
      auditId,
      accountId,
      mode: "get_image",
      reason,
      ticketId,
      resultCount: 1,
      resultBytes: data.length,
      durationMs: Date.now() - started,
    });
    return result;
  } catch (error) {
    await recordAudit({
      auditId,
      accountId,
      mode: "get_image",
      reason,
      ticketId,
      durationMs: Date.now() - started,
      error,
    });
    throw error;
  }
}

const SUBJECT_STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "cannot",
  "cocalc",
  "could",
  "does",
  "from",
  "have",
  "help",
  "please",
  "project",
  "support",
  "that",
  "this",
  "with",
  "would",
]);

function subjectSimilarityKey(subject: string): string | undefined {
  const tokens = subject
    .toLowerCase()
    .replace(/\[[^\]]+]/g, " ")
    .match(/[a-z0-9_]{3,}/g);
  if (!tokens) return undefined;
  const normalized = [
    ...new Set(tokens.filter((x) => !SUBJECT_STOP_WORDS.has(x))),
  ]
    .sort()
    .slice(0, 8);
  return normalized.length >= 2 ? normalized.join("-") : undefined;
}

function groupTicket(ticket: AdminSupportTicketSummary): {
  key: string;
  reason: AdminSupportTriageGroup["reason"];
  category: AdminSupportCategory;
} {
  const category = ticket.signals.categories[0] ?? "other";
  const error = ticket.signals.error_signatures[0];
  if (error) {
    return { key: `error:${error}`, reason: "error_signature", category };
  }
  const subjectKey = subjectSimilarityKey(ticket.subject);
  if (subjectKey) {
    return {
      key: `subject:${subjectKey}`,
      reason: "subject_similarity",
      category,
    };
  }
  return { key: `category:${category}`, reason: "category", category };
}

export function buildTriageGroups(
  tickets: AdminSupportTicketSummary[],
): AdminSupportTriageGroup[] {
  const groups = new Map<string, AdminSupportTriageGroup>();
  for (const ticket of tickets) {
    const grouping = groupTicket(ticket);
    const group = groups.get(grouping.key) ?? {
      ...grouping,
      ticket_ids: [],
      count: 0,
      first_created_at: ticket.created_at,
      last_updated_at: ticket.updated_at,
      project_ids: [],
      error_signatures: [],
      subjects: [],
    };
    group.ticket_ids.push(ticket.id);
    group.count += 1;
    group.first_created_at = [group.first_created_at, ticket.created_at]
      .filter(Boolean)
      .sort()[0];
    group.last_updated_at = [group.last_updated_at, ticket.updated_at]
      .filter(Boolean)
      .sort()
      .at(-1)!;
    group.project_ids = [
      ...new Set([...group.project_ids, ...ticket.project_ids]),
    ].slice(0, 20);
    group.error_signatures = [
      ...new Set([
        ...group.error_signatures,
        ...ticket.signals.error_signatures,
      ]),
    ];
    group.subjects = [...new Set([...group.subjects, ticket.subject])].slice(
      0,
      10,
    );
    groups.set(grouping.key, group);
  }
  return [...groups.values()].sort(
    (a, b) =>
      b.count - a.count || b.last_updated_at.localeCompare(a.last_updated_at),
  );
}

export async function triage(
  opts: AdminSupportTriageRequest & AuthOpts,
): Promise<AdminSupportTriageResponse> {
  const started = Date.now();
  const auditId = uuid();
  const accountId = await requireAdmin(opts);
  const reason = requiredReason(opts.reason);
  const sinceMinutes = positiveInt({
    value: opts.since_minutes,
    fallback: DEFAULT_SINCE_MINUTES,
    max: MAX_SINCE_MINUTES,
  });
  const limit = positiveInt({
    value: opts.limit,
    fallback: DEFAULT_LIMIT,
    max: MAX_LIMIT,
  });
  const maxBytes = Math.max(
    MIN_MAX_BYTES,
    positiveInt({
      value: opts.max_bytes,
      fallback: DEFAULT_MAX_BYTES,
      max: MAX_MAX_BYTES,
    }),
  );
  const statuses = normalizeStatuses(opts.statuses);
  try {
    const listed = await listTicketsInternal({
      sinceMinutes,
      limit,
      statuses,
      maxBytes,
    });
    const tickets = [...listed.tickets];
    let result: AdminSupportTriageResponse;
    while (true) {
      const categoryCounts: Partial<Record<AdminSupportCategory, number>> = {};
      for (const ticket of tickets) {
        for (const category of ticket.signals.categories) {
          categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
        }
      }
      result = {
        audit_id: auditId,
        ...listed,
        tickets,
        category_counts: categoryCounts,
        groups: buildTriageGroups(tickets),
        truncated: listed.truncated || tickets.length < listed.tickets.length,
      };
      result.result_bytes = serializedBytes(result);
      if (result.result_bytes <= maxBytes || tickets.length === 0) break;
      tickets.pop();
    }
    await recordAudit({
      auditId,
      accountId,
      mode: "triage",
      reason,
      sinceMinutes,
      statuses,
      resultCount: result.tickets.length,
      resultBytes: result.result_bytes,
      truncated: result.truncated,
      durationMs: Date.now() - started,
    });
    return result;
  } catch (error) {
    await recordAudit({
      auditId,
      accountId,
      mode: "triage",
      reason,
      sinceMinutes,
      statuses,
      durationMs: Date.now() - started,
      error,
    });
    throw error;
  }
}

async function loadTicketOnly(ticketId: number): Promise<Ticket> {
  const client = await getZendeskClient();
  const response = (await client.tickets.show(
    ticketId,
  )) as unknown as ZendeskShowResult;
  if (!response?.result) throw new Error(`ticket ${ticketId} not found`);
  return response.result;
}

function requireTicketVersion(
  ticket: Ticket,
  expected: string | undefined,
  label = `ticket ${ticket.id}`,
): void {
  if (!expected) return;
  const actual = safeDate(ticket.updated_at);
  if (actual !== expected) {
    throw Object.assign(
      new Error(
        `${label} changed after review: expected ${expected}, current ${actual}`,
      ),
      { code: 409, expected_updated_at: expected, updated_at: actual },
    );
  }
}

function updatePreview(
  changes: ReturnType<typeof normalizeUpdateChanges>,
): AdminSupportMutationPreview {
  const body = changes.public_reply ?? changes.private_note;
  return {
    ...(body
      ? commentPreview(
          body,
          changes.public_reply ? "public_reply" : "private_note",
        )
      : { add_tags: [], remove_tags: [] }),
    ...(changes.status != null ? { status: changes.status } : {}),
    ...(changes.priority !== undefined ? { priority: changes.priority } : {}),
    ...(changes.assignee_id !== undefined
      ? { assignee_id: changes.assignee_id }
      : {}),
    add_tags: changes.add_tags,
    remove_tags: changes.remove_tags,
  };
}

function finalTags(
  ticket: Ticket,
  changes: AdminSupportUpdateChanges,
): string[] {
  const tags = new Set(
    (Array.isArray(ticket.tags) ? ticket.tags : []).map((tag) => `${tag}`),
  );
  for (const tag of changes.remove_tags ?? []) tags.delete(tag);
  for (const tag of changes.add_tags ?? []) tags.add(tag);
  return [...tags].sort();
}

function updatePayloadHash({
  ticketId,
  expectedUpdatedAt,
  changes,
}: {
  ticketId: number;
  expectedUpdatedAt: string;
  changes: ReturnType<typeof normalizeUpdateChanges>;
}): string {
  return payloadHash({
    operation: "update",
    ticket_id: ticketId,
    expected_updated_at: expectedUpdatedAt,
    changes,
  });
}

async function buildUpdatePlan(opts: AdminSupportUpdatePlanRequest): Promise<{
  ticket: Ticket;
  ticketId: number;
  expectedUpdatedAt: string;
  changes: ReturnType<typeof normalizeUpdateChanges>;
  preview: AdminSupportMutationPreview;
  hash: string;
}> {
  const ticketId = positiveTicketId(opts.ticket_id);
  const expected = normalizedExpectedUpdatedAt(opts.expected_updated_at);
  const changes = normalizeUpdateChanges(opts);
  const ticket = await withZendeskReadSlot(
    () => loadTicketOnly(ticketId),
    "Zendesk ticket preflight",
  );
  const expectedUpdatedAt = expected ?? safeDate(ticket.updated_at);
  requireTicketVersion(ticket, expected);
  const preview = updatePreview(changes);
  const hash = updatePayloadHash({ ticketId, expectedUpdatedAt, changes });
  return { ticket, ticketId, expectedUpdatedAt, changes, preview, hash };
}

export async function planUpdate(
  opts: AdminSupportUpdatePlanRequest & AuthOpts,
): Promise<AdminSupportUpdatePlanResponse> {
  const started = Date.now();
  const auditId = uuid();
  const accountId = await requireAdmin(opts);
  const reason = requiredReason(opts.reason);
  try {
    const plan = await buildUpdatePlan(opts);
    const result: AdminSupportUpdatePlanResponse = {
      audit_id: auditId,
      operation: "update",
      commit: false,
      payload_hash: plan.hash,
      expected_updated_at: plan.expectedUpdatedAt,
      ticket_before: summarizeTicket(plan.ticket),
      changes: plan.preview,
    };
    await recordAudit({
      auditId,
      accountId,
      mode: "plan_update",
      reason,
      ticketId: plan.ticketId,
      payloadHash: plan.hash,
      priorUpdatedAt: plan.expectedUpdatedAt,
      resultStatus: "dry_run",
      durationMs: Date.now() - started,
    });
    return result;
  } catch (error) {
    await recordAudit({
      auditId,
      accountId,
      mode: "plan_update",
      reason,
      ticketId: Number(opts.ticket_id) || undefined,
      durationMs: Date.now() - started,
      error,
    });
    throw error;
  }
}

function zendeskDefinitelyRejected(error: unknown): boolean {
  const candidate = error as any;
  const code = Number(
    candidate?.statusCode ??
      candidate?.status ??
      candidate?.response?.statusCode ??
      candidate?.response?.status,
  );
  return [400, 401, 403, 404, 409, 422, 429].includes(code);
}

function zendeskAuditId(response: ZendeskUpdateResult): number | undefined {
  const value =
    (response as any)?.response?.audit?.id ??
    (response as any)?.result?.audit?.id ??
    (response as any)?.audit?.id;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

async function findZendeskAuditId({
  client,
  ticketId,
  idempotencyKey,
}: {
  client: Awaited<ReturnType<typeof getZendeskClient>>;
  ticketId: number;
  idempotencyKey: string;
}): Promise<number | undefined> {
  if (typeof client.ticketaudits?.list !== "function") return undefined;
  const response = (await withTimeout(
    client.ticketaudits.list(ticketId),
    "Zendesk ticket audit verification",
  )) as any;
  const audits = Array.isArray(response)
    ? response
    : Array.isArray(response?.result)
      ? response.result
      : [];
  const audit = [...audits].reverse().find((candidate) => {
    return (
      candidate?.metadata?.custom?.cocalc_idempotency_key === idempotencyKey
    );
  });
  const id = Number(audit?.id);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

export async function update(
  opts: AdminSupportUpdateRequest & AuthOpts,
): Promise<AdminSupportUpdateResponse> {
  const started = Date.now();
  const auditId = uuid();
  const accountId = await requireFreshAdmin(opts);
  const reason = requiredReason(opts.reason);
  const expectedUpdatedAt = normalizedExpectedUpdatedAt(
    opts.expected_updated_at,
    { required: true },
  )!;
  const idempotencyKey = normalizedIdempotencyKey(opts.idempotency_key);
  const ticketId = positiveTicketId(opts.ticket_id);
  const changes = normalizeUpdateChanges(opts);
  const requestHash = updatePayloadHash({
    ticketId,
    expectedUpdatedAt,
    changes,
  });
  let plan: Awaited<ReturnType<typeof buildUpdatePlan>> | undefined;
  let remoteStarted = false;
  let reservationCreated = false;
  try {
    const reservation = await reserveMutation({
      idempotencyKey,
      operation: "update",
      accountId,
      hash: requestHash,
      auditId,
      ticketId,
    });
    reservationCreated = reservation.created;
    if (!reservation.created) {
      const replay = replayOrRejectMutation<AdminSupportUpdateResponse>(
        reservation.row,
      );
      if (replay) {
        await recordAudit({
          auditId,
          accountId,
          mode: "update",
          reason,
          ticketId,
          payloadHash: requestHash,
          idempotencyKey,
          priorUpdatedAt: expectedUpdatedAt,
          resultStatus: "idempotent_replay",
          durationMs: Date.now() - started,
        });
        return replay;
      }
    }
    plan = await buildUpdatePlan({
      ...opts,
      expected_updated_at: expectedUpdatedAt,
    });

    const ticketPayload: Record<string, unknown> = {
      safe_update: true,
      updated_stamp: expectedUpdatedAt,
      metadata: {
        custom: {
          cocalc_idempotency_key: idempotencyKey,
          cocalc_payload_hash: plan.hash,
          cocalc_audit_id: auditId,
        },
      },
    };
    const body = plan.changes.public_reply ?? plan.changes.private_note;
    if (body) {
      ticketPayload.comment = {
        body,
        public: !!plan.changes.public_reply,
      };
    }
    if (plan.changes.status != null) ticketPayload.status = plan.changes.status;
    if (plan.changes.priority !== undefined) {
      ticketPayload.priority = plan.changes.priority;
    }
    if (plan.changes.assignee_id !== undefined) {
      ticketPayload.assignee_id = plan.changes.assignee_id;
    }
    if (plan.changes.add_tags.length || plan.changes.remove_tags.length) {
      ticketPayload.tags = finalTags(plan.ticket, plan.changes);
    }

    await setMutationStatus({ idempotencyKey, status: "remote_started" });
    remoteStarted = true;
    const client = await getZendeskClient();
    const response = (await withTimeout(
      client.tickets.update(plan.ticketId, {
        ticket: ticketPayload,
      } as CreateOrUpdateTicket),
      "Zendesk ticket update",
    )) as unknown as ZendeskUpdateResult;
    let auditIdFromZendesk = zendeskAuditId(response);
    if (auditIdFromZendesk == null) {
      try {
        auditIdFromZendesk = await findZendeskAuditId({
          client,
          ticketId: plan.ticketId,
          idempotencyKey,
        });
      } catch (error) {
        logger.warn("Zendesk update audit verification failed", {
          ticket_id: plan.ticketId,
          audit_id: auditId,
          error,
        });
      }
    }
    const updatedTicket =
      response?.result ?? response?.response?.ticket ?? plan.ticket;
    let verifiedTicket = updatedTicket;
    let verifiedComment: AdminSupportUpdateResponse["comment"];
    try {
      const verified = await withZendeskReadSlot(
        () => loadTicket(plan!.ticketId),
        "Zendesk ticket update verification",
      );
      verifiedTicket = verified.ticket;
      if (body) {
        verifiedComment = findAppliedComment(
          verified.comments,
          body,
          !!plan.changes.public_reply,
        );
        if (!verifiedComment) {
          logger.warn(
            "Zendesk update comment was not found during verification",
            {
              ticket_id: plan.ticketId,
              audit_id: auditId,
              comment_sha256: sha256(body),
            },
          );
        }
      }
    } catch (error) {
      logger.warn("Zendesk update succeeded but verification read failed", {
        ticket_id: plan.ticketId,
        audit_id: auditId,
        error,
      });
    }
    const result: AdminSupportUpdateResponse = {
      audit_id: auditId,
      operation: "update",
      commit: true,
      payload_hash: plan.hash,
      idempotency_key: idempotencyKey,
      idempotent_replay: false,
      ...(auditIdFromZendesk != null
        ? { zendesk_audit_id: auditIdFromZendesk }
        : {}),
      ...(verifiedComment ? { comment: verifiedComment } : {}),
      ticket: summarizeTicket(verifiedTicket),
    };
    await setMutationStatus({
      idempotencyKey,
      status: "succeeded",
      zendeskAuditId: auditIdFromZendesk,
      safeResponse: result,
    });
    await recordAudit({
      auditId,
      accountId,
      mode: "update",
      reason,
      ticketId: plan.ticketId,
      payloadHash: plan.hash,
      idempotencyKey,
      priorUpdatedAt: expectedUpdatedAt,
      zendeskAuditId: auditIdFromZendesk,
      resultStatus: result.ticket.status,
      durationMs: Date.now() - started,
    });
    return result;
  } catch (error) {
    if (reservationCreated) {
      await setMutationStatus({
        idempotencyKey,
        status:
          remoteStarted && !zendeskDefinitelyRejected(error)
            ? "indeterminate"
            : "rejected",
        error,
      });
    }
    await recordAudit({
      auditId,
      accountId,
      mode: "update",
      reason,
      ticketId,
      payloadHash: plan?.hash ?? requestHash,
      idempotencyKey,
      priorUpdatedAt: expectedUpdatedAt,
      resultStatus: remoteStarted ? "error_after_remote_start" : "rejected",
      durationMs: Date.now() - started,
      error,
    });
    throw error;
  }
}

function mergePayloadHash({
  targetId,
  sourceId,
  targetExpectedUpdatedAt,
  sourceExpectedUpdatedAt,
  targetComment,
  sourceComment,
  targetCommentPublic,
  sourceCommentPublic,
}: {
  targetId: number;
  sourceId: number;
  targetExpectedUpdatedAt: string;
  sourceExpectedUpdatedAt: string;
  targetComment?: string;
  sourceComment?: string;
  targetCommentPublic: boolean;
  sourceCommentPublic: boolean;
}): string {
  return payloadHash({
    operation: "merge",
    target_ticket_id: targetId,
    source_ticket_id: sourceId,
    target_expected_updated_at: targetExpectedUpdatedAt,
    source_expected_updated_at: sourceExpectedUpdatedAt,
    target_comment: targetComment,
    source_comment: sourceComment,
    target_comment_public: targetCommentPublic,
    source_comment_public: sourceCommentPublic,
  });
}

async function buildMergePlan(opts: AdminSupportMergePlanRequest): Promise<{
  target: Ticket;
  source: Ticket;
  targetId: number;
  sourceId: number;
  targetExpectedUpdatedAt: string;
  sourceExpectedUpdatedAt: string;
  targetComment?: string;
  sourceComment?: string;
  hash: string;
}> {
  const targetId = positiveTicketId(opts.target_ticket_id, "target_ticket_id");
  const sourceId = positiveTicketId(opts.source_ticket_id, "source_ticket_id");
  if (targetId === sourceId) {
    throw new Error("merge target and source tickets must be different");
  }
  const targetExpected = normalizedExpectedUpdatedAt(
    opts.target_expected_updated_at,
  );
  const sourceExpected = normalizedExpectedUpdatedAt(
    opts.source_expected_updated_at,
  );
  const targetComment = normalizedComment(opts.target_comment);
  const sourceComment = normalizedComment(opts.source_comment);
  const [target, source] = await withZendeskReadSlot(
    async () =>
      await Promise.all([loadTicketOnly(targetId), loadTicketOnly(sourceId)]),
    "Zendesk merge preflight",
  );
  requireTicketVersion(target, targetExpected, `target ticket ${targetId}`);
  requireTicketVersion(source, sourceExpected, `source ticket ${sourceId}`);
  const targetExpectedUpdatedAt = targetExpected ?? safeDate(target.updated_at);
  const sourceExpectedUpdatedAt = sourceExpected ?? safeDate(source.updated_at);
  const hash = mergePayloadHash({
    targetId,
    sourceId,
    targetExpectedUpdatedAt,
    sourceExpectedUpdatedAt,
    targetComment,
    sourceComment,
    targetCommentPublic: opts.target_comment_public === true,
    sourceCommentPublic: opts.source_comment_public === true,
  });
  return {
    target,
    source,
    targetId,
    sourceId,
    targetExpectedUpdatedAt,
    sourceExpectedUpdatedAt,
    targetComment,
    sourceComment,
    hash,
  };
}

export async function planMerge(
  opts: AdminSupportMergePlanRequest & AuthOpts,
): Promise<AdminSupportMergePlanResponse> {
  const started = Date.now();
  const auditId = uuid();
  const accountId = await requireAdmin(opts);
  const reason = requiredReason(opts.reason);
  try {
    const plan = await buildMergePlan(opts);
    const result: AdminSupportMergePlanResponse = {
      audit_id: auditId,
      operation: "merge",
      commit: false,
      payload_hash: plan.hash,
      target_expected_updated_at: plan.targetExpectedUpdatedAt,
      source_expected_updated_at: plan.sourceExpectedUpdatedAt,
      target_ticket: summarizeTicket(plan.target),
      source_ticket: summarizeTicket(plan.source),
      ...(plan.targetComment
        ? {
            target_comment: commentPreview(
              plan.targetComment,
              opts.target_comment_public ? "public_reply" : "private_note",
            ),
          }
        : {}),
      ...(plan.sourceComment
        ? {
            source_comment: commentPreview(
              plan.sourceComment,
              opts.source_comment_public ? "public_reply" : "private_note",
            ),
          }
        : {}),
    };
    await recordAudit({
      auditId,
      accountId,
      mode: "plan_merge",
      reason,
      ticketId: plan.targetId,
      sourceTicketId: plan.sourceId,
      payloadHash: plan.hash,
      priorUpdatedAt: [
        plan.targetExpectedUpdatedAt,
        plan.sourceExpectedUpdatedAt,
      ],
      resultStatus: "dry_run",
      durationMs: Date.now() - started,
    });
    return result;
  } catch (error) {
    await recordAudit({
      auditId,
      accountId,
      mode: "plan_merge",
      reason,
      ticketId: Number(opts.target_ticket_id) || undefined,
      sourceTicketId: Number(opts.source_ticket_id) || undefined,
      durationMs: Date.now() - started,
      error,
    });
    throw error;
  }
}

function zendeskJobFromResponse(value: unknown): ZendeskMergeJob {
  const candidate = value as any;
  return (
    candidate?.result?.job_status ??
    candidate?.job_status ??
    candidate?.response?.job_status ??
    candidate?.result ??
    {}
  );
}

async function waitForZendeskJob(
  client: Awaited<ReturnType<typeof getZendeskClient>>,
  initial: ZendeskMergeJob,
  operation: string,
): Promise<ZendeskMergeJob> {
  const id = `${initial.id ?? ""}`.trim();
  if (!id || ["completed", "failed", "killed"].includes(`${initial.status}`)) {
    return initial;
  }
  const deadline = Date.now() + ZENDESK_MERGE_TIMEOUT_MS;
  let current = initial;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const response = await client.jobstatuses.show(id);
    current = zendeskJobFromResponse(response);
    if (["completed", "failed", "killed"].includes(`${current.status}`)) {
      return current;
    }
  }
  throw new Error(
    `Zendesk ${operation} job ${id} did not finish within ${ZENDESK_MERGE_TIMEOUT_MS}ms`,
  );
}

export async function merge(
  opts: AdminSupportMergeRequest & AuthOpts,
): Promise<AdminSupportMergeResponse> {
  const started = Date.now();
  const auditId = uuid();
  const accountId = await requireFreshAdmin(opts);
  const reason = requiredReason(opts.reason);
  const targetExpectedUpdatedAt = normalizedExpectedUpdatedAt(
    opts.target_expected_updated_at,
    { required: true },
  )!;
  const sourceExpectedUpdatedAt = normalizedExpectedUpdatedAt(
    opts.source_expected_updated_at,
    { required: true },
  )!;
  const idempotencyKey = normalizedIdempotencyKey(opts.idempotency_key);
  const targetId = positiveTicketId(opts.target_ticket_id, "target_ticket_id");
  const sourceId = positiveTicketId(opts.source_ticket_id, "source_ticket_id");
  if (targetId === sourceId) {
    throw new Error("merge target and source tickets must be different");
  }
  const targetComment = normalizedComment(opts.target_comment);
  const sourceComment = normalizedComment(opts.source_comment);
  const requestHash = mergePayloadHash({
    targetId,
    sourceId,
    targetExpectedUpdatedAt,
    sourceExpectedUpdatedAt,
    targetComment,
    sourceComment,
    targetCommentPublic: opts.target_comment_public === true,
    sourceCommentPublic: opts.source_comment_public === true,
  });
  let plan: Awaited<ReturnType<typeof buildMergePlan>> | undefined;
  let remoteStarted = false;
  let reservationCreated = false;
  let zendeskJobId: string | undefined;
  try {
    const reservation = await reserveMutation({
      idempotencyKey,
      operation: "merge",
      accountId,
      hash: requestHash,
      auditId,
      ticketId: targetId,
      sourceTicketId: sourceId,
    });
    reservationCreated = reservation.created;
    if (!reservation.created) {
      const replay = replayOrRejectMutation<AdminSupportMergeResponse>(
        reservation.row,
      );
      if (replay) {
        await recordAudit({
          auditId,
          accountId,
          mode: "merge",
          reason,
          ticketId: targetId,
          sourceTicketId: sourceId,
          payloadHash: requestHash,
          idempotencyKey,
          priorUpdatedAt: [targetExpectedUpdatedAt, sourceExpectedUpdatedAt],
          resultStatus: "idempotent_replay",
          durationMs: Date.now() - started,
        });
        return replay;
      }
    }
    plan = await buildMergePlan({
      ...opts,
      target_expected_updated_at: targetExpectedUpdatedAt,
      source_expected_updated_at: sourceExpectedUpdatedAt,
    });
    await setMutationStatus({ idempotencyKey, status: "remote_started" });
    remoteStarted = true;
    const client = await getZendeskClient();
    const mergeResponse = await withTimeout(
      client.tickets.merge(plan.targetId, {
        ids: [plan.sourceId],
        ...(plan.targetComment ? { target_comment: plan.targetComment } : {}),
        ...(plan.sourceComment ? { source_comment: plan.sourceComment } : {}),
        target_comment_is_public: opts.target_comment_public === true,
        source_comment_is_public: opts.source_comment_public === true,
      }),
      "Zendesk ticket merge",
    );
    const initialJob = zendeskJobFromResponse(mergeResponse);
    zendeskJobId = `${initialJob.id ?? ""}`.trim() || undefined;
    if (zendeskJobId) {
      await setMutationStatus({
        idempotencyKey,
        status: "remote_started",
        zendeskJobId,
      });
    }
    const job = await waitForZendeskJob(client, initialJob, "merge");
    const jobStatus = `${job.status ?? "completed"}`;
    if (jobStatus !== "completed") {
      throw new Error(
        `Zendesk merge job ${zendeskJobId ?? "(unknown)"} ${jobStatus}: ${job.message ?? "no details"}`,
      );
    }
    const [target, source] = await withZendeskReadSlot(
      async () =>
        await Promise.all([
          loadTicketOnly(plan!.targetId),
          loadTicketOnly(plan!.sourceId),
        ]),
      "Zendesk merge verification",
    );
    const result: AdminSupportMergeResponse = {
      audit_id: auditId,
      operation: "merge",
      commit: true,
      payload_hash: plan.hash,
      idempotency_key: idempotencyKey,
      idempotent_replay: false,
      ...(zendeskJobId ? { zendesk_job_id: zendeskJobId } : {}),
      zendesk_job_status: jobStatus,
      target_ticket: summarizeTicket(target),
      source_ticket: summarizeTicket(source),
    };
    await setMutationStatus({
      idempotencyKey,
      status: "succeeded",
      zendeskJobId,
      safeResponse: result,
    });
    await recordAudit({
      auditId,
      accountId,
      mode: "merge",
      reason,
      ticketId: plan.targetId,
      sourceTicketId: plan.sourceId,
      payloadHash: plan.hash,
      idempotencyKey,
      priorUpdatedAt: [targetExpectedUpdatedAt, sourceExpectedUpdatedAt],
      zendeskJobId,
      resultStatus: jobStatus,
      durationMs: Date.now() - started,
    });
    return result;
  } catch (error) {
    if (reservationCreated) {
      await setMutationStatus({
        idempotencyKey,
        status:
          remoteStarted && !zendeskDefinitelyRejected(error)
            ? "indeterminate"
            : "rejected",
        zendeskJobId,
        error,
      });
    }
    await recordAudit({
      auditId,
      accountId,
      mode: "merge",
      reason,
      ticketId: targetId,
      sourceTicketId: sourceId,
      payloadHash: plan?.hash ?? requestHash,
      idempotencyKey,
      priorUpdatedAt: [targetExpectedUpdatedAt, sourceExpectedUpdatedAt],
      zendeskJobId,
      resultStatus: remoteStarted ? "error_after_remote_start" : "rejected",
      durationMs: Date.now() - started,
      error,
    });
    throw error;
  }
}

const SPAM_WARNING =
  "Zendesk will delete this ticket and suspend its requester. If Zendesk definitively rejects that action, CoCalc will instead solve and tag the ticket without replying or claiming the requester was suspended. Use only for clear unsolicited junk.";

const SPAM_FALLBACK_TAGS = ["spam", "unsolicited"];

type ZendeskRawResponse = {
  response?: {
    status?: number;
    statusCode?: number;
    statusText?: string;
  };
  result?: unknown;
};

function zendeskRawStatus(value: ZendeskRawResponse): number | undefined {
  const status = Number(value?.response?.status ?? value?.response?.statusCode);
  return Number.isSafeInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
}

function zendeskResultDetail(value: unknown): string {
  if (value == null) return "";
  let serialized: string;
  try {
    serialized =
      typeof value === "string"
        ? value
        : JSON.stringify(value, (key, current) =>
            /^(?:authorization|api_?key|access_?token|token|password|passwd|secret)$/i.test(
              key,
            )
              ? "[REDACTED_SECRET]"
              : current,
          );
  } catch {
    serialized = `${value}`;
  }
  return redactSupportText(serialized, 2_000);
}

function zendeskRawError(
  label: string,
  value: ZendeskRawResponse,
): Error | undefined {
  const status = zendeskRawStatus(value);
  if (status == null || status < 400) return undefined;
  const statusText = `${value?.response?.statusText ?? ""}`.trim();
  const detail = zendeskResultDetail(value?.result);
  return Object.assign(
    new Error(
      `${label} failed (${status}${statusText ? ` ${statusText}` : ""})${detail ? `: ${detail}` : ": no response details"}`,
    ),
    { statusCode: status, code: status },
  );
}

async function zendeskRawRequest({
  client,
  method,
  resource,
  body,
  label,
}: {
  client: Awaited<ReturnType<typeof getZendeskClient>>;
  method: "PUT";
  resource: Array<string | number>;
  body: unknown;
  label: string;
}): Promise<ZendeskRawResponse> {
  const response = (await withTimeout(
    client.tickets._rawRequest(method, resource, body),
    label,
  )) as ZendeskRawResponse;
  if (zendeskRawStatus(response) == null) {
    throw new Error(`${label} returned no HTTP status`);
  }
  const error = zendeskRawError(label, response);
  if (error) throw error;
  return response;
}

function zendeskSpamFallbackAllowed(error: unknown): boolean {
  const candidate = error as any;
  return Number(candidate?.statusCode ?? candidate?.code) === 422;
}

async function applySpamFallback({
  client,
  plan,
  idempotencyKey,
  auditId,
}: {
  client: Awaited<ReturnType<typeof getZendeskClient>>;
  plan: Awaited<ReturnType<typeof buildSpamPlan>>;
  idempotencyKey: string;
  auditId: string;
}): Promise<Ticket> {
  const tags = finalTags(plan.ticket, {
    add_tags: SPAM_FALLBACK_TAGS,
    remove_tags: [],
  });
  await zendeskRawRequest({
    client,
    method: "PUT",
    resource: ["tickets", plan.ticketId],
    body: {
      ticket: {
        safe_update: true,
        updated_stamp: plan.expectedUpdatedAt,
        status: "solved",
        tags,
        metadata: {
          custom: {
            cocalc_idempotency_key: idempotencyKey,
            cocalc_payload_hash: plan.hash,
            cocalc_audit_id: auditId,
            cocalc_spam_fallback: true,
          },
        },
      },
    },
    label: "Zendesk spam solve-and-tag fallback",
  });
  const verified = await withZendeskReadSlot(
    () => loadTicketOnly(plan.ticketId),
    "Zendesk spam fallback verification",
  );
  const verifiedTags = new Set(
    (Array.isArray(verified.tags) ? verified.tags : []).map((tag) => `${tag}`),
  );
  if (
    verified.status !== "solved" ||
    SPAM_FALLBACK_TAGS.some((tag) => !verifiedTags.has(tag))
  ) {
    throw new Error(
      "Zendesk spam fallback could not be verified as solved and tagged",
    );
  }
  return verified;
}

function spamPayloadHash({
  ticketId,
  expectedUpdatedAt,
}: {
  ticketId: number;
  expectedUpdatedAt: string;
}): string {
  return payloadHash({
    operation: "spam",
    ticket_id: ticketId,
    expected_updated_at: expectedUpdatedAt,
  });
}

async function buildSpamPlan(opts: AdminSupportSpamPlanRequest): Promise<{
  ticket: Ticket;
  ticketId: number;
  expectedUpdatedAt: string;
  hash: string;
}> {
  const ticketId = positiveTicketId(opts.ticket_id);
  const expected = normalizedExpectedUpdatedAt(opts.expected_updated_at);
  const ticket = await withZendeskReadSlot(
    () => loadTicketOnly(ticketId),
    "Zendesk spam preflight",
  );
  requireTicketVersion(ticket, expected);
  const expectedUpdatedAt = expected ?? safeDate(ticket.updated_at);
  return {
    ticket,
    ticketId,
    expectedUpdatedAt,
    hash: spamPayloadHash({ ticketId, expectedUpdatedAt }),
  };
}

export async function planSpam(
  opts: AdminSupportSpamPlanRequest & AuthOpts,
): Promise<AdminSupportSpamPlanResponse> {
  const started = Date.now();
  const auditId = uuid();
  const accountId = await requireAdmin(opts);
  const reason = requiredReason(opts.reason);
  try {
    const plan = await buildSpamPlan(opts);
    const result: AdminSupportSpamPlanResponse = {
      audit_id: auditId,
      operation: "spam",
      commit: false,
      payload_hash: plan.hash,
      expected_updated_at: plan.expectedUpdatedAt,
      ticket_before: summarizeTicket(plan.ticket),
      warning: SPAM_WARNING,
    };
    await recordAudit({
      auditId,
      accountId,
      mode: "plan_spam",
      reason,
      ticketId: plan.ticketId,
      payloadHash: plan.hash,
      priorUpdatedAt: plan.expectedUpdatedAt,
      resultStatus: "dry_run",
      durationMs: Date.now() - started,
    });
    return result;
  } catch (error) {
    await recordAudit({
      auditId,
      accountId,
      mode: "plan_spam",
      reason,
      ticketId: Number(opts.ticket_id) || undefined,
      durationMs: Date.now() - started,
      error,
    });
    throw error;
  }
}

export async function spam(
  opts: AdminSupportSpamRequest & AuthOpts,
): Promise<AdminSupportSpamResponse> {
  const started = Date.now();
  const auditId = uuid();
  const accountId = await requireFreshAdmin(opts);
  const reason = requiredReason(opts.reason);
  const ticketId = positiveTicketId(opts.ticket_id);
  const expectedUpdatedAt = normalizedExpectedUpdatedAt(
    opts.expected_updated_at,
    { required: true },
  )!;
  const idempotencyKey = normalizedIdempotencyKey(opts.idempotency_key);
  const requestHash = spamPayloadHash({ ticketId, expectedUpdatedAt });
  let plan: Awaited<ReturnType<typeof buildSpamPlan>> | undefined;
  let remoteStarted = false;
  let reservationCreated = false;
  let zendeskJobId: string | undefined;
  try {
    const reservation = await reserveMutation({
      idempotencyKey,
      operation: "spam",
      accountId,
      hash: requestHash,
      auditId,
      ticketId,
    });
    reservationCreated = reservation.created;
    if (!reservation.created) {
      const replay = replayOrRejectMutation<AdminSupportSpamResponse>(
        reservation.row,
      );
      if (replay) {
        await recordAudit({
          auditId,
          accountId,
          mode: "spam",
          reason,
          ticketId,
          payloadHash: requestHash,
          idempotencyKey,
          priorUpdatedAt: expectedUpdatedAt,
          resultStatus: "idempotent_replay",
          durationMs: Date.now() - started,
        });
        return replay;
      }
    }
    plan = await buildSpamPlan({
      ...opts,
      expected_updated_at: expectedUpdatedAt,
    });
    await setMutationStatus({ idempotencyKey, status: "remote_started" });
    remoteStarted = true;
    const client = await getZendeskClient();
    let jobStatus = "completed";
    let fallbackReason: string | undefined;
    let fallbackTicket: Ticket | undefined;
    try {
      const response = await zendeskRawRequest({
        client,
        method: "PUT",
        resource: ["tickets", ticketId, "mark_as_spam"],
        body: {},
        label: "Zendesk mark ticket as spam",
      });
      const initialJob = zendeskJobFromResponse(response);
      zendeskJobId = `${initialJob.id ?? ""}`.trim() || undefined;
      if (zendeskJobId) {
        await setMutationStatus({
          idempotencyKey,
          status: "remote_started",
          zendeskJobId,
        });
      }
      const job = await waitForZendeskJob(client, initialJob, "spam");
      jobStatus = `${job.status ?? "completed"}`;
      if (jobStatus !== "completed") {
        throw new Error(
          `Zendesk spam job ${zendeskJobId ?? "(unknown)"} ${jobStatus}: ${job.message ?? "no details"}`,
        );
      }
    } catch (error) {
      if (!zendeskSpamFallbackAllowed(error)) throw error;
      fallbackReason = redactSupportText(error, 2_000);
      try {
        fallbackTicket = await applySpamFallback({
          client,
          plan,
          idempotencyKey,
          auditId,
        });
      } catch (fallbackError) {
        throw Object.assign(
          new Error(
            `Zendesk rejected spam handling and the safe fallback also failed. Spam rejection: ${fallbackReason}. Fallback error: ${redactSupportText(fallbackError, 2_000)}`,
          ),
          {
            statusCode: (fallbackError as any)?.statusCode,
            code: (fallbackError as any)?.code,
          },
        );
      }
      jobStatus = "fallback_completed";
    }
    const usedFallback = fallbackTicket != null;
    const result: AdminSupportSpamResponse = {
      audit_id: auditId,
      operation: "spam",
      commit: true,
      payload_hash: plan.hash,
      idempotency_key: idempotencyKey,
      idempotent_replay: false,
      ticket_id: ticketId,
      requester_suspended: !usedFallback,
      disposition: usedFallback ? "solved_and_tagged" : "deleted_as_spam",
      ...(fallbackReason ? { fallback_reason: fallbackReason } : {}),
      ...(fallbackTicket ? { ticket: summarizeTicket(fallbackTicket) } : {}),
      ...(zendeskJobId ? { zendesk_job_id: zendeskJobId } : {}),
      zendesk_job_status: jobStatus,
    };
    await setMutationStatus({
      idempotencyKey,
      status: "succeeded",
      zendeskJobId,
      safeResponse: result,
    });
    await recordAudit({
      auditId,
      accountId,
      mode: "spam",
      reason,
      ticketId,
      payloadHash: plan.hash,
      idempotencyKey,
      priorUpdatedAt: expectedUpdatedAt,
      zendeskJobId,
      resultStatus: usedFallback ? "fallback_solved_and_tagged" : jobStatus,
      durationMs: Date.now() - started,
    });
    return result;
  } catch (error) {
    if (reservationCreated) {
      await setMutationStatus({
        idempotencyKey,
        status:
          remoteStarted && !zendeskDefinitelyRejected(error)
            ? "indeterminate"
            : "rejected",
        zendeskJobId,
        error,
      });
    }
    await recordAudit({
      auditId,
      accountId,
      mode: "spam",
      reason,
      ticketId,
      payloadHash: plan?.hash ?? requestHash,
      idempotencyKey,
      priorUpdatedAt: expectedUpdatedAt,
      zendeskJobId,
      resultStatus: remoteStarted ? "error_after_remote_start" : "rejected",
      durationMs: Date.now() - started,
      error,
    });
    throw error;
  }
}
