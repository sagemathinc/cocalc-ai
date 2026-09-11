/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";

import getPool, { type PoolClient } from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterSeedBayId } from "@cocalc/server/cluster-config";
import type {
  CommercialBackfillCandidate,
  CommercialBackfillPlan,
  CommercialBackfillRequest,
  CommercialBackfillResponse,
  CommercialBillingDetailsUpdateRequest,
  CommercialCollectionModeUpdateRequest,
  CommercialInvoiceMutationRequest,
  CommercialManualInvoiceIssueRequest,
  CommercialManualPaymentRequest,
  CommercialMutationRequest,
  CommercialOrderAssignRequest,
  CommercialOrderContactInput,
  CommercialOrderCreatePreview,
  CommercialOrderCreateRequest,
  CommercialOrderNormalizedCreateRequest,
  CommercialOrderEventsRequest,
  CommercialOrderEventsResponse,
  CommercialOrderItemInput,
  CommercialOrderListRequest,
  CommercialOrderListResponse,
  CommercialOrderNoteRequest,
  CommercialOrderDocumentDownload,
  CommercialOrderDocumentDownloadRequest,
  CommercialOrderDocumentUploadRequest,
  CommercialOrderDocumentVoidRequest,
  CommercialOrderRevisionRequest,
  CommercialOrderTransitionRequest,
  CommercialOrderUpdateRequest,
  CommercialQuoteDocument,
  CommercialQuoteLinkRequest,
  CommercialQuoteLinkResult,
  CommercialQuoteDocumentRequest,
  CommercialQuoteIssueRequest,
  CommercialQuotePreview,
  CommercialQuotePreviewRequest,
  CommercialQuoteVoidRequest,
  CommercialStripeQuoteCreateRequest,
  CommercialStripeEventRetryRequest,
  CommercialStripeEventRetryResult,
} from "@cocalc/conat/hub/api/commercial-orders";
import type {
  CommercialCollectionState,
  CommercialEventSource,
  CommercialFulfillmentState,
  CommercialInvoice,
  CommercialOrder,
  CommercialOrderContact,
  CommercialOrderDocument,
  CommercialOrderDiagnostics,
  CommercialOrderEvent,
  CommercialOrderItem,
  CommercialOrderSummary,
  CommercialPayment,
  CommercialQuote,
  CommercialWorkflowState,
} from "@cocalc/util/commercial-orders";
import { COMMERCIAL_ORDER_DOCUMENT_MAX_BYTES } from "@cocalc/util/commercial-orders";
import {
  moneyAdd,
  moneyCompare,
  moneySubtract,
  moneyToDbString,
  toDecimal,
} from "@cocalc/util/money";
import {
  assertProviderMutationEnums,
  assertInvoiceTermsSnapshot,
  assertWorkflowTransition,
  collectionSatisfied,
  fulfillmentSatisfied,
  normalizeContacts,
  normalizeCreateRequest,
  normalizeCurrency,
  normalizeItems,
  normalizeMoney,
  normalizeNextAction,
  normalizePositiveMoney,
  requireExpectedVersion,
  requireReason,
  shouldComplete,
  validateIndependentStates,
} from "./state";
import { recordCommercialOperator } from "./observability";
import { renderCommercialQuotePdf } from "./quote-document";

type Queryable = PoolClient | ReturnType<typeof getPool>;

type RawOrder = Omit<
  CommercialOrder,
  | "items"
  | "contacts"
  | "quotes"
  | "documents"
  | "invoices"
  | "payments"
  | "created_at"
  | "updated_at"
  | "service_starts_at"
  | "service_ends_at"
  | "next_action_due_at"
  | "approved_at"
  | "provisioned_at"
  | "completed_at"
  | "cancelled_at"
> & {
  created_at: Date | string;
  updated_at: Date | string;
  service_starts_at?: Date | string | null;
  service_ends_at?: Date | string | null;
  next_action_due_at?: Date | string | null;
  approved_at?: Date | string | null;
  provisioned_at?: Date | string | null;
  completed_at?: Date | string | null;
  cancelled_at?: Date | string | null;
};

const ORDER_MUTABLE_COLUMNS = new Set([
  "crm_organization_id",
  "organization_name",
  "customer_account_id",
  "site_license_id",
  "stripe_customer_id",
  "zendesk_ticket_ids",
  "workflow_state",
  "collection_mode",
  "currency",
  "agreed_subtotal",
  "agreed_total",
  "service_starts_at",
  "service_ends_at",
  "payment_terms_days",
  "po_number",
  "customer_reference",
  "terms_snapshot",
  "assignee_account_id",
  "next_action",
  "next_action_due_at",
]);

const APPROVED_TERM_COLUMNS = new Set([
  "organization_name",
  "collection_mode",
  "currency",
  "agreed_subtotal",
  "agreed_total",
  "service_starts_at",
  "service_ends_at",
  "payment_terms_days",
  "po_number",
  "customer_reference",
  "terms_snapshot",
  "site_license_id",
]);

const INVOICE_LOCKED_COLUMNS = new Set([
  ...APPROVED_TERM_COLUMNS,
  "customer_account_id",
  "stripe_customer_id",
]);

function assertSeedAuthority(): void {
  const current = getConfiguredBayId();
  const seed = getConfiguredClusterSeedBayId();
  if (current !== seed) {
    throw Error(
      `commercial orders are seed-global; operation reached ${current}, expected ${seed}`,
    );
  }
}

function iso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function money(value: unknown): string {
  return moneyToDbString(value == null ? 0 : `${value}`);
}

function normalizeOrderRow(
  row: RawOrder,
): Omit<
  CommercialOrder,
  "items" | "contacts" | "quotes" | "documents" | "invoices" | "payments"
> {
  return {
    ...row,
    agreed_subtotal: money(row.agreed_subtotal),
    agreed_total: money(row.agreed_total),
    created_at: iso(row.created_at)!,
    updated_at: iso(row.updated_at)!,
    service_starts_at: iso(row.service_starts_at),
    service_ends_at: iso(row.service_ends_at),
    next_action_due_at: iso(row.next_action_due_at),
    approved_at: iso(row.approved_at),
    provisioned_at: iso(row.provisioned_at),
    completed_at: iso(row.completed_at),
    cancelled_at: iso(row.cancelled_at),
    zendesk_ticket_ids: row.zendesk_ticket_ids ?? [],
    terms_snapshot: row.terms_snapshot ?? {},
  };
}

function normalizeItemRow(row: any): CommercialOrderItem {
  return {
    ...row,
    quantity: money(row.quantity),
    unit_amount: money(row.unit_amount),
    subtotal: money(row.subtotal),
    service_start: iso(row.service_start),
    service_end: iso(row.service_end),
    metadata: row.metadata ?? {},
    created_at: iso(row.created_at)!,
    updated_at: iso(row.updated_at)!,
  };
}

function normalizeContactRow(row: any): CommercialOrderContact {
  return {
    ...row,
    created_at: iso(row.created_at)!,
    updated_at: iso(row.updated_at)!,
  };
}

function normalizeQuoteRow(row: any): CommercialQuote {
  const {
    document_data: _documentData,
    download_token_hash: _downloadTokenHash,
    download_window_at: _downloadWindowAt,
    download_window_count: _downloadWindowCount,
    ...metadata
  } = row;
  return {
    ...metadata,
    subtotal: money(row.subtotal),
    total: money(row.total),
    issued_at: iso(row.issued_at),
    valid_until: iso(row.valid_until)!,
    voided_at: iso(row.voided_at),
    snapshot: row.snapshot ?? {},
    provider_snapshot: row.provider_snapshot ?? {},
    provider_updated_at: iso(row.provider_updated_at),
    last_reconciled_at: iso(row.last_reconciled_at),
    created_at: iso(row.created_at)!,
    updated_at: iso(row.updated_at)!,
  };
}

function normalizeOrderDocumentRow(row: any): CommercialOrderDocument {
  const { document_data: _documentData, ...metadata } = row;
  return {
    ...metadata,
    voided_at: iso(row.voided_at),
    created_at: iso(row.created_at)!,
    updated_at: iso(row.updated_at)!,
  };
}

export function normalizeInvoiceRow(row: any): CommercialInvoice {
  return {
    ...row,
    subtotal: money(row.subtotal),
    tax: money(row.tax),
    total: money(row.total),
    amount_due: money(row.amount_due),
    amount_paid: money(row.amount_paid),
    due_at: iso(row.due_at),
    sent_at: iso(row.sent_at),
    paid_at: iso(row.paid_at),
    voided_at: iso(row.voided_at),
    last_reconciled_at: iso(row.last_reconciled_at),
    provider_snapshot: row.provider_snapshot ?? {},
    created_at: iso(row.created_at)!,
    updated_at: iso(row.updated_at)!,
  };
}

function normalizePaymentRow(row: any): CommercialPayment {
  return {
    ...row,
    amount: money(row.amount),
    received_at: iso(row.received_at)!,
    created_at: iso(row.created_at)!,
    updated_at: iso(row.updated_at)!,
  };
}

function normalizeEventRow(row: any): CommercialOrderEvent {
  return {
    ...row,
    before: row.before ?? {},
    after: row.after ?? {},
    metadata: row.metadata ?? {},
    created_at: iso(row.created_at)!,
  };
}

async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  assertSeedAuthority();
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

function stableJson(value: unknown): string {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !["session_hash", "timeout"].includes(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

function eventPayload(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key]) =>
        ![
          "account_id",
          "browser_id",
          "id",
          "idempotency_key",
          "reason",
          "session_hash",
          "source",
          "timeout",
        ].includes(key),
    ),
  );
}

interface EventReplayIdentity {
  action: string;
  order_id: string;
  payload_hash: string;
}

function eventReplayIdentity(
  action: string,
  orderId: string,
  payload: Record<string, unknown>,
): EventReplayIdentity {
  return {
    action,
    order_id: orderId,
    payload_hash: createHash("sha256")
      .update(stableJson(eventPayload(payload)))
      .digest("hex"),
  };
}

export function commercialIdempotencyKey(
  type: string,
  opts: Record<string, unknown>,
): string {
  if (typeof opts.idempotency_key === "string" && opts.idempotency_key.trim()) {
    return opts.idempotency_key.trim().slice(0, 240);
  }
  return `commercial:${type}:${createHash("sha256")
    .update(stableJson(opts))
    .digest("hex")}`;
}

function assertEventReplayIdentity(
  event: CommercialOrderEvent,
  expected: EventReplayIdentity,
): void {
  const actual = event.metadata?._idempotency as
    | Partial<EventReplayIdentity>
    | undefined;
  if (
    event.event_type !== expected.action ||
    event.commercial_order_id !== expected.order_id ||
    actual?.action !== expected.action ||
    actual?.order_id !== expected.order_id ||
    actual?.payload_hash !== expected.payload_hash
  ) {
    throw Error(
      "commercial idempotency key was already used for a different action, order, or payload",
    );
  }
}

async function replayOrderId(
  client: Queryable,
  idempotencyKey: string,
  opts: {
    action: string;
    order_id?: string;
    payload: Record<string, unknown>;
  },
): Promise<string | undefined> {
  const { rows } = await client.query(
    "SELECT * FROM commercial_order_events WHERE idempotency_key=$1",
    [idempotencyKey],
  );
  if (!rows[0]) return;
  const event = normalizeEventRow(rows[0]);
  assertEventReplayIdentity(
    event,
    eventReplayIdentity(
      opts.action,
      opts.order_id ?? event.commercial_order_id,
      opts.payload,
    ),
  );
  return event.commercial_order_id;
}

async function insertEvent(
  client: Queryable,
  opts: {
    commercial_order_id: string;
    event_type: string;
    actor_account_id?: string | null;
    source?: CommercialEventSource;
    reason: string;
    idempotency_key: string;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    identity_payload: Record<string, unknown>;
  },
): Promise<CommercialOrderEvent> {
  const identity = eventReplayIdentity(
    opts.event_type,
    opts.commercial_order_id,
    opts.identity_payload,
  );
  const { rows } = await client.query(
    `INSERT INTO commercial_order_events
       (id,commercial_order_id,event_type,actor_account_id,source,reason,
        idempotency_key,before,after,metadata,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
     ON CONFLICT (idempotency_key) DO UPDATE
       SET idempotency_key=EXCLUDED.idempotency_key
     RETURNING *`,
    [
      randomUUID(),
      opts.commercial_order_id,
      opts.event_type,
      opts.actor_account_id ?? null,
      opts.source ?? "system",
      opts.reason,
      opts.idempotency_key,
      opts.before ?? {},
      opts.after ?? {},
      { ...(opts.metadata ?? {}), _idempotency: identity },
    ],
  );
  const event = normalizeEventRow(rows[0]);
  assertEventReplayIdentity(event, identity);
  return event;
}

async function resolveOrderId(
  client: Queryable,
  id: string,
  forUpdate = false,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM commercial_orders
      WHERE id::text=$1 OR upper(order_number)=upper($1)
      ${forUpdate ? "FOR UPDATE" : ""}`,
    [id.trim()],
  );
  if (!rows[0]) throw Error(`commercial order '${id}' not found`);
  return rows[0].id;
}

async function loadOrder(
  client: Queryable,
  id: string,
  forUpdate = false,
): Promise<CommercialOrder> {
  const orderId = await resolveOrderId(client, id, forUpdate);
  const [orderResult, items, contacts, quotes, documents, invoices, payments] =
    await Promise.all([
      client.query<RawOrder>("SELECT * FROM commercial_orders WHERE id=$1", [
        orderId,
      ]),
      client.query(
        "SELECT * FROM commercial_order_items WHERE commercial_order_id=$1 ORDER BY position,id",
        [orderId],
      ),
      client.query(
        "SELECT * FROM commercial_order_contacts WHERE commercial_order_id=$1 ORDER BY role,id",
        [orderId],
      ),
      client.query(
        `SELECT id,commercial_order_id,quote_number,status,provider,
              provider_quote_id,provider_status,provider_invoice_id,
              currency,subtotal,total,
              issued_at,valid_until,voided_at,document_filename,
              document_mime_type,document_sha256,document_size,snapshot,
              provider_snapshot,provider_updated_at,last_reconciled_at,
              created_by_account_id,voided_by_account_id,idempotency_key,
              created_at,updated_at
         FROM commercial_quotes
        WHERE commercial_order_id=$1 ORDER BY issued_at DESC,id`,
        [orderId],
      ),
      client.query(
        `SELECT id,commercial_order_id,document_kind,status,document_reference,
                note,document_filename,document_mime_type,document_sha256,
                document_size,created_by_account_id,voided_by_account_id,
                voided_at,idempotency_key,created_at,updated_at
           FROM commercial_order_documents
          WHERE commercial_order_id=$1 ORDER BY created_at DESC,id`,
        [orderId],
      ),
      client.query(
        "SELECT * FROM commercial_invoices WHERE commercial_order_id=$1 ORDER BY created_at DESC,id",
        [orderId],
      ),
      client.query(
        "SELECT * FROM commercial_payments WHERE commercial_order_id=$1 ORDER BY received_at DESC,id",
        [orderId],
      ),
    ]);
  const order = {
    ...normalizeOrderRow(orderResult.rows[0]),
    items: items.rows.map(normalizeItemRow),
    contacts: contacts.rows.map(normalizeContactRow),
    quotes: quotes.rows.map(normalizeQuoteRow),
    documents: documents.rows.map(normalizeOrderDocumentRow),
    invoices: invoices.rows.map(normalizeInvoiceRow),
    payments: payments.rows.map(normalizePaymentRow),
  } as CommercialOrder;
  validateIndependentStates(order);
  return order;
}

export async function getCommercialOrder(id: string): Promise<CommercialOrder> {
  assertSeedAuthority();
  return await loadOrder(getPool(), id);
}

async function insertItems(
  client: Queryable,
  orderId: string,
  items: Array<CommercialOrderItemInput & { position: number }>,
): Promise<void> {
  for (const item of items) {
    await client.query(
      `INSERT INTO commercial_order_items
         (id,commercial_order_id,position,description,quantity,unit_amount,
          subtotal,service_start,service_end,product_kind,product_reference,
          metadata,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),NOW())`,
      [
        item.id ?? randomUUID(),
        orderId,
        item.position,
        item.description,
        item.quantity,
        item.unit_amount,
        item.subtotal,
        item.service_start ?? null,
        item.service_end ?? null,
        item.product_kind,
        item.product_reference ?? null,
        item.metadata ?? {},
      ],
    );
  }
}

async function insertContacts(
  client: Queryable,
  orderId: string,
  contacts: CommercialOrderContactInput[],
): Promise<void> {
  for (const contact of contacts) {
    await client.query(
      `INSERT INTO commercial_order_contacts
         (id,commercial_order_id,crm_person_id,role,name_snapshot,email_snapshot,
          organization_snapshot,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW())`,
      [
        contact.id ?? randomUUID(),
        orderId,
        contact.crm_person_id ?? null,
        contact.role,
        contact.name_snapshot,
        contact.email_snapshot,
        contact.organization_snapshot ?? null,
      ],
    );
  }
}

export async function createCommercialOrder(
  opts: CommercialOrderCreateRequest,
): Promise<CommercialOrder> {
  const { normalized_request: normalized } = previewCommercialOrderCreate(opts);
  const key = commercialIdempotencyKey("create", opts as any);
  return await withTransaction(async (client) => {
    const replay = await replayOrderId(client, key, {
      action: "order-created",
      payload: opts as any,
    });
    if (replay) {
      recordCommercialOperator("create", "replay");
      return await loadOrder(client, replay);
    }
    if (!opts.account_id) throw Error("account_id is required");
    const id = randomUUID();
    const orderNumber = `AR-${new Date().getUTCFullYear()}-${id.slice(0, 8).toUpperCase()}`;
    await client.query(
      `INSERT INTO commercial_orders
         (id,order_number,crm_organization_id,organization_name,
          customer_account_id,stripe_customer_id,site_license_id,
          zendesk_ticket_ids,workflow_state,collection_mode,collection_state,
          fulfillment_state,currency,agreed_subtotal,agreed_total,
          service_starts_at,service_ends_at,payment_terms_days,po_number,
          customer_reference,terms_snapshot,assignee_account_id,next_action,
          next_action_due_at,created_by_account_id,created_at,updated_at,version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'not_invoiced',
         'not_provisioned',$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
         $23,NOW(),NOW(),1)`,
      [
        id,
        orderNumber,
        opts.crm_organization_id ?? null,
        normalized.organization_name,
        opts.customer_account_id ?? null,
        opts.stripe_customer_id ?? null,
        opts.site_license_id ?? null,
        opts.zendesk_ticket_ids ?? [],
        normalized.workflow_state,
        normalized.collection_mode,
        normalized.currency,
        normalized.agreed_subtotal,
        normalized.agreed_total,
        opts.service_starts_at ?? null,
        opts.service_ends_at ?? null,
        opts.payment_terms_days ?? 21,
        opts.po_number ?? null,
        opts.customer_reference ?? null,
        opts.terms_snapshot ?? {},
        opts.assignee_account_id ?? opts.account_id,
        normalized.next_action,
        normalized.next_action_due_at ?? null,
        opts.account_id,
      ],
    );
    await insertItems(client, id, normalized.items);
    await insertContacts(client, id, normalized.contacts);
    const order = await loadOrder(client, id);
    await insertEvent(client, {
      commercial_order_id: id,
      event_type: "order-created",
      actor_account_id: opts.account_id,
      source: opts.source ?? "cli",
      reason: normalized.reason,
      idempotency_key: key,
      after: order as any,
      identity_payload: opts as any,
    });
    return order;
  });
}

export function previewCommercialOrderCreate(
  opts: CommercialOrderCreateRequest,
): CommercialOrderCreatePreview {
  assertSeedAuthority();
  const reason = requireReason(opts.reason);
  if (!opts.account_id) throw Error("account_id is required");
  const normalized = normalizeCreateRequest(opts);
  const {
    account_id: _accountId,
    browser_id: _browserId,
    session_hash: _sessionHash,
    ...publicRequest
  } = opts;
  const normalizedRequest: CommercialOrderNormalizedCreateRequest = {
    ...publicRequest,
    ...normalized,
    reason,
  };
  const approvalBlockers: string[] = [];
  if (
    normalized.contacts.filter(({ role }) => role === "billing").length !== 1
  ) {
    approvalBlockers.push(
      "exactly one billing contact is required before approval",
    );
  }
  return {
    normalized_request: normalizedRequest,
    approval_ready: approvalBlockers.length === 0,
    approval_blockers: approvalBlockers,
  };
}

function decodeCursor(
  cursor?: string,
): { updated_at: string; id: string } | undefined {
  if (!cursor) return;
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (
      typeof parsed.updated_at !== "string" ||
      typeof parsed.id !== "string"
    ) {
      throw Error();
    }
    return parsed;
  } catch {
    throw Error("invalid commercial order cursor");
  }
}

function encodeCursor(order: CommercialOrderSummary): string {
  return Buffer.from(
    JSON.stringify({ updated_at: order.updated_at, id: order.id }),
  ).toString("base64url");
}

export async function listCommercialOrders(
  opts: CommercialOrderListRequest,
): Promise<CommercialOrderListResponse> {
  assertSeedAuthority();
  requireReason(opts.reason);
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const maxBytes = Math.min(
    Math.max(opts.max_bytes ?? 1_000_000, 10_000),
    5_000_000,
  );
  const where: string[] = [];
  const values: unknown[] = [];
  const noValue = Symbol("no-value");
  const add = (clause: string, value: unknown | typeof noValue = noValue) => {
    if (value !== noValue) {
      values.push(value);
      where.push(clause.replace("?", `$${values.length}`));
    } else where.push(clause);
  };
  if (opts.workflow_states?.length)
    add("o.workflow_state = ANY(?::text[])", opts.workflow_states);
  if (opts.collection_states?.length)
    add("o.collection_state = ANY(?::text[])", opts.collection_states);
  if (opts.fulfillment_states?.length)
    add("o.fulfillment_state = ANY(?::text[])", opts.fulfillment_states);
  if (opts.assignee_account_id === null) add("o.assignee_account_id IS NULL");
  else if (opts.assignee_account_id)
    add("o.assignee_account_id=?::uuid", opts.assignee_account_id);
  if (opts.organization)
    add("o.organization_name ILIKE ?", `%${opts.organization}%`);
  if (opts.zendesk_ticket_id != null)
    add("?::integer = ANY(o.zendesk_ticket_ids)", opts.zendesk_ticket_id);
  if (opts.site_license_id)
    add("o.site_license_id=?::uuid", opts.site_license_id);
  if (opts.needs_action)
    add("o.workflow_state NOT IN ('complete','cancelled')");
  if (opts.stale_before)
    add("o.updated_at < ?::timestamptz", opts.stale_before);
  if (opts.next_action_due_before)
    add("o.next_action_due_at < ?::timestamptz", opts.next_action_due_before);
  if (opts.min_amount)
    add(
      "o.agreed_total >= ?::numeric",
      normalizeMoney(opts.min_amount, "min_amount"),
    );
  if (opts.max_amount)
    add(
      "o.agreed_total <= ?::numeric",
      normalizeMoney(opts.max_amount, "max_amount"),
    );
  if (opts.search) {
    add(
      "(o.order_number ILIKE ? OR o.organization_name ILIKE ? OR o.po_number ILIKE ? OR o.customer_reference ILIKE ?)",
      `%${opts.search}%`,
    );
    const p = `$${values.length}`;
    where[where.length - 1] = where[where.length - 1].replaceAll("?", p);
  }
  const cursor = decodeCursor(opts.cursor);
  if (cursor) {
    values.push(cursor.updated_at, cursor.id);
    where.push(
      `(o.updated_at,o.id) < ($${values.length - 1}::timestamptz,$${values.length}::uuid)`,
    );
  }
  values.push(limit + 1);
  const { rows } = await getPool().query<any>(
    `SELECT o.*,
       (SELECT email_snapshot FROM commercial_order_contacts c
         WHERE c.commercial_order_id=o.id AND c.role='billing'
         ORDER BY c.created_at LIMIT 1) AS billing_email,
       i.id AS latest_invoice_id,
       i.status AS latest_invoice_status,
       i.amount_due AS latest_invoice_amount_due,
       i.due_at AS latest_invoice_due_at,
       i.sent_at AS latest_invoice_sent_at,
       i.created_at AS latest_invoice_created_at,
       GREATEST(o.updated_at,COALESCE(i.updated_at,o.updated_at)) AS last_activity_at
     FROM commercial_orders o
     LEFT JOIN LATERAL (
       SELECT id,status,amount_due,due_at,sent_at,created_at,updated_at
         FROM commercial_invoices
        WHERE commercial_order_id=o.id ORDER BY created_at DESC LIMIT 1
     ) i ON TRUE
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY o.updated_at DESC,o.id DESC LIMIT $${values.length}`,
    values,
  );
  let truncated = rows.length > limit;
  const candidates = rows.slice(0, limit).map((row) => {
    const { terms_snapshot: _termsSnapshot, ...summary } =
      normalizeOrderRow(row);
    return {
      ...summary,
      billing_email: row.billing_email,
      latest_invoice_id: row.latest_invoice_id,
      latest_invoice_status: row.latest_invoice_status,
      latest_invoice_amount_due:
        row.latest_invoice_amount_due == null
          ? null
          : money(row.latest_invoice_amount_due),
      latest_invoice_due_at: iso(row.latest_invoice_due_at),
      latest_invoice_sent_at: iso(row.latest_invoice_sent_at),
      latest_invoice_created_at: iso(row.latest_invoice_created_at),
      last_activity_at: iso(row.last_activity_at)!,
    };
  }) as CommercialOrderSummary[];
  const orders: CommercialOrderSummary[] = [];
  let lastExamined: CommercialOrderSummary | undefined;
  let resultBytes = 2;
  for (const order of candidates) {
    lastExamined = order;
    const size = Buffer.byteLength(JSON.stringify(order), "utf8") + 1;
    if (resultBytes + size > maxBytes) {
      truncated = true;
      break;
    }
    orders.push(order);
    resultBytes += size;
  }
  return {
    orders,
    next_cursor:
      truncated && (orders.at(-1) ?? lastExamined)
        ? encodeCursor((orders.at(-1) ?? lastExamined)!)
        : undefined,
    truncated,
    result_bytes: resultBytes,
  };
}

export async function listCommercialOrderEvents(
  opts: CommercialOrderEventsRequest,
): Promise<CommercialOrderEventsResponse> {
  assertSeedAuthority();
  requireReason(opts.reason);
  const id = await resolveOrderId(getPool(), opts.id);
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const maxBytes = Math.min(
    Math.max(opts.max_bytes ?? 1_000_000, 10_000),
    5_000_000,
  );
  const values: unknown[] = [id];
  let cursorWhere = "";
  if (opts.cursor) {
    let decoded: { created_at: string; id: string };
    try {
      decoded = JSON.parse(
        Buffer.from(opts.cursor, "base64url").toString("utf8"),
      );
      if (
        typeof decoded.created_at !== "string" ||
        typeof decoded.id !== "string"
      ) {
        throw Error();
      }
    } catch {
      throw Error("invalid event cursor");
    }
    values.push(decoded.created_at, decoded.id);
    cursorWhere = `AND (created_at,id) < ($${values.length - 1}::timestamptz,$${values.length}::uuid)`;
  }
  values.push(limit + 1);
  const { rows } = await getPool().query(
    `SELECT * FROM commercial_order_events WHERE commercial_order_id=$1
      ${cursorWhere} ORDER BY created_at DESC,id DESC LIMIT $${values.length}`,
    values,
  );
  let truncated = rows.length > limit;
  const candidates = rows.slice(0, limit).map(normalizeEventRow);
  const events: CommercialOrderEvent[] = [];
  let lastExamined: CommercialOrderEvent | undefined;
  let resultBytes = 2;
  for (const event of candidates) {
    lastExamined = event;
    const size = Buffer.byteLength(JSON.stringify(event), "utf8") + 1;
    if (resultBytes + size > maxBytes) {
      truncated = true;
      break;
    }
    events.push(event);
    resultBytes += size;
  }
  return {
    events,
    next_cursor:
      truncated && (events.at(-1) ?? lastExamined)
        ? Buffer.from(
            JSON.stringify({
              created_at: (events.at(-1) ?? lastExamined)!.created_at,
              id: (events.at(-1) ?? lastExamined)!.id,
            }),
          ).toString("base64url")
        : undefined,
    truncated,
    result_bytes: resultBytes,
  };
}

async function mutateOrder(
  eventType: string,
  opts: CommercialMutationRequest & { id: string },
  fn: (
    client: PoolClient,
    before: CommercialOrder,
  ) => Promise<{
    changes?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }>,
): Promise<CommercialOrder> {
  const reason = requireReason(opts.reason);
  assertProviderMutationEnums({ source: opts.source });
  const key = commercialIdempotencyKey(eventType, opts as any);
  return await withTransaction(async (client) => {
    const orderId = await resolveOrderId(client, opts.id);
    const replay = await replayOrderId(client, key, {
      action: eventType,
      order_id: orderId,
      payload: opts as any,
    });
    if (replay) {
      recordCommercialOperator(eventType, "replay");
      return await loadOrder(client, replay);
    }
    const before = await loadOrder(client, orderId, true);
    requireExpectedVersion(before.version, opts.expected_version);
    const result = await fn(client, before);
    const changes = result.changes ?? {};
    if (Object.keys(changes).length) {
      const entries = Object.entries(changes);
      const values = entries.map(([, value]) => value);
      values.push(before.id);
      await client.query(
        `UPDATE commercial_orders SET ${entries
          .map(([column], index) => `${column}=$${index + 1}`)
          .join(
            ",",
          )}, updated_at=NOW(), version=version+1 WHERE id=$${values.length}`,
        values,
      );
    } else {
      await client.query(
        "UPDATE commercial_orders SET updated_at=NOW(),version=version+1 WHERE id=$1",
        [before.id],
      );
    }
    const after = await loadOrder(client, before.id);
    await insertEvent(client, {
      commercial_order_id: before.id,
      event_type: eventType,
      actor_account_id: opts.account_id,
      source: opts.source ?? "cli",
      reason,
      idempotency_key: key,
      before: before as any,
      after: after as any,
      metadata: result.metadata,
      identity_payload: opts as any,
    });
    return after;
  });
}

function assertOrderNotTerminal(
  order: CommercialOrder,
  operation: string,
): void {
  if (["complete", "cancelled"].includes(order.workflow_state)) {
    throw Error(
      `${operation} is not allowed on a ${order.workflow_state} order`,
    );
  }
}

function assertNoActiveStripeQuote(
  order: CommercialOrder,
  operation: string,
): void {
  const quote = order.quotes.find(
    ({ provider, status }) =>
      provider === "stripe" && ["draft", "issued"].includes(status),
  );
  if (quote) {
    throw Error(
      `${operation} is blocked while Stripe quote ${quote.quote_number} is active; cancel it first`,
    );
  }
}

async function assertNoUnresolvedProviderOperations(
  client: Queryable,
  orderId: string,
  operation: string,
): Promise<void> {
  const { rows } = await client.query<{ operation: string; status: string }>(
    `SELECT operation,status FROM commercial_provider_operations
       WHERE commercial_order_id=$1
         AND status IN ('reserved','remote_started','indeterminate')
       ORDER BY created_at LIMIT 1`,
    [orderId],
  );
  if (rows[0]) {
    throw Error(
      `${operation} is blocked while provider operation ${rows[0].operation} is ${rows[0].status}`,
    );
  }
}

async function applyCommercialOrderUpdate(
  opts: CommercialOrderUpdateRequest,
  revision: boolean,
): Promise<CommercialOrder> {
  return await mutateOrder(
    revision ? "order-revised" : "order-updated",
    opts,
    async (client, before) => {
      assertOrderNotTerminal(before, revision ? "revision" : "update");
      await assertNoUnresolvedProviderOperations(
        client,
        before.id,
        revision ? "revision" : "update",
      );
      if (revision && before.fulfillment_state !== "not_provisioned") {
        throw Error("fulfilled commercial terms cannot be revised");
      }
      const changes: Record<string, unknown> = {};
      for (const [column, raw] of Object.entries(opts.changes ?? {})) {
        if (!ORDER_MUTABLE_COLUMNS.has(column))
          throw Error(`field ${column} is not editable`);
        if (column === "workflow_state" && raw != null) {
          if (revision) {
            throw Error("a terms revision always returns the order to draft");
          }
          if (before.approved_at) {
            throw Error(
              "approved workflow state cannot be changed by a generic update; revise the approved terms instead",
            );
          }
          if (["complete", "cancelled"].includes(`${raw}`)) {
            throw Error(
              "use the explicit completion or cancellation workflow instead of a generic update",
            );
          }
          assertWorkflowTransition(
            before.workflow_state,
            raw as CommercialWorkflowState,
          );
        }
        if (column === "currency" && raw != null)
          changes[column] = normalizeCurrency(`${raw}`);
        else if (column === "terms_snapshot" && raw != null) {
          if (typeof raw !== "object" || Array.isArray(raw)) {
            throw Error("terms_snapshot must be an object");
          }
          assertInvoiceTermsSnapshot(raw as Record<string, unknown>);
          changes[column] = raw;
        } else if (
          ["agreed_subtotal", "agreed_total"].includes(column) &&
          raw != null
        ) {
          changes[column] = normalizePositiveMoney(`${raw}`, column);
        } else if (column === "next_action") {
          changes[column] = normalizeNextAction(raw);
        } else if (column === "organization_name") {
          const value = `${raw ?? ""}`.trim();
          if (!value) throw Error(`${column} cannot be empty`);
          changes[column] = value;
        } else changes[column] = raw ?? null;
      }
      const approvedTermsChange =
        opts.items != null ||
        opts.contacts != null ||
        Object.keys(changes).some((key) => APPROVED_TERM_COLUMNS.has(key));
      const invoiceLockedChange =
        opts.items != null ||
        opts.contacts != null ||
        Object.keys(changes).some((key) => INVOICE_LOCKED_COLUMNS.has(key));
      if (approvedTermsChange) {
        assertNoActiveStripeQuote(before, "commercial terms update");
      }
      if (
        invoiceLockedChange &&
        before.invoices.some(
          ({ status }) => !["void", "failed"].includes(status),
        )
      ) {
        throw Error(
          "financial terms are locked after an invoice is created; void it before revising the order",
        );
      }
      if (approvedTermsChange && before.approved_at && !revision) {
        throw Error(
          "approved terms are frozen; use the explicit revision operation",
        );
      }
      if (revision) {
        if (!before.approved_at || !before.approved_by_account_id) {
          throw Error("only approved terms can be revised");
        }
        if (!approvedTermsChange) {
          throw Error(
            "a revision must change approved terms, items, or contacts",
          );
        }
        const nextAction = normalizeNextAction(
          changes.next_action ?? "Review agreement",
        );
        const nextActionDueAt =
          changes.next_action_due_at ?? before.next_action_due_at;
        if (!nextActionDueAt) {
          throw Error("a revised order requires a next-action due date");
        }
        Object.assign(changes, {
          workflow_state: "draft",
          collection_state: "not_invoiced",
          approved_at: null,
          approved_by_account_id: null,
          completed_at: null,
          next_action: nextAction,
          next_action_due_at: nextActionDueAt,
        });
      }
      const subtotal = `${changes.agreed_subtotal ?? before.agreed_subtotal}`;
      const total = `${changes.agreed_total ?? before.agreed_total}`;
      if (moneyCompare(total, subtotal) < 0) {
        throw Error("agreed_total must not be less than agreed_subtotal");
      }
      if (opts.items) {
        const items = normalizeItems(opts.items, subtotal);
        await client.query(
          "DELETE FROM commercial_order_items WHERE commercial_order_id=$1",
          [before.id],
        );
        await insertItems(client, before.id, items);
      } else if (changes.agreed_subtotal != null) {
        normalizeItems(before.items, subtotal);
      }
      if (opts.contacts) {
        const contacts = normalizeContacts(opts.contacts);
        await client.query(
          "DELETE FROM commercial_order_contacts WHERE commercial_order_id=$1",
          [before.id],
        );
        await insertContacts(client, before.id, contacts);
      }
      return {
        changes,
        metadata: revision ? { approval_reset: true } : undefined,
      };
    },
  );
}

export async function updateCommercialOrder(
  opts: CommercialOrderUpdateRequest,
): Promise<CommercialOrder> {
  return await applyCommercialOrderUpdate(opts, false);
}

export async function reviseCommercialOrder(
  opts: CommercialOrderRevisionRequest,
): Promise<CommercialOrder> {
  return await applyCommercialOrderUpdate(opts, true);
}

export async function assignCommercialOrder(
  opts: CommercialOrderAssignRequest,
): Promise<CommercialOrder> {
  return await mutateOrder("order-assigned", opts, async () => ({
    changes: {
      assignee_account_id: opts.assignee_account_id ?? null,
      ...(opts.next_action !== undefined
        ? { next_action: normalizeNextAction(opts.next_action) }
        : {}),
      ...(opts.next_action_due_at !== undefined
        ? { next_action_due_at: opts.next_action_due_at }
        : {}),
    },
  }));
}

export async function addCommercialOrderNote(
  opts: CommercialOrderNoteRequest,
): Promise<CommercialOrder> {
  const note = `${opts.note ?? ""}`.trim();
  if (!note) throw Error("note is required");
  if (note.length > 20_000)
    throw Error("note must be at most 20000 characters");
  return await mutateOrder("note-added", opts, async () => ({
    metadata: { note },
  }));
}

function quoteDetailsFromOrder(order: CommercialOrder): {
  billing_address?: CommercialQuotePreview["billing_address"];
  quote_memo?: string;
} {
  const invoice = order.terms_snapshot.invoice;
  const quote = order.terms_snapshot.quote;
  const invoiceRecord =
    invoice != null && typeof invoice === "object" && !Array.isArray(invoice)
      ? (invoice as Record<string, unknown>)
      : {};
  const quoteRecord =
    quote != null && typeof quote === "object" && !Array.isArray(quote)
      ? (quote as Record<string, unknown>)
      : {};
  const billingAddress = invoiceRecord.billing_address;
  return {
    billing_address:
      billingAddress != null &&
      typeof billingAddress === "object" &&
      !Array.isArray(billingAddress)
        ? (billingAddress as CommercialQuotePreview["billing_address"])
        : undefined,
    quote_memo:
      typeof quoteRecord.memo === "string"
        ? quoteRecord.memo
        : typeof invoiceRecord.memo === "string"
          ? invoiceRecord.memo
          : undefined,
  };
}

export function buildCommercialQuotePreview(
  order: CommercialOrder,
  now = new Date(),
): CommercialQuotePreview {
  const billingContacts = order.contacts.filter(
    ({ role }) => role === "billing",
  );
  const blockers: string[] = [];
  if (["complete", "cancelled"].includes(order.workflow_state)) {
    blockers.push(`the order is ${order.workflow_state}`);
  }
  if (billingContacts.length !== 1) {
    blockers.push("exactly one billing contact is required");
  }
  if (!order.items.length) blockers.push("at least one line item is required");
  if (moneyCompare(order.agreed_total, 0) <= 0) {
    blockers.push("the quote total must be positive");
  }
  const defaultValidUntil = new Date(now);
  defaultValidUntil.setUTCDate(defaultValidUntil.getUTCDate() + 30);
  return {
    order_id: order.id,
    order_number: order.order_number,
    organization_name: order.organization_name,
    billing_contacts: billingContacts,
    items: order.items,
    currency: order.currency,
    subtotal: order.agreed_subtotal,
    total: order.agreed_total,
    service_starts_at: order.service_starts_at,
    service_ends_at: order.service_ends_at,
    po_number: order.po_number,
    customer_reference: order.customer_reference,
    ...quoteDetailsFromOrder(order),
    default_valid_until: defaultValidUntil.toISOString(),
    ready: blockers.length === 0,
    blockers,
  };
}

export async function commercialQuotePreview(
  opts: CommercialQuotePreviewRequest,
): Promise<CommercialQuotePreview> {
  requireReason(opts.reason);
  return buildCommercialQuotePreview(await getCommercialOrder(opts.id));
}

export async function updateCommercialBillingDetails(
  opts: CommercialBillingDetailsUpdateRequest,
): Promise<CommercialOrder> {
  return await mutateOrder(
    "billing-details-updated",
    opts,
    async (client, before) => {
      assertOrderNotTerminal(before, "billing-details update");
      await assertNoUnresolvedProviderOperations(
        client,
        before.id,
        "billing-details update",
      );
      if (
        before.invoices.some(
          ({ status }) => !["void", "failed"].includes(status),
        )
      ) {
        throw Error(
          "billing details are locked after an invoice is created; void it before correcting future invoice recipients",
        );
      }
      assertNoActiveStripeQuote(before, "billing-details update");
      if (!Array.isArray(opts.billing_contacts)) {
        throw Error("billing_contacts is required");
      }
      if (!Array.isArray(opts.procurement_contacts ?? [])) {
        throw Error("procurement_contacts must be an array");
      }
      const billingContacts = normalizeContacts(opts.billing_contacts);
      const procurementContacts = normalizeContacts(
        opts.procurement_contacts ?? [],
      );
      if (
        billingContacts.length !== 1 ||
        billingContacts.some(({ role }) => role !== "billing")
      ) {
        throw Error(
          "exactly one billing contact with role billing is required",
        );
      }
      if (procurementContacts.some(({ role }) => role !== "procurement")) {
        throw Error(
          "procurement_contacts may only contain contacts with role procurement",
        );
      }
      const invoiceBefore = before.terms_snapshot.invoice;
      const invoice =
        invoiceBefore != null &&
        typeof invoiceBefore === "object" &&
        !Array.isArray(invoiceBefore)
          ? { ...(invoiceBefore as Record<string, unknown>) }
          : {};
      if (opts.billing_address !== undefined) {
        if (opts.billing_address == null) delete invoice.billing_address;
        else invoice.billing_address = opts.billing_address;
      }
      if (opts.invoice_memo !== undefined) {
        if (opts.invoice_memo == null || !opts.invoice_memo.trim()) {
          delete invoice.memo;
        } else {
          invoice.memo = opts.invoice_memo.trim();
        }
      }
      const termsSnapshot = {
        ...before.terms_snapshot,
        invoice,
      };
      assertInvoiceTermsSnapshot(termsSnapshot);
      await client.query(
        `DELETE FROM commercial_order_contacts
          WHERE commercial_order_id=$1 AND role IN ('billing','procurement')`,
        [before.id],
      );
      await insertContacts(client, before.id, [
        ...billingContacts,
        ...procurementContacts,
      ]);
      return {
        changes: { terms_snapshot: termsSnapshot },
        metadata: {
          billing_email: billingContacts[0].email_snapshot,
          procurement_contact_count: procurementContacts.length,
        },
      };
    },
  );
}

export async function updateCommercialCollectionMode(
  opts: CommercialCollectionModeUpdateRequest,
): Promise<CommercialOrder> {
  return await mutateOrder(
    "collection-mode-updated",
    opts,
    async (client, before) => {
      assertOrderNotTerminal(before, "collection-mode update");
      await assertNoUnresolvedProviderOperations(
        client,
        before.id,
        "collection-mode update",
      );
      if (!before.approved_at || !before.approved_by_account_id) {
        throw Error(
          "the commercial order must be approved before changing collection mode",
        );
      }
      const allowed = new Set(["stripe_invoice", "manual_invoice"]);
      if (
        !allowed.has(before.collection_mode) ||
        !allowed.has(opts.collection_mode)
      ) {
        throw Error(
          "collection mode may only transition between stripe_invoice and manual_invoice",
        );
      }
      if (before.collection_mode === opts.collection_mode) {
        throw Error(`collection mode is already ${opts.collection_mode}`);
      }
      if (before.collection_state !== "not_invoiced") {
        throw Error(
          "collection mode is locked after invoice collection has started",
        );
      }
      if (before.invoices.length) {
        throw Error("collection mode is locked after any invoice is created");
      }
      if (before.payments.length) {
        throw Error("collection mode is locked after any payment is recorded");
      }
      assertNoActiveStripeQuote(before, "collection-mode update");
      return {
        changes: { collection_mode: opts.collection_mode },
        metadata: {
          previous_collection_mode: before.collection_mode,
          collection_mode: opts.collection_mode,
        },
      };
    },
  );
}

export function quoteValidUntil(
  value: string | undefined,
  fallback: string,
): string {
  const date = new Date(value ?? fallback);
  if (!Number.isFinite(date.valueOf())) {
    throw Error("valid_until must be an ISO-8601 timestamp");
  }
  const now = Date.now();
  if (date.valueOf() <= now) throw Error("valid_until must be in the future");
  const maximum = new Date(now);
  maximum.setUTCFullYear(maximum.getUTCFullYear() + 1);
  if (date > maximum) throw Error("valid_until must be within one year");
  return date.toISOString();
}

export async function issueCommercialQuote(
  opts: CommercialQuoteIssueRequest,
): Promise<CommercialOrder> {
  return await mutateOrder("quote-issued", opts, async (client, before) => {
    assertOrderNotTerminal(before, "quote issuance");
    const preview = buildCommercialQuotePreview(before);
    if (!preview.ready) {
      throw Error(`quote is not ready: ${preview.blockers.join("; ")}`);
    }
    if (!opts.account_id) throw Error("account_id is required");
    const validUntil = quoteValidUntil(
      opts.valid_until,
      preview.default_valid_until,
    );
    const { rows } = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM commercial_quotes WHERE commercial_order_id=$1",
      [before.id],
    );
    const sequence = Number(rows[0]?.count ?? 0) + 1;
    const quoteNumber = `Q-${before.order_number.replace(/^AR-/i, "")}-${`${sequence}`.padStart(2, "0")}`;
    const issuedAt = new Date().toISOString();
    const document = await renderCommercialQuotePdf({
      quote_number: quoteNumber,
      issued_at: issuedAt,
      valid_until: validUntil,
      preview,
    });
    if (!document.length || document.length > 2_097_152) {
      throw Error("generated quote document exceeds the 2 MiB storage limit");
    }
    const id = randomUUID();
    const documentSha256 = createHash("sha256").update(document).digest("hex");
    const documentFilename = `${quoteNumber}.pdf`;
    const snapshot = {
      order_version: before.version,
      order_id: before.id,
      order_number: before.order_number,
      organization_name: before.organization_name,
      billing_contacts: preview.billing_contacts,
      billing_address: preview.billing_address ?? null,
      items: preview.items,
      currency: preview.currency,
      subtotal: preview.subtotal,
      total: preview.total,
      service_starts_at: preview.service_starts_at ?? null,
      service_ends_at: preview.service_ends_at ?? null,
      po_number: preview.po_number ?? null,
      customer_reference: preview.customer_reference ?? null,
      quote_memo: preview.quote_memo ?? null,
    };
    const idempotencyKey = commercialIdempotencyKey(
      "quote-document",
      opts as any,
    );
    await client.query(
      `INSERT INTO commercial_quotes
         (id,commercial_order_id,quote_number,status,provider,currency,subtotal,total,
          issued_at,valid_until,document_filename,document_mime_type,
          document_sha256,document_size,document_data,snapshot,
          created_by_account_id,idempotency_key,created_at,updated_at)
       VALUES ($1,$2,$3,'issued','local',$4,$5,$6,$7,$8,$9,'application/pdf',$10,$11,
               $12,$13,$14,$15,NOW(),NOW())`,
      [
        id,
        before.id,
        quoteNumber,
        before.currency,
        before.agreed_subtotal,
        before.agreed_total,
        issuedAt,
        validUntil,
        documentFilename,
        documentSha256,
        document.length,
        document,
        snapshot,
        opts.account_id,
        idempotencyKey,
      ],
    );
    return {
      metadata: {
        commercial_quote_id: id,
        quote_number: quoteNumber,
        valid_until: validUntil,
        document_filename: documentFilename,
        document_sha256: documentSha256,
        document_size: document.length,
      },
    };
  });
}

function commercialQuoteSnapshot(
  order: CommercialOrder,
  preview: CommercialQuotePreview,
): Record<string, unknown> {
  return {
    order_version: order.version,
    order_id: order.id,
    order_number: order.order_number,
    organization_name: order.organization_name,
    billing_contacts: preview.billing_contacts,
    billing_address: preview.billing_address ?? null,
    items: preview.items,
    currency: preview.currency,
    subtotal: preview.subtotal,
    total: preview.total,
    service_starts_at: preview.service_starts_at ?? null,
    service_ends_at: preview.service_ends_at ?? null,
    payment_terms_days: Math.max(order.payment_terms_days ?? 21, 0),
    po_number: preview.po_number ?? null,
    customer_reference: preview.customer_reference ?? null,
    quote_memo: preview.quote_memo ?? null,
  };
}

export async function createCommercialStripeQuoteIntent(
  opts: CommercialStripeQuoteCreateRequest,
): Promise<{ order: CommercialOrder; quote: CommercialQuote }> {
  const reason = requireReason(opts.reason);
  if (!opts.account_id) throw Error("account_id is required");
  const idempotencyKey = commercialIdempotencyKey(
    "stripe-quote-create",
    opts as any,
  );
  return await withTransaction(async (client) => {
    const orderId = await resolveOrderId(client, opts.id);
    const order = await loadOrder(client, orderId, true);
    const existing = await client.query(
      "SELECT * FROM commercial_quotes WHERE idempotency_key=$1",
      [idempotencyKey],
    );
    if (existing.rows[0]) {
      const quote = normalizeQuoteRow(existing.rows[0]);
      if (
        quote.commercial_order_id !== order.id ||
        quote.provider !== "stripe" ||
        quote.currency !== order.currency ||
        moneyCompare(quote.subtotal, order.agreed_subtotal) !== 0 ||
        moneyCompare(quote.total, order.agreed_total) !== 0
      ) {
        throw Error(
          "quote idempotency key was already used for different quote input",
        );
      }
      return { order, quote };
    }
    requireExpectedVersion(order.version, opts.expected_version);
    assertOrderNotTerminal(order, "Stripe quote creation");
    await assertNoUnresolvedProviderOperations(
      client,
      order.id,
      "Stripe quote creation",
    );
    const preview = buildCommercialQuotePreview(order);
    if (!preview.ready) {
      throw Error(`quote is not ready: ${preview.blockers.join("; ")}`);
    }
    const active = order.quotes.find(
      ({ provider, status }) =>
        provider === "stripe" && ["draft", "issued"].includes(status),
    );
    if (active) {
      throw Error(
        `the order already has an active Stripe quote ${active.quote_number}`,
      );
    }
    const validUntil = quoteValidUntil(
      opts.valid_until,
      preview.default_valid_until,
    );
    const count = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM commercial_quotes WHERE commercial_order_id=$1",
      [order.id],
    );
    const sequence = Number(count.rows[0]?.count ?? 0) + 1;
    const quoteNumber = `Q-${order.order_number.replace(/^AR-/i, "")}-${`${sequence}`.padStart(2, "0")}`;
    const quoteId = randomUUID();
    const inserted = await client.query(
      `INSERT INTO commercial_quotes
         (id,commercial_order_id,quote_number,status,provider,currency,
          subtotal,total,valid_until,snapshot,provider_snapshot,
          created_by_account_id,idempotency_key,created_at,updated_at)
       VALUES ($1,$2,$3,'draft','stripe',$4,$5,$6,$7,$8,'{}',$9,$10,NOW(),NOW())
       RETURNING *`,
      [
        quoteId,
        order.id,
        quoteNumber,
        order.currency,
        order.agreed_subtotal,
        order.agreed_total,
        validUntil,
        commercialQuoteSnapshot(order, preview),
        opts.account_id,
        idempotencyKey,
      ],
    );
    await client.query(
      "UPDATE commercial_orders SET updated_at=NOW(),version=version+1 WHERE id=$1",
      [order.id],
    );
    const after = await loadOrder(client, order.id);
    await insertEvent(client, {
      commercial_order_id: order.id,
      event_type: "stripe-quote-creation-started",
      actor_account_id: opts.account_id,
      source: opts.source ?? "cli",
      reason,
      idempotency_key: `${idempotencyKey}:intent`,
      before: order as any,
      after: after as any,
      metadata: {
        commercial_quote_id: quoteId,
        quote_number: quoteNumber,
        valid_until: validUntil,
      },
      identity_payload: {
        commercial_order_id: order.id,
        commercial_quote_id: quoteId,
      },
    });
    return {
      order: after,
      quote: normalizeQuoteRow(inserted.rows[0]),
    };
  });
}

export async function getCommercialQuote(
  orderId: string,
  quoteId?: string,
): Promise<CommercialQuote> {
  const order = await getCommercialOrder(orderId);
  const quote = quoteId
    ? order.quotes.find(({ id }) => id === quoteId)
    : order.quotes[0];
  if (!quote) throw Error("commercial order has no quote");
  return quote;
}

export interface CommercialQuoteProviderUpdate {
  quote_id: string;
  status: CommercialQuote["status"];
  provider_quote_id: string;
  provider_status: NonNullable<CommercialQuote["provider_status"]>;
  provider_invoice_id?: string | null;
  provider_snapshot: Record<string, unknown>;
  issued_at?: string | null;
  document_filename?: string | null;
  document_sha256?: string | null;
  document_data?: Buffer | null;
  actor_account_id?: string | null;
  event_type: string;
  event_source: CommercialEventSource;
  event_reason: string;
  event_idempotency_key: string;
  skip_if_unchanged?: boolean;
}

function assertQuoteProviderDocument(
  opts: CommercialQuoteProviderUpdate,
): void {
  if (!["issued", "accepted"].includes(opts.status)) return;
  const document = opts.document_data;
  if (document == null) return;
  if (!document?.length || document.length > 2_097_152) {
    throw Error("Stripe quote PDF must be between 1 byte and 2 MiB");
  }
  if (!document.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw Error("Stripe quote document is not a PDF");
  }
  const digest = createHash("sha256").update(document).digest("hex");
  if (!opts.document_sha256 || digest !== opts.document_sha256) {
    throw Error("Stripe quote PDF digest does not match its document");
  }
  if (!opts.document_filename?.trim() || !opts.issued_at) {
    throw Error("an issued Stripe quote requires document metadata");
  }
}

export async function updateCommercialQuoteProvider(
  opts: CommercialQuoteProviderUpdate,
): Promise<CommercialOrder> {
  assertQuoteProviderDocument(opts);
  return await withTransaction(async (client) => {
    const quoteResult = await client.query(
      "SELECT * FROM commercial_quotes WHERE id=$1 FOR UPDATE",
      [opts.quote_id],
    );
    if (!quoteResult.rows[0]) throw Error("commercial quote not found");
    const quote = normalizeQuoteRow(quoteResult.rows[0]);
    if (quote.provider !== "stripe") {
      throw Error("provider updates require a Stripe quote");
    }
    if (
      ["issued", "accepted"].includes(opts.status) &&
      !quoteResult.rows[0].document_data &&
      !opts.document_data
    ) {
      throw Error("an issued Stripe quote requires its retained PDF");
    }
    if (
      quote.provider_quote_id &&
      quote.provider_quote_id !== opts.provider_quote_id
    ) {
      throw Error("Stripe quote identity conflicts with the local quote");
    }
    const before = await loadOrder(client, quote.commercial_order_id, true);
    const identityPayload = {
      quote_id: quote.id,
      provider_quote_id: opts.provider_quote_id,
      event_type: opts.event_type,
    };
    const replay = await replayOrderId(client, opts.event_idempotency_key, {
      action: opts.event_type,
      order_id: before.id,
      payload: identityPayload,
    });
    if (replay) return await loadOrder(client, replay);
    const unchanged =
      quote.status === opts.status &&
      quote.provider_quote_id === opts.provider_quote_id &&
      quote.provider_status === opts.provider_status &&
      (quote.provider_invoice_id ?? null) ===
        (opts.provider_invoice_id ?? quote.provider_invoice_id ?? null) &&
      stableJson(quote.provider_snapshot) ===
        stableJson(opts.provider_snapshot) &&
      (!opts.document_sha256 || quote.document_sha256 === opts.document_sha256);
    if (opts.skip_if_unchanged && unchanged) {
      await client.query(
        "UPDATE commercial_quotes SET last_reconciled_at=NOW() WHERE id=$1",
        [quote.id],
      );
      return before;
    }
    const voided = opts.status === "void";
    await client.query(
      `UPDATE commercial_quotes SET
         status=$2,provider_quote_id=$3,provider_status=$4,
         provider_invoice_id=COALESCE($5,provider_invoice_id),
         provider_snapshot=$6,provider_updated_at=NOW(),last_reconciled_at=NOW(),
         issued_at=COALESCE($7,issued_at),
         document_filename=COALESCE($8,document_filename),
         document_mime_type=CASE WHEN $9::bytea IS NULL THEN document_mime_type
           ELSE 'application/pdf' END,
         document_sha256=COALESCE($10,document_sha256),
         document_size=CASE WHEN $9::bytea IS NULL THEN document_size
           ELSE octet_length($9::bytea) END,
         document_data=COALESCE($9,document_data),
         voided_at=CASE WHEN $11 THEN COALESCE(voided_at,NOW()) ELSE voided_at END,
         voided_by_account_id=CASE WHEN $11 THEN
           COALESCE($12,voided_by_account_id,created_by_account_id)
           ELSE voided_by_account_id END,
         updated_at=NOW() WHERE id=$1`,
      [
        quote.id,
        opts.status,
        opts.provider_quote_id,
        opts.provider_status,
        opts.provider_invoice_id ?? null,
        opts.provider_snapshot,
        opts.issued_at ?? null,
        opts.document_filename ?? null,
        opts.document_data ?? null,
        opts.document_sha256 ?? null,
        voided,
        opts.actor_account_id ?? null,
      ],
    );
    await client.query(
      "UPDATE commercial_orders SET updated_at=NOW(),version=version+1 WHERE id=$1",
      [before.id],
    );
    const after = await loadOrder(client, before.id);
    await insertEvent(client, {
      commercial_order_id: before.id,
      event_type: opts.event_type,
      actor_account_id: opts.actor_account_id,
      source: opts.event_source,
      reason: opts.event_reason,
      idempotency_key: opts.event_idempotency_key,
      before: before as any,
      after: after as any,
      metadata: {
        commercial_quote_id: quote.id,
        provider_quote_id: opts.provider_quote_id,
        provider_invoice_id: opts.provider_invoice_id ?? null,
        provider_status: opts.provider_status,
      },
      identity_payload: identityPayload,
    });
    return after;
  });
}

export async function voidCommercialQuote(
  opts: CommercialQuoteVoidRequest,
): Promise<CommercialOrder> {
  return await mutateOrder("quote-voided", opts, async (client, before) => {
    if (!opts.account_id) throw Error("account_id is required");
    const { rows } = await client.query<{
      id: string;
      quote_number: string;
      status: string;
      provider: CommercialQuote["provider"];
    }>(
      `SELECT id,quote_number,status,provider FROM commercial_quotes
        WHERE id=$1 AND commercial_order_id=$2 FOR UPDATE`,
      [opts.commercial_quote_id, before.id],
    );
    const quote = rows[0];
    if (!quote) throw Error("commercial quote not found for this order");
    if (quote.provider !== "local") {
      throw Error(
        "Stripe quotes must be canceled through the Stripe quote action",
      );
    }
    if (quote.status === "void")
      throw Error("commercial quote is already void");
    await client.query(
      `UPDATE commercial_quotes SET status='void',voided_at=NOW(),
              voided_by_account_id=$2,updated_at=NOW() WHERE id=$1`,
      [quote.id, opts.account_id],
    );
    return {
      metadata: {
        commercial_quote_id: quote.id,
        quote_number: quote.quote_number,
      },
    };
  });
}

export async function issueCommercialQuoteLink(
  opts: CommercialQuoteLinkRequest,
): Promise<CommercialQuoteLinkResult> {
  assertSeedAuthority();
  let token: string | undefined;
  const order = await mutateOrder(
    "quote-link-issued",
    opts,
    async (client, before) => {
      const quote = before.quotes.find(
        (q) => q.id === opts.commercial_quote_id,
      );
      const expires = new Date(opts.expires_at).getTime();
      if (
        !quote ||
        !["issued", "accepted"].includes(quote.status) ||
        !quote.document_sha256
      ) {
        throw Error(
          "only retained issued or accepted quote PDFs can be shared",
        );
      }
      if (
        !Number.isFinite(expires) ||
        expires <= Date.now() ||
        expires > Date.now() + 90 * 86_400_000 ||
        expires > new Date(quote.valid_until).getTime()
      ) {
        throw Error(
          "link expiration must be in the future, within 90 days and no later than quote expiration",
        );
      }
      token = randomBytes(32).toString("hex");
      await client.query(
        `UPDATE commercial_quotes SET download_token_hash=$2, download_expires_at=$3,
       download_window_at=NULL, download_window_count=0 WHERE id=$1`,
        [
          quote.id,
          createHash("sha256").update(token).digest("hex"),
          new Date(expires),
        ],
      );
      return {
        metadata: {
          commercial_quote_id: quote.id,
          expires_at: new Date(expires).toISOString(),
        },
      };
    },
  );
  return { order, path: token ? `/commercial/quotes/download#${token}` : null };
}

export async function revokeCommercialQuoteLink(
  opts: CommercialQuoteVoidRequest,
): Promise<CommercialOrder> {
  assertSeedAuthority();
  return await mutateOrder(
    "quote-link-revoked",
    opts,
    async (client, before) => {
      if (!before.quotes.some((q) => q.id === opts.commercial_quote_id)) {
        throw Error("commercial quote not found for this order");
      }
      await client.query(
        "UPDATE commercial_quotes SET download_token_hash=NULL, download_expires_at=NULL WHERE id=$1",
        [opts.commercial_quote_id],
      );
      return { metadata: { commercial_quote_id: opts.commercial_quote_id } };
    },
  );
}

export async function getCommercialQuoteDocument(
  opts: CommercialQuoteDocumentRequest,
): Promise<CommercialQuoteDocument> {
  assertSeedAuthority();
  requireReason(opts.reason);
  const orderId = await resolveOrderId(getPool(), opts.id);
  const { rows } = await getPool().query<any>(
    `SELECT * FROM commercial_quotes
      WHERE id=$1 AND commercial_order_id=$2`,
    [opts.commercial_quote_id, orderId],
  );
  const row = rows[0];
  if (!row) throw Error("commercial quote not found for this order");
  if (!Buffer.isBuffer(row.document_data)) {
    throw Error("commercial quote document is not available");
  }
  if (row.document_data.length > 2_097_152) {
    throw Error("commercial quote document exceeds the download limit");
  }
  const sha256 = createHash("sha256").update(row.document_data).digest("hex");
  if (sha256 !== row.document_sha256) {
    throw Error("commercial quote document failed its integrity check");
  }
  return {
    quote: normalizeQuoteRow(row),
    content_base64: row.document_data.toString("base64"),
  };
}

function normalizeCommercialOrderDocumentUpload(
  opts: CommercialOrderDocumentUploadRequest,
): {
  document: Buffer;
  filename: string;
  reference: string | null;
  note: string | null;
} {
  if (opts.document_kind !== "purchase_order") {
    throw Error("document_kind must be purchase_order");
  }
  const filename = `${opts.document_filename ?? ""}`.trim();
  if (
    !filename ||
    filename.length > 255 ||
    filename.includes("/") ||
    filename.includes("\\") ||
    !filename.toLowerCase().endsWith(".pdf")
  ) {
    throw Error("document_filename must be a plain PDF filename");
  }
  const encoded = `${opts.content_base64 ?? ""}`.trim();
  const maximumEncodedLength =
    Math.ceil(COMMERCIAL_ORDER_DOCUMENT_MAX_BYTES / 3) * 4;
  if (
    !encoded ||
    encoded.length > maximumEncodedLength ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  ) {
    throw Error("purchase order content must be canonical base64");
  }
  const document = Buffer.from(encoded, "base64");
  if (document.toString("base64") !== encoded) {
    throw Error("purchase order content is not valid base64");
  }
  if (
    !document.length ||
    document.length > COMMERCIAL_ORDER_DOCUMENT_MAX_BYTES
  ) {
    throw Error("purchase order PDF must be between 1 byte and 5 MiB");
  }
  if (document.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw Error("purchase order document is not a PDF");
  }
  const reference = `${opts.document_reference ?? ""}`.trim() || null;
  if (reference && reference.length > 240) {
    throw Error("document_reference must be at most 240 characters");
  }
  const note = `${opts.note ?? ""}`.trim() || null;
  if (note && note.length > 2_000) {
    throw Error("document note must be at most 2000 characters");
  }
  return { document, filename, reference, note };
}

export async function uploadCommercialOrderDocument(
  opts: CommercialOrderDocumentUploadRequest,
): Promise<CommercialOrder> {
  const { document, filename, reference, note } =
    normalizeCommercialOrderDocumentUpload(opts);
  const documentSha256 = createHash("sha256").update(document).digest("hex");
  const rowIdempotencyKey = commercialIdempotencyKey(
    "document-uploaded",
    opts as any,
  );
  return await mutateOrder(
    "document-uploaded",
    opts,
    async (client, before) => {
      if (!opts.account_id) throw Error("account_id is required");
      const existingReference = `${before.po_number ?? ""}`.trim();
      if (reference && existingReference && reference !== existingReference) {
        throw Error(
          `purchase order reference conflicts with existing PO number ${existingReference}`,
        );
      }
      const duplicate = await client.query<{ id: string }>(
        `SELECT id FROM commercial_order_documents
        WHERE commercial_order_id=$1 AND document_kind=$2
          AND document_sha256=$3 AND status='active' LIMIT 1`,
        [before.id, opts.document_kind, documentSha256],
      );
      if (duplicate.rows[0]) {
        throw Error("this purchase order PDF is already attached to the order");
      }
      const documentId = randomUUID();
      await client.query(
        `INSERT INTO commercial_order_documents
         (id,commercial_order_id,document_kind,status,document_reference,note,
          document_filename,document_mime_type,document_sha256,document_size,
          document_data,created_by_account_id,idempotency_key,created_at,updated_at)
       VALUES ($1,$2,$3,'active',$4,$5,$6,'application/pdf',$7,$8,$9,$10,$11,NOW(),NOW())`,
        [
          documentId,
          before.id,
          opts.document_kind,
          reference,
          note,
          filename,
          documentSha256,
          document.length,
          document,
          opts.account_id,
          rowIdempotencyKey,
        ],
      );
      return {
        changes:
          reference && !existingReference
            ? { po_number: reference }
            : undefined,
        metadata: {
          commercial_order_document_id: documentId,
          document_kind: opts.document_kind,
          document_reference: reference,
          document_filename: filename,
          document_sha256: documentSha256,
          document_size: document.length,
        },
      };
    },
  );
}

export async function voidCommercialOrderDocument(
  opts: CommercialOrderDocumentVoidRequest,
): Promise<CommercialOrder> {
  return await mutateOrder("document-voided", opts, async (client, before) => {
    if (!opts.account_id) throw Error("account_id is required");
    const { rows } = await client.query<{
      id: string;
      document_kind: string;
      document_filename: string;
      status: string;
    }>(
      `SELECT id,document_kind,document_filename,status
         FROM commercial_order_documents
        WHERE id=$1 AND commercial_order_id=$2 FOR UPDATE`,
      [opts.commercial_order_document_id, before.id],
    );
    const document = rows[0];
    if (!document) throw Error("commercial order document not found");
    if (document.status === "void") {
      throw Error("commercial order document is already void");
    }
    await client.query(
      `UPDATE commercial_order_documents SET status='void',voided_at=NOW(),
              voided_by_account_id=$2,updated_at=NOW() WHERE id=$1`,
      [document.id, opts.account_id],
    );
    return {
      metadata: {
        commercial_order_document_id: document.id,
        document_kind: document.document_kind,
        document_filename: document.document_filename,
      },
    };
  });
}

export async function getCommercialOrderDocument(
  opts: CommercialOrderDocumentDownloadRequest,
): Promise<CommercialOrderDocumentDownload> {
  assertSeedAuthority();
  requireReason(opts.reason);
  const orderId = await resolveOrderId(getPool(), opts.id);
  const { rows } = await getPool().query<any>(
    `SELECT * FROM commercial_order_documents
      WHERE id=$1 AND commercial_order_id=$2`,
    [opts.commercial_order_document_id, orderId],
  );
  const row = rows[0];
  if (!row) throw Error("commercial order document not found");
  if (!Buffer.isBuffer(row.document_data)) {
    throw Error("commercial order document is not available");
  }
  if (row.document_data.length > COMMERCIAL_ORDER_DOCUMENT_MAX_BYTES) {
    throw Error("commercial order document exceeds the download limit");
  }
  const sha256 = createHash("sha256").update(row.document_data).digest("hex");
  if (sha256 !== row.document_sha256) {
    throw Error("commercial order document failed its integrity check");
  }
  return {
    document: normalizeOrderDocumentRow(row),
    content_base64: row.document_data.toString("base64"),
  };
}

export async function approveCommercialOrder(
  opts: CommercialOrderTransitionRequest,
): Promise<CommercialOrder> {
  return await mutateOrder("order-approved", opts, async (_client, before) => {
    const billingContacts = before.contacts.filter(
      ({ role }) => role === "billing",
    );
    assertInvoiceTermsSnapshot(before.terms_snapshot);
    if (billingContacts.length !== 1) {
      throw Error(
        "exactly one billing contact is required as the invoice recipient before approval",
      );
    }
    if (!before.items.length || moneyCompare(before.agreed_total, 0) <= 0) {
      throw Error("positive reviewed line items are required before approval");
    }
    const complimentary = before.collection_mode === "complimentary";
    const fulfillmentRequired =
      before.terms_snapshot.fulfillment_required !== false;
    const complete = complimentary && !fulfillmentRequired;
    const workflowState = complete ? "complete" : "ready_to_invoice";
    assertWorkflowTransition(before.workflow_state, workflowState);
    const nextAction = complete
      ? "Complete"
      : complimentary
        ? "Provision service"
        : "Create invoice";
    return {
      changes: {
        workflow_state: workflowState,
        collection_state: complimentary ? "waived" : "not_invoiced",
        approved_at: new Date(),
        approved_by_account_id: opts.account_id,
        completed_at: complete ? new Date() : null,
        next_action: nextAction,
        next_action_due_at: complete ? null : before.next_action_due_at,
      },
    };
  });
}

export async function cancelCommercialOrder(
  opts: CommercialOrderTransitionRequest,
): Promise<CommercialOrder> {
  return await mutateOrder("order-cancelled", opts, async (client, before) => {
    await assertNoUnresolvedProviderOperations(
      client,
      before.id,
      "cancellation",
    );
    assertWorkflowTransition(before.workflow_state, "cancelled");
    if (
      before.invoices.some(({ status }) =>
        ["creating", "draft", "open"].includes(status),
      )
    ) {
      throw Error("void the active invoice before cancelling the order");
    }
    if (before.fulfillment_state === "provisioned") {
      throw Error("end active fulfillment before cancelling the order");
    }
    if (
      before.payments.some(({ status }) => status === "succeeded") ||
      ["paid", "partially_paid"].includes(before.collection_state)
    ) {
      throw Error(
        "resolve collected funds with a documented refund, credit, or write-off before cancelling the order",
      );
    }
    return {
      changes: {
        workflow_state: "cancelled",
        cancelled_at: new Date(),
        next_action: "Cancelled",
        next_action_due_at: null,
      },
    };
  });
}

function requireTimestamp(value: string, label: string): Date {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw Error(`${label} must be a valid timestamp`);
  }
  return timestamp;
}

export async function issueManualCommercialInvoice(
  opts: CommercialManualInvoiceIssueRequest,
): Promise<CommercialOrder> {
  const invoiceReference = `${opts.invoice_reference ?? ""}`.trim();
  if (!invoiceReference) throw Error("invoice_reference is required");
  if (invoiceReference.length > 240) {
    throw Error("invoice_reference must be at most 240 characters");
  }
  const issuedAt = opts.issued_at
    ? requireTimestamp(opts.issued_at, "issued_at")
    : new Date();
  let documentUrl: string | null = null;
  if (opts.document_url) {
    const parsed = new URL(opts.document_url);
    if (parsed.protocol !== "https:") {
      throw Error("document_url must use HTTPS");
    }
    documentUrl = parsed.toString();
  }
  return await mutateOrder(
    "manual-invoice-issued",
    opts,
    async (client, before) => {
      assertOrderNotTerminal(before, "manual invoice issuance");
      if (!before.approved_at || !before.approved_by_account_id) {
        throw Error("the commercial order must be approved before invoicing");
      }
      if (before.collection_mode !== "manual_invoice") {
        throw Error("the order collection mode is not manual_invoice");
      }
      if (
        before.invoices.some(({ status }) =>
          ["creating", "draft", "open"].includes(status),
        )
      ) {
        throw Error("the commercial order already has an active invoice");
      }
      const dueAt = opts.due_at
        ? requireTimestamp(opts.due_at, "due_at")
        : new Date(
            issuedAt.getTime() +
              Math.max(before.payment_terms_days ?? 21, 0) * 86_400_000,
          );
      const invoiceId = randomUUID();
      const invoiceKey = commercialIdempotencyKey(
        "manual-invoice-row",
        opts as any,
      );
      await client.query(
        `INSERT INTO commercial_invoices
          (id,commercial_order_id,provider,status,currency,subtotal,tax,total,
           amount_due,amount_paid,due_at,hosted_invoice_url,sent_at,
           idempotency_key,provider_snapshot,created_at,updated_at)
         VALUES ($1,$2,'manual','open',$3,$4,0,$5,$5,0,$6,$7,$8,$9,$10,NOW(),NOW())`,
        [
          invoiceId,
          before.id,
          before.currency,
          before.agreed_subtotal,
          before.agreed_total,
          dueAt,
          documentUrl,
          issuedAt,
          invoiceKey,
          {
            invoice_reference: invoiceReference,
            evidence_reference:
              `${opts.evidence_reference ?? ""}`.trim() || null,
          },
        ],
      );
      const overdue = dueAt.getTime() < Date.now();
      return {
        changes: {
          collection_state: overdue ? "overdue" : "open",
          workflow_state: "awaiting_payment",
          next_action: overdue
            ? "Follow up on overdue payment"
            : "Collect payment",
          next_action_due_at: dueAt,
        },
        metadata: {
          commercial_invoice_id: invoiceId,
          invoice_reference: invoiceReference,
          due_at: dueAt.toISOString(),
          issued_at: issuedAt.toISOString(),
          document_url: documentUrl,
        },
      };
    },
  );
}

export async function voidManualCommercialInvoice(
  opts: CommercialInvoiceMutationRequest,
): Promise<CommercialOrder> {
  return await mutateOrder(
    "manual-invoice-voided",
    opts,
    async (client, before) => {
      assertOrderNotTerminal(before, "manual invoice void");
      const invoice = opts.commercial_invoice_id
        ? before.invoices.find(({ id }) => id === opts.commercial_invoice_id)
        : before.invoices.find(
            ({ provider, status }) =>
              provider === "manual" && ["draft", "open"].includes(status),
          );
      if (!invoice) throw Error("manual invoice was not found on this order");
      if (invoice.provider !== "manual") {
        throw Error("the selected invoice is not a manual invoice");
      }
      if (!["draft", "open"].includes(invoice.status)) {
        throw Error(`manual invoice cannot be voided from ${invoice.status}`);
      }
      if (
        moneyCompare(invoice.amount_paid, 0) > 0 ||
        before.payments.some(
          ({ commercial_invoice_id, status }) =>
            commercial_invoice_id === invoice.id && status === "succeeded",
        )
      ) {
        throw Error(
          "resolve collected funds before voiding this manual invoice",
        );
      }
      await client.query(
        `UPDATE commercial_invoices SET status='void',amount_due=0,
           voided_at=NOW(),updated_at=NOW() WHERE id=$1`,
        [invoice.id],
      );
      return {
        changes: {
          collection_state: "void",
          workflow_state: "ready_to_invoice",
          next_action: "Resolve exception",
        },
        metadata: {
          commercial_invoice_id: invoice.id,
          invoice_reference:
            invoice.provider_snapshot?.invoice_reference ?? null,
        },
      };
    },
  );
}

export async function recordManualCommercialPayment(
  opts: CommercialManualPaymentRequest,
): Promise<CommercialOrder> {
  assertProviderMutationEnums({ source: opts.source, method: opts.method });
  const amount = normalizePositiveMoney(opts.amount, "payment amount");
  const currency = normalizeCurrency(opts.currency);
  const reference = `${opts.evidence_reference ?? ""}`.trim();
  if (!reference) throw Error("a non-sensitive evidence reference is required");
  return await mutateOrder(
    "manual-payment-recorded",
    opts,
    async (client, before) => {
      assertOrderNotTerminal(before, "manual payment recording");
      if (!before.approved_at || !before.approved_by_account_id) {
        throw Error("the commercial order must be approved before payment");
      }
      if (before.collection_mode === "complimentary") {
        throw Error("a complimentary order cannot accept payment");
      }
      if (currency !== before.currency)
        throw Error("payment currency does not match the order");
      const alreadyPaid = before.payments
        .filter(({ status }) => status === "succeeded")
        .reduce(
          (total, payment) => moneyAdd(total, payment.amount),
          toDecimal(0),
        );
      const remaining = moneySubtract(before.agreed_total, alreadyPaid);
      if (moneyCompare(amount, remaining) > 0) {
        throw Error(
          `payment exceeds remaining order balance ${moneyToDbString(remaining)}`,
        );
      }
      const paymentKey = commercialIdempotencyKey(
        "manual-payment-row",
        opts as any,
      );
      const invoice = opts.commercial_invoice_id
        ? before.invoices.find(({ id }) => id === opts.commercial_invoice_id)
        : before.invoices[0];
      if (opts.commercial_invoice_id && !invoice) {
        throw Error("commercial invoice does not belong to the order");
      }
      const snapshotPaymentIds = Array.isArray(
        invoice?.provider_snapshot?.payment_ids,
      )
        ? invoice.provider_snapshot.payment_ids.filter(
            (id): id is string => typeof id === "string" && !!id.trim(),
          )
        : [];
      const unlinkedSnapshotIds = snapshotPaymentIds.filter(
        (id) =>
          !before.payments.some(
            (payment) => payment.provider_payment_id === id,
          ),
      );
      const providerPaymentId =
        `${opts.provider_payment_id ?? ""}`.trim() ||
        (unlinkedSnapshotIds.length === 1 ? unlinkedSnapshotIds[0] : null);
      if (providerPaymentId) {
        const linked = await client.query<{
          commercial_order_id: string;
          commercial_invoice_id?: string | null;
        }>(
          `SELECT commercial_order_id,commercial_invoice_id
             FROM commercial_payments WHERE provider_payment_id=$1`,
          [providerPaymentId],
        );
        if (linked.rows[0]) {
          throw Error("provider_payment_id is already linked to a payment");
        }
      }
      await client.query(
        `INSERT INTO commercial_payments
         (id,commercial_order_id,commercial_invoice_id,provider,
          provider_payment_id,amount,currency,status,received_at,method,
          recorded_by_account_id,evidence_reference,idempotency_key,
          created_at,updated_at)
       VALUES ($1,$2,$3,'manual',$4,$5,$6,'succeeded',$7,$8,$9,$10,$11,NOW(),NOW())`,
        [
          randomUUID(),
          before.id,
          invoice?.id ?? null,
          providerPaymentId,
          amount,
          currency,
          opts.received_at ?? new Date(),
          opts.method,
          opts.account_id,
          reference,
          paymentKey,
        ],
      );
      const paid = moneyAdd(alreadyPaid, amount);
      const collectionState: CommercialCollectionState =
        moneyCompare(paid, before.agreed_total) >= 0
          ? "paid"
          : "partially_paid";
      if (invoice) {
        await client.query(
          `UPDATE commercial_invoices SET amount_paid=$2,
           amount_due=GREATEST(total-$2,0),
           status=CASE WHEN total <= $2 THEN 'paid' ELSE status END,
           paid_at=CASE WHEN total <= $2 THEN NOW() ELSE paid_at END,
           updated_at=NOW() WHERE id=$1`,
          [invoice.id, paid.toString()],
        );
      }
      const provisional = { ...before, collection_state: collectionState };
      const complete =
        collectionSatisfied(provisional) && fulfillmentSatisfied(provisional);
      const nextAction = complete
        ? "Complete"
        : before.fulfillment_state === "not_provisioned" &&
            collectionState === "paid"
          ? "Provision service"
          : "Collect payment";
      return {
        changes: {
          collection_state: collectionState,
          workflow_state: complete ? "complete" : "awaiting_payment",
          completed_at: complete ? new Date() : null,
          next_action: nextAction,
          next_action_due_at: complete ? null : before.next_action_due_at,
        },
        metadata: {
          amount,
          currency,
          method: opts.method,
          evidence_reference: reference,
          provider_payment_id: providerPaymentId,
        },
      };
    },
  );
}

export async function setCommercialFulfillment(
  opts: CommercialMutationRequest & {
    id: string;
    fulfillment_state: CommercialFulfillmentState;
    site_license_id?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<CommercialOrder> {
  const eventType =
    opts.fulfillment_state === "ended"
      ? "fulfillment-ended"
      : "fulfillment-provisioned";
  return await mutateOrder(eventType, opts, async (_client, before) => {
    if (before.workflow_state === "cancelled") {
      throw Error("fulfillment is not allowed on a cancelled order");
    }
    if (!before.approved_at || !before.approved_by_account_id) {
      throw Error("the commercial order must be approved before fulfillment");
    }
    if (!["provisioned", "ended"].includes(opts.fulfillment_state)) {
      throw Error("fulfillment_state must be provisioned or ended");
    }
    if (
      opts.fulfillment_state === "ended" &&
      before.fulfillment_state !== "provisioned"
    ) {
      throw Error("fulfillment cannot end before it has been provisioned");
    }
    if (
      before.fulfillment_state === "ended" &&
      opts.fulfillment_state !== "ended"
    ) {
      throw Error("ended fulfillment cannot be reopened");
    }
    const provisional = {
      ...before,
      fulfillment_state: opts.fulfillment_state,
      site_license_id: opts.site_license_id ?? before.site_license_id,
    };
    const complete = shouldComplete(provisional);
    const nextAction = complete
      ? "Complete"
      : opts.fulfillment_state === "ended"
        ? "Resolve exception"
        : opts.fulfillment_state === "provisioned" &&
            ["open", "overdue", "partially_paid"].includes(
              before.collection_state,
            )
          ? "Collect payment"
          : before.next_action;
    return {
      changes: {
        fulfillment_state: opts.fulfillment_state,
        site_license_id: opts.site_license_id ?? before.site_license_id,
        provisioned_at:
          opts.fulfillment_state === "provisioned"
            ? new Date()
            : before.provisioned_at,
        workflow_state: complete ? "complete" : before.workflow_state,
        completed_at: complete ? new Date() : before.completed_at,
        next_action: nextAction,
        next_action_due_at: complete ? null : before.next_action_due_at,
      },
      metadata: opts.metadata,
    };
  });
}

export async function createCommercialInvoiceIntent(opts: {
  order_id: string;
  actor_account_id: string;
  expected_version: number;
  reason: string;
  idempotency_key: string;
  due_at: string;
}): Promise<{ order: CommercialOrder; invoice: CommercialInvoice }> {
  return await withTransaction(async (client) => {
    const order = await loadOrder(client, opts.order_id, true);
    const existing = await client.query(
      "SELECT * FROM commercial_invoices WHERE idempotency_key=$1",
      [opts.idempotency_key],
    );
    if (existing.rows[0]) {
      const invoice = normalizeInvoiceRow(existing.rows[0]);
      if (
        invoice.commercial_order_id !== order.id ||
        invoice.currency !== order.currency ||
        moneyCompare(invoice.total, order.agreed_total) !== 0 ||
        iso(invoice.due_at) !== iso(opts.due_at)
      ) {
        throw Error(
          "invoice idempotency key was already used for different invoice input",
        );
      }
      return { order, invoice };
    }
    requireExpectedVersion(order.version, opts.expected_version);
    assertOrderNotTerminal(order, "invoice creation");
    if (!order.approved_at || !order.approved_by_account_id) {
      throw Error("the commercial order must be approved before invoicing");
    }
    const id = randomUUID();
    const { rows } = await client.query(
      `INSERT INTO commercial_invoices
         (id,commercial_order_id,provider,status,currency,subtotal,tax,total,
          amount_due,amount_paid,due_at,idempotency_key,provider_snapshot,
          created_at,updated_at)
       VALUES ($1,$2,'stripe','creating',$3,$4,0,$5,$5,0,$6,$7,'{}',NOW(),NOW())
       RETURNING *`,
      [
        id,
        order.id,
        order.currency,
        order.agreed_subtotal,
        order.agreed_total,
        opts.due_at,
        opts.idempotency_key,
      ],
    );
    await client.query(
      "UPDATE commercial_orders SET collection_state='draft_invoice',updated_at=NOW(),version=version+1 WHERE id=$1",
      [order.id],
    );
    await insertEvent(client, {
      commercial_order_id: order.id,
      event_type: "invoice-creation-started",
      actor_account_id: opts.actor_account_id,
      source: "cli",
      reason: opts.reason,
      idempotency_key: `${opts.idempotency_key}:intent`,
      before: order as any,
      metadata: { commercial_invoice_id: id },
      identity_payload: opts,
    });
    return {
      order: await loadOrder(client, order.id),
      invoice: normalizeInvoiceRow(rows[0]),
    };
  });
}

interface CommercialInvoiceProviderUpdate {
  invoice_id: string;
  status: CommercialInvoice["status"];
  provider_customer_id?: string | null;
  provider_invoice_id?: string | null;
  provider_payment_intent_id?: string | null;
  subtotal: string;
  tax: string;
  total: string;
  amount_due: string;
  amount_paid: string;
  due_at?: string | null;
  hosted_invoice_url?: string | null;
  invoice_pdf_url?: string | null;
  sent_at?: string | null;
  paid_at?: string | null;
  voided_at?: string | null;
  provider_snapshot: Record<string, unknown>;
  collection_state: CommercialCollectionState;
  event_type: string;
  event_source: CommercialEventSource;
  event_reason: string;
  event_idempotency_key: string;
  actor_account_id?: string | null;
  error?: string | null;
  skip_if_unchanged?: boolean;
  provider_payments?: Array<{
    id: string;
    underlying_payment_id?: string | null;
    amount: string;
    currency: string;
    status: string;
    received_at: string;
    method: CommercialPayment["method"];
  }>;
}

function sameProviderPaymentState(
  before: CommercialOrder,
  opts: CommercialInvoiceProviderUpdate,
): boolean {
  const current = before.payments
    .filter(
      ({ commercial_invoice_id, provider, status }) =>
        commercial_invoice_id === opts.invoice_id &&
        provider === "stripe" &&
        status === "succeeded",
    )
    .sort((a, b) =>
      `${a.provider_payment_id ?? ""}`.localeCompare(
        `${b.provider_payment_id ?? ""}`,
      ),
    );
  const expected = (opts.provider_payments ?? [])
    .filter(({ status }) => status === "succeeded")
    .sort((a, b) => a.id.localeCompare(b.id));
  if (current.length !== expected.length) return false;
  return expected.every((payment, index) => {
    const existing = current[index];
    return (
      existing.provider_payment_id === payment.id &&
      moneyCompare(existing.amount, payment.amount) === 0 &&
      existing.currency === payment.currency &&
      existing.status === payment.status &&
      iso(existing.received_at) === iso(payment.received_at) &&
      existing.method === payment.method &&
      (existing.evidence_reference ?? null) ===
        (payment.underlying_payment_id ?? null)
    );
  });
}

function sameProviderInvoiceState(
  before: CommercialOrder,
  opts: CommercialInvoiceProviderUpdate,
): boolean {
  const invoice = before.invoices.find(({ id }) => id === opts.invoice_id);
  if (!invoice) return false;
  return (
    invoice.status === opts.status &&
    invoice.provider_customer_id ===
      (opts.provider_customer_id ?? invoice.provider_customer_id) &&
    invoice.provider_invoice_id ===
      (opts.provider_invoice_id ?? invoice.provider_invoice_id) &&
    invoice.provider_payment_intent_id ===
      (opts.provider_payment_intent_id ?? invoice.provider_payment_intent_id) &&
    moneyCompare(invoice.subtotal, opts.subtotal) === 0 &&
    moneyCompare(invoice.tax, opts.tax) === 0 &&
    moneyCompare(invoice.total, opts.total) === 0 &&
    moneyCompare(invoice.amount_due, opts.amount_due) === 0 &&
    moneyCompare(invoice.amount_paid, opts.amount_paid) === 0 &&
    iso(invoice.due_at) === iso(opts.due_at) &&
    iso(invoice.sent_at) === iso(opts.sent_at) &&
    iso(invoice.paid_at) === iso(opts.paid_at) &&
    iso(invoice.voided_at) === iso(opts.voided_at) &&
    stableJson(invoice.provider_snapshot) ===
      stableJson(opts.provider_snapshot) &&
    before.collection_state === opts.collection_state &&
    before.stripe_customer_id ===
      (opts.provider_customer_id ?? before.stripe_customer_id) &&
    sameProviderPaymentState(before, opts)
  );
}

export async function updateCommercialInvoiceProvider(
  opts: CommercialInvoiceProviderUpdate,
): Promise<CommercialOrder> {
  return await withTransaction(async (client) => {
    const { rows } = await client.query<{ commercial_order_id: string }>(
      "SELECT commercial_order_id FROM commercial_invoices WHERE id=$1 FOR UPDATE",
      [opts.invoice_id],
    );
    if (!rows[0]) throw Error("commercial invoice not found");
    const before = await loadOrder(client, rows[0].commercial_order_id, true);
    // Provider event replay is keyed by immutable local identity, not by the
    // mutable Stripe snapshot fetched during each reconciliation attempt.
    const identityPayload = {
      invoice_id: opts.invoice_id,
      event_type: opts.event_type,
      event_source: opts.event_source,
    };
    const replay = await replayOrderId(client, opts.event_idempotency_key, {
      action: opts.event_type,
      order_id: before.id,
      payload: identityPayload,
    });
    if (replay) {
      recordCommercialOperator("provider-reconcile", "replay");
      return await loadOrder(client, replay);
    }
    if (opts.skip_if_unchanged && sameProviderInvoiceState(before, opts)) {
      await client.query(
        `UPDATE commercial_invoices
            SET last_reconciled_at=NOW(),
                reconcile_attempt_count=reconcile_attempt_count+1,
                last_reconcile_error=NULL
          WHERE id=$1`,
        [opts.invoice_id],
      );
      recordCommercialOperator("provider-reconcile", "success");
      return before;
    }
    await client.query(
      `UPDATE commercial_invoices SET
         status=$2,provider_customer_id=COALESCE($3,provider_customer_id),
         provider_invoice_id=COALESCE($4,provider_invoice_id),
         provider_payment_intent_id=COALESCE($5,provider_payment_intent_id),
         subtotal=$6,tax=$7,total=$8,amount_due=$9,amount_paid=$10,due_at=$11,
         hosted_invoice_url=$12,invoice_pdf_url=$13,sent_at=$14,paid_at=$15,
         voided_at=$16,last_reconciled_at=NOW(),
         reconcile_attempt_count=reconcile_attempt_count+1,last_reconcile_error=$17,
         provider_snapshot=$18,updated_at=NOW() WHERE id=$1`,
      [
        opts.invoice_id,
        opts.status,
        opts.provider_customer_id ?? null,
        opts.provider_invoice_id ?? null,
        opts.provider_payment_intent_id ?? null,
        opts.subtotal,
        opts.tax,
        opts.total,
        opts.amount_due,
        opts.amount_paid,
        opts.due_at ?? null,
        opts.hosted_invoice_url ?? null,
        opts.invoice_pdf_url ?? null,
        opts.sent_at ?? null,
        opts.paid_at ?? null,
        opts.voided_at ?? null,
        opts.error ?? null,
        opts.provider_snapshot,
      ],
    );
    if (
      before.workflow_state === "cancelled" &&
      (opts.provider_payments ?? []).some(
        ({ status }) => status === "succeeded",
      )
    ) {
      throw Error("a cancelled commercial order cannot accept payment");
    }
    for (const payment of opts.provider_payments ?? []) {
      const linked = await client.query<{
        commercial_order_id: string;
        commercial_invoice_id?: string | null;
        amount: string;
        currency: string;
      }>(
        `SELECT commercial_order_id,commercial_invoice_id,amount,currency
           FROM commercial_payments WHERE provider_payment_id=$1`,
        [payment.id],
      );
      if (
        linked.rows[0] &&
        (linked.rows[0].commercial_order_id !== before.id ||
          linked.rows[0].commercial_invoice_id !== opts.invoice_id ||
          moneyCompare(linked.rows[0].amount, payment.amount) !== 0 ||
          linked.rows[0].currency !== payment.currency)
      ) {
        throw Error(
          "provider payment identity conflicts with an existing commercial payment",
        );
      }
      await client.query(
        `INSERT INTO commercial_payments
          (id,commercial_order_id,commercial_invoice_id,provider,
           provider_payment_id,amount,currency,status,received_at,method,
           evidence_reference,idempotency_key,created_at,updated_at)
         VALUES ($1,$2,$3,'stripe',$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())
         ON CONFLICT (provider_payment_id) DO UPDATE SET
           amount=EXCLUDED.amount,currency=EXCLUDED.currency,
           status=EXCLUDED.status,received_at=EXCLUDED.received_at,
           method=CASE WHEN commercial_payments.provider='manual'
             THEN commercial_payments.method ELSE EXCLUDED.method END,
           evidence_reference=COALESCE(commercial_payments.evidence_reference,
             EXCLUDED.evidence_reference),
           updated_at=NOW()`,
        [
          randomUUID(),
          before.id,
          opts.invoice_id,
          payment.id,
          payment.amount,
          payment.currency,
          payment.status,
          payment.received_at,
          payment.method,
          payment.underlying_payment_id ?? null,
          `stripe-invoice-payment:${payment.id}`,
        ],
      );
    }
    const provisional = { ...before, collection_state: opts.collection_state };
    const complete = shouldComplete(provisional);
    await client.query(
      `UPDATE commercial_orders SET collection_state=$2::varchar,
         stripe_customer_id=COALESCE($4,stripe_customer_id),
         workflow_state=CASE
           WHEN workflow_state IN ('complete','cancelled') THEN workflow_state
           WHEN $3 THEN 'complete'
           WHEN $2::varchar IN ('open','overdue','partially_paid') THEN 'awaiting_payment'
           WHEN $2::varchar IN ('paid','waived') AND fulfillment_state='not_provisioned'
             THEN 'awaiting_payment'
           ELSE workflow_state END,
         completed_at=CASE WHEN $3 THEN COALESCE(completed_at,NOW()) ELSE completed_at END,
         next_action=CASE WHEN $3 THEN 'Complete'
           WHEN $2::varchar IN ('paid','waived') AND fulfillment_state='not_provisioned'
             THEN 'Provision service'
           WHEN $2::varchar IN ('open','overdue','partially_paid') THEN 'Collect payment'
           WHEN $2::varchar IN ('void','uncollectible') THEN 'Resolve exception'
           ELSE next_action END,
         next_action_due_at=CASE WHEN $3 THEN NULL ELSE next_action_due_at END,
         updated_at=NOW(),version=version+1 WHERE id=$1`,
      [
        before.id,
        opts.collection_state,
        complete,
        opts.provider_customer_id ?? null,
      ],
    );
    const after = await loadOrder(client, before.id);
    await insertEvent(client, {
      commercial_order_id: before.id,
      event_type: opts.event_type,
      actor_account_id: opts.actor_account_id,
      source: opts.event_source,
      reason: opts.event_reason,
      idempotency_key: opts.event_idempotency_key,
      before: before as any,
      after: after as any,
      metadata: {
        commercial_invoice_id: opts.invoice_id,
        provider_invoice_id: opts.provider_invoice_id,
      },
      identity_payload: identityPayload,
    });
    return after;
  });
}

export interface CommercialQuoteAcceptanceUpdate {
  operation_id: string;
  quote_id: string;
  invoice_id: string;
  provider_quote_id: string;
  provider_invoice_id: string;
  provider_customer_id: string;
  quote_provider_snapshot: Record<string, unknown>;
  acceptance_source: "operator_confirmed" | "provider_reconciliation";
  quote_issued_at?: string | null;
  quote_document_filename?: string | null;
  quote_document_sha256?: string | null;
  quote_document_data?: Buffer | null;
  invoice_provider_snapshot: Record<string, unknown>;
  subtotal: string;
  tax: string;
  total: string;
  amount_due: string;
  due_at?: string | null;
  hosted_invoice_url?: string | null;
  invoice_pdf_url?: string | null;
  actor_account_id?: string | null;
  event_source: CommercialEventSource;
  event_reason: string;
  event_idempotency_key: string;
}

export async function completeCommercialQuoteAcceptance(
  opts: CommercialQuoteAcceptanceUpdate,
): Promise<CommercialOrder> {
  return await withTransaction(async (client) => {
    const operationResult = await client.query(
      "SELECT * FROM commercial_provider_operations WHERE id=$1 FOR UPDATE",
      [opts.operation_id],
    );
    if (!operationResult.rows[0]) {
      throw Error("commercial provider operation not found");
    }
    const operation = normalizeProviderOperation(operationResult.rows[0]);
    if (
      operation.operation !== "quote_accept" ||
      operation.commercial_quote_id !== opts.quote_id ||
      operation.commercial_invoice_id !== opts.invoice_id
    ) {
      throw Error("provider operation does not match the quote acceptance");
    }
    const quoteResult = await client.query(
      "SELECT * FROM commercial_quotes WHERE id=$1 FOR UPDATE",
      [opts.quote_id],
    );
    const invoiceResult = await client.query(
      "SELECT * FROM commercial_invoices WHERE id=$1 FOR UPDATE",
      [opts.invoice_id],
    );
    if (!quoteResult.rows[0] || !invoiceResult.rows[0]) {
      throw Error("quote acceptance local identities are incomplete");
    }
    const quote = normalizeQuoteRow(quoteResult.rows[0]);
    const invoice = normalizeInvoiceRow(invoiceResult.rows[0]);
    if (
      quote.commercial_order_id !== operation.commercial_order_id ||
      invoice.commercial_order_id !== operation.commercial_order_id
    ) {
      throw Error("quote acceptance identities belong to different orders");
    }
    if (
      quote.provider !== "stripe" ||
      (quote.provider_quote_id &&
        quote.provider_quote_id !== opts.provider_quote_id)
    ) {
      throw Error("Stripe quote identity conflicts with the local quote");
    }
    if (
      invoice.provider !== "stripe" ||
      (invoice.provider_invoice_id &&
        invoice.provider_invoice_id !== opts.provider_invoice_id)
    ) {
      throw Error("Stripe invoice identity conflicts with the local invoice");
    }
    const quoteDocument =
      quoteResult.rows[0].document_data ?? opts.quote_document_data;
    const quoteDocumentSha256 =
      quote.document_sha256 ?? opts.quote_document_sha256;
    if (!quoteDocument || !quoteDocumentSha256) {
      throw Error(
        "a Stripe quote must have its finalized PDF before acceptance",
      );
    }
    if (
      createHash("sha256").update(quoteDocument).digest("hex") !==
      quoteDocumentSha256
    ) {
      throw Error("Stripe quote PDF failed its integrity check");
    }
    const before = await loadOrder(client, operation.commercial_order_id, true);
    if (operation.status === "succeeded") return before;
    if (!["remote_started", "indeterminate"].includes(operation.status)) {
      throw Error(
        `quote acceptance operation is ${operation.status}, expected remote_started or indeterminate`,
      );
    }
    if (!["issued", "accepted"].includes(quote.status)) {
      throw Error(`cannot accept a ${quote.status} quote`);
    }
    if (!["creating", "draft"].includes(invoice.status)) {
      throw Error(
        `cannot adopt a Stripe invoice into a ${invoice.status} invoice`,
      );
    }
    if (
      moneyCompare(opts.subtotal, quote.subtotal) !== 0 ||
      moneyCompare(opts.total, quote.total) !== 0 ||
      moneyCompare(opts.tax, 0) < 0 ||
      moneyCompare(opts.tax, moneySubtract(quote.total, quote.subtotal)) !==
        0 ||
      moneyCompare(opts.amount_due, quote.total) !== 0
    ) {
      throw Error("Stripe's accepted quote invoice does not match local terms");
    }
    const identityPayload = {
      quote_id: quote.id,
      invoice_id: invoice.id,
      provider_quote_id: opts.provider_quote_id,
      provider_invoice_id: opts.provider_invoice_id,
    };
    const replay = await replayOrderId(client, opts.event_idempotency_key, {
      action: "stripe-quote-accepted",
      order_id: before.id,
      payload: identityPayload,
    });
    if (replay) return await loadOrder(client, replay);
    await client.query(
      `UPDATE commercial_quotes SET status='accepted',provider_quote_id=$2,
         provider_status='accepted',provider_invoice_id=$3,
         provider_snapshot=$4,provider_updated_at=NOW(),last_reconciled_at=NOW(),
         issued_at=COALESCE(issued_at,$5),
         document_filename=COALESCE(document_filename,$6),
         document_mime_type=COALESCE(document_mime_type,'application/pdf'),
         document_sha256=COALESCE(document_sha256,$7),
         document_size=COALESCE(document_size,octet_length($8::bytea)),
         document_data=COALESCE(document_data,$8::bytea),
         updated_at=NOW() WHERE id=$1`,
      [
        quote.id,
        opts.provider_quote_id,
        opts.provider_invoice_id,
        opts.quote_provider_snapshot,
        opts.quote_issued_at ?? null,
        opts.quote_document_filename ?? null,
        opts.quote_document_sha256 ?? null,
        opts.quote_document_data ?? null,
      ],
    );
    await client.query(
      `UPDATE commercial_invoices SET status='draft',provider_customer_id=$2,
         provider_invoice_id=$3,subtotal=$4,tax=$5,total=$6,amount_due=$7,
         amount_paid=0,due_at=$8,hosted_invoice_url=$9,invoice_pdf_url=$10,
         provider_snapshot=$11,last_reconciled_at=NOW(),last_reconcile_error=NULL,
         reconcile_attempt_count=reconcile_attempt_count+1,updated_at=NOW()
       WHERE id=$1`,
      [
        invoice.id,
        opts.provider_customer_id,
        opts.provider_invoice_id,
        opts.subtotal,
        opts.tax,
        opts.total,
        opts.amount_due,
        opts.due_at ?? null,
        opts.hosted_invoice_url ?? null,
        opts.invoice_pdf_url ?? null,
        opts.invoice_provider_snapshot,
      ],
    );
    await client.query(
      `UPDATE commercial_orders SET collection_state='draft_invoice',
         stripe_customer_id=$2,next_action='Send invoice',updated_at=NOW(),
         version=version+1 WHERE id=$1`,
      [before.id, opts.provider_customer_id],
    );
    await client.query(
      `UPDATE commercial_provider_operations SET status='succeeded',
         result=$2,completed_at=NOW(),last_error=NULL,updated_at=NOW()
       WHERE id=$1`,
      [
        operation.id,
        {
          commercial_quote_id: quote.id,
          provider_quote_id: opts.provider_quote_id,
          commercial_invoice_id: invoice.id,
          provider_invoice_id: opts.provider_invoice_id,
        },
      ],
    );
    const after = await loadOrder(client, before.id);
    await insertEvent(client, {
      commercial_order_id: before.id,
      event_type: "stripe-quote-accepted",
      actor_account_id: opts.actor_account_id,
      source: opts.event_source,
      reason: opts.event_reason,
      idempotency_key: opts.event_idempotency_key,
      before: before as any,
      after: after as any,
      metadata: {
        commercial_quote_id: quote.id,
        provider_quote_id: opts.provider_quote_id,
        commercial_invoice_id: invoice.id,
        provider_invoice_id: opts.provider_invoice_id,
        acceptance_source: opts.acceptance_source,
      },
      identity_payload: identityPayload,
    });
    return after;
  });
}

export async function getCommercialInvoice(
  orderId: string,
  invoiceId?: string,
): Promise<CommercialInvoice> {
  const order = await getCommercialOrder(orderId);
  const invoice = invoiceId
    ? order.invoices.find(({ id }) => id === invoiceId)
    : order.invoices[0];
  if (!invoice) throw Error("commercial order has no invoice");
  return invoice;
}

export interface CommercialProviderOperation {
  id: string;
  commercial_order_id: string;
  commercial_quote_id?: string | null;
  commercial_invoice_id?: string | null;
  operation: string;
  status:
    | "reserved"
    | "remote_started"
    | "succeeded"
    | "failed"
    | "indeterminate";
  idempotency_key: string;
  expected_version: number;
  request: Record<string, unknown>;
  result: Record<string, unknown>;
  last_error?: string | null;
  attempt_count: number;
  remote_started_at?: string | null;
  completed_at?: string | null;
  created_at: string;
  updated_at: string;
}

function normalizeProviderOperation(row: any): CommercialProviderOperation {
  return {
    ...row,
    request: row.request ?? {},
    result: row.result ?? {},
    remote_started_at: iso(row.remote_started_at),
    completed_at: iso(row.completed_at),
    created_at: iso(row.created_at)!,
    updated_at: iso(row.updated_at)!,
  };
}

export async function getCommercialProviderOperationByIdempotencyKey(
  idempotencyKey: string,
): Promise<CommercialProviderOperation | undefined> {
  assertSeedAuthority();
  const key = idempotencyKey.trim();
  if (!key) throw Error("provider operation idempotency key is required");
  const { rows } = await getPool().query(
    "SELECT * FROM commercial_provider_operations WHERE idempotency_key=$1",
    [key],
  );
  return rows[0] ? normalizeProviderOperation(rows[0]) : undefined;
}

export async function reserveCommercialProviderOperation(opts: {
  order_id: string;
  quote_id?: string;
  invoice_id?: string;
  operation: string;
  expected_version: number;
  idempotency_key: string;
  request?: Record<string, unknown>;
}): Promise<{
  order: CommercialOrder;
  operation: CommercialProviderOperation;
}> {
  return await withTransaction(async (client) => {
    const order = await loadOrder(client, opts.order_id, true);
    const existing = await client.query(
      "SELECT * FROM commercial_provider_operations WHERE idempotency_key=$1",
      [opts.idempotency_key],
    );
    if (existing.rows[0]) {
      const operation = normalizeProviderOperation(existing.rows[0]);
      if (
        operation.commercial_order_id !== order.id ||
        operation.commercial_quote_id !== (opts.quote_id ?? null) ||
        operation.commercial_invoice_id !== (opts.invoice_id ?? null) ||
        operation.operation !== opts.operation ||
        stableJson(operation.request) !== stableJson(opts.request ?? {})
      ) {
        throw Error(
          "provider idempotency key was already used for different operation input",
        );
      }
      return { order, operation };
    }
    requireExpectedVersion(order.version, opts.expected_version);
    const { rows } = await client.query(
      `INSERT INTO commercial_provider_operations
        (id,commercial_order_id,commercial_quote_id,commercial_invoice_id,operation,status,
         idempotency_key,expected_version,request,result,attempt_count,
         created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,'reserved',$6,$7,$8,'{}',0,NOW(),NOW())
       RETURNING *`,
      [
        randomUUID(),
        order.id,
        opts.quote_id ?? null,
        opts.invoice_id ?? null,
        opts.operation,
        opts.idempotency_key,
        opts.expected_version,
        opts.request ?? {},
      ],
    );
    return { order, operation: normalizeProviderOperation(rows[0]) };
  });
}

export async function setCommercialProviderOperationStatus(opts: {
  id: string;
  status: CommercialProviderOperation["status"];
  result?: Record<string, unknown>;
  error?: unknown;
}): Promise<CommercialProviderOperation> {
  assertSeedAuthority();
  const { rows } = await getPool().query(
    `UPDATE commercial_provider_operations SET status=$2::varchar,
       result=CASE WHEN $3::jsonb='{}'::jsonb THEN result ELSE $3::jsonb END,
       last_error=$4::text,
       attempt_count=attempt_count+CASE WHEN $2::varchar='remote_started' THEN 1 ELSE 0 END,
       remote_started_at=CASE WHEN $2::varchar='remote_started' THEN NOW() ELSE remote_started_at END,
       completed_at=CASE WHEN $2::varchar IN ('succeeded','failed') THEN NOW() ELSE completed_at END,
       updated_at=NOW() WHERE id=$1 RETURNING *`,
    [
      opts.id,
      opts.status,
      opts.result ?? {},
      opts.error == null ? null : `${opts.error}`.slice(0, 5_000),
    ],
  );
  if (!rows[0]) throw Error("commercial provider operation not found");
  const operation = normalizeProviderOperation(rows[0]);
  if (
    operation.status === "succeeded" &&
    operation.operation === "void-invoice" &&
    operation.commercial_invoice_id
  ) {
    await getPool().query(
      `UPDATE commercial_provider_operations SET status='failed',
         last_error='superseded by successful invoice void/abandonment',
         completed_at=NOW(),updated_at=NOW()
       WHERE commercial_invoice_id=$1 AND id<>$2
         AND status IN ('reserved','remote_started','indeterminate')`,
      [operation.commercial_invoice_id, operation.id],
    );
  }
  return operation;
}

export async function getStaleCommercialInvoiceIds(
  opts: {
    stale_minutes?: number;
    limit?: number;
  } = {},
): Promise<string[]> {
  assertSeedAuthority();
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT id FROM commercial_invoices
      WHERE status IN ('creating','draft','open')
        AND (last_reconciled_at IS NULL OR last_reconciled_at < NOW()-($1||' minutes')::interval)
      ORDER BY COALESCE(last_reconciled_at,created_at) LIMIT $2`,
    [Math.max(opts.stale_minutes ?? 15, 1), Math.min(opts.limit ?? 100, 500)],
  );
  return rows.map(({ id }) => id);
}

export async function getStaleCommercialQuoteIds(
  opts: {
    stale_minutes?: number;
    limit?: number;
  } = {},
): Promise<string[]> {
  assertSeedAuthority();
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT id FROM commercial_quotes
      WHERE provider='stripe' AND status IN ('draft','issued')
        AND (last_reconciled_at IS NULL OR
          last_reconciled_at < NOW()-($1||' minutes')::interval)
      ORDER BY COALESCE(last_reconciled_at,provider_updated_at,created_at) LIMIT $2`,
    [Math.max(opts.stale_minutes ?? 15, 1), Math.min(opts.limit ?? 100, 500)],
  );
  return rows.map(({ id }) => id);
}

export async function getCommercialOrderDiagnostics(): Promise<CommercialOrderDiagnostics> {
  assertSeedAuthority();
  const [
    countsResult,
    amountsResult,
    staleIds,
    staleQuoteIds,
    inconsistent,
    orphanLicenses,
    failedStripeEvents,
    indeterminateOperations,
    missingDueDates,
    reconciliation,
    quoteReconciliation,
  ] = await Promise.all([
    getPool().query<{ key: string; count: string }>(`
      SELECT 'open_orders' AS key,count(*)::text AS count FROM commercial_orders
       WHERE workflow_state NOT IN ('complete','cancelled')
      UNION ALL SELECT 'unassigned',count(*)::text FROM commercial_orders
       WHERE assignee_account_id IS NULL AND workflow_state NOT IN ('complete','cancelled')
      UNION ALL SELECT 'overdue',count(*)::text FROM commercial_orders WHERE collection_state='overdue'
      UNION ALL SELECT 'paid_not_provisioned',count(*)::text FROM commercial_orders
       WHERE collection_state='paid' AND fulfillment_state='not_provisioned'
      UNION ALL SELECT 'provisioned_not_paid',count(*)::text FROM commercial_orders
       WHERE fulfillment_state='provisioned' AND collection_state NOT IN ('paid','waived')
      UNION ALL SELECT 'stale_next_action',count(*)::text FROM commercial_orders
       WHERE workflow_state NOT IN ('complete','cancelled')
         AND next_action_due_at < NOW()
      UNION ALL SELECT 'stripe_dead_letter',count(*)::text FROM commercial_stripe_events
       WHERE status='dead_letter'
      UNION ALL SELECT 'workflow:'||workflow_state,count(*)::text
       FROM commercial_orders GROUP BY workflow_state
      UNION ALL SELECT 'collection:'||collection_state,count(*)::text
       FROM commercial_orders GROUP BY collection_state`),
    getPool().query<{ key: string; amount: string }>(`
      SELECT 'open_amount' AS key,COALESCE(sum(agreed_total),0)::text AS amount
       FROM commercial_orders WHERE workflow_state NOT IN ('complete','cancelled')
      UNION ALL SELECT 'overdue_amount',COALESCE(sum(agreed_total),0)::text
       FROM commercial_orders WHERE collection_state='overdue'
      UNION ALL SELECT 'fulfilled_unpaid_amount',COALESCE(sum(agreed_total),0)::text
       FROM commercial_orders WHERE fulfillment_state='provisioned'
        AND collection_state NOT IN ('paid','waived')`),
    getStaleCommercialInvoiceIds({ limit: 500 }),
    getStaleCommercialQuoteIds({ limit: 500 }),
    getPool().query<{ id: string }>(`
      SELECT id FROM commercial_orders WHERE
       (workflow_state='complete' AND NOT
         (collection_state IN ('paid','waived') OR collection_mode='complimentary'))
       OR (collection_state='paid' AND agreed_total <= 0)
       OR (workflow_state NOT IN ('complete','cancelled') AND next_action='')
      LIMIT 501`),
    getPool().query<{ id: string }>(`
      SELECT s.id FROM site_licenses s
       WHERE s.metadata ? 'commercial_order_id'
         AND (s.expires_at IS NULL OR s.expires_at > NOW())
         AND NOT EXISTS (
           SELECT 1 FROM commercial_orders o
            WHERE o.site_license_id=s.id
               OR o.id::text=s.metadata->>'commercial_order_id'
         )
       ORDER BY s.updated DESC NULLS LAST LIMIT 501`),
    getPool().query<{
      event_id: string;
      event_type: string;
      status: string;
      commercial_order_id?: string | null;
      commercial_quote_id?: string | null;
      commercial_invoice_id?: string | null;
      provider_quote_id?: string | null;
      provider_invoice_id?: string | null;
      attempt_count: number;
      next_attempt_at: Date | string;
      last_error?: string | null;
      created_at: Date | string;
      updated_at: Date | string;
    }>(`
      SELECT event_id,event_type,status,commercial_order_id,
        commercial_quote_id,commercial_invoice_id,provider_quote_id,
        provider_invoice_id,attempt_count,
        next_attempt_at,last_error,created_at,updated_at
       FROM commercial_stripe_events
       WHERE status IN ('failed','dead_letter')
       ORDER BY updated_at DESC LIMIT 501`),
    getPool().query<{
      id: string;
      commercial_order_id: string;
      commercial_quote_id?: string | null;
      commercial_invoice_id?: string | null;
      operation: string;
      status: string;
      attempt_count: number;
      last_error?: string | null;
      remote_started_at?: Date | string | null;
      completed_at?: Date | string | null;
      created_at: Date | string;
      updated_at: Date | string;
    }>(`
      SELECT id,commercial_order_id,commercial_quote_id,commercial_invoice_id,
        operation,status,
        attempt_count,last_error,remote_started_at,completed_at,created_at,updated_at
       FROM commercial_provider_operations
       WHERE status='indeterminate' ORDER BY updated_at DESC LIMIT 501`),
    getPool().query<{ id: string }>(`
      SELECT id FROM commercial_orders
       WHERE workflow_state NOT IN ('complete','cancelled')
         AND next_action_due_at IS NULL
       ORDER BY updated_at DESC LIMIT 501`),
    getPool().query<{
      provider_local_mismatch_count: string;
      oldest_reconciliation_lag_seconds: string;
    }>(`
      SELECT
        count(*) FILTER (
          WHERE provider='stripe' AND provider_snapshot ? 'status' AND (
            provider_snapshot->>'status' <> status OR
            lower(COALESCE(provider_snapshot->>'currency','')) <> currency OR
            ((provider_snapshot->>'subtotal') ~ '^[0-9]+(?:\\.[0-9]+)?$'
              AND (provider_snapshot->>'subtotal')::numeric / 100 <> subtotal) OR
            ((provider_snapshot->>'total') ~ '^[0-9]+(?:\\.[0-9]+)?$'
              AND (provider_snapshot->>'total')::numeric / 100 <> total) OR
            ((provider_snapshot->>'amount_remaining') ~ '^[0-9]+(?:\\.[0-9]+)?$'
              AND (provider_snapshot->>'amount_remaining')::numeric / 100 <> amount_due) OR
            ((provider_snapshot->>'amount_paid') ~ '^[0-9]+(?:\\.[0-9]+)?$'
              AND (provider_snapshot->>'amount_paid')::numeric / 100 <> amount_paid)
          )
        )::text AS provider_local_mismatch_count,
        COALESCE(max(EXTRACT(EPOCH FROM
          (NOW()-COALESCE(last_reconciled_at,created_at)))) FILTER (
            WHERE provider='stripe' AND status IN ('creating','draft','open')
          ),0)::text AS oldest_reconciliation_lag_seconds
      FROM commercial_invoices`),
    getPool().query<{
      provider_local_mismatch_count: string;
      oldest_reconciliation_lag_seconds: string;
    }>(`
      SELECT
        count(*) FILTER (
          WHERE provider='stripe' AND provider_snapshot ? 'status' AND (
            provider_snapshot->>'id' <> provider_quote_id OR
            provider_snapshot->>'status' <> provider_status OR
            lower(COALESCE(provider_snapshot->>'currency','')) <> currency OR
            ((provider_snapshot->>'amount_subtotal') ~ '^[0-9]+$'
              AND (provider_snapshot->>'amount_subtotal')::numeric / 100 <> subtotal) OR
            ((provider_snapshot->>'amount_total') ~ '^[0-9]+$'
              AND (provider_snapshot->>'amount_total')::numeric / 100 <> total)
          )
        )::text AS provider_local_mismatch_count,
        COALESCE(max(EXTRACT(EPOCH FROM
          (NOW()-COALESCE(last_reconciled_at,provider_updated_at,created_at)))) FILTER (
            WHERE provider='stripe' AND status IN ('draft','issued')
          ),0)::text AS oldest_reconciliation_lag_seconds
      FROM commercial_quotes`),
  ]);
  return {
    generated_at: new Date().toISOString(),
    counts: Object.fromEntries(
      countsResult.rows.map(({ key, count }) => [key, Number(count)]),
    ),
    amounts: Object.fromEntries(
      amountsResult.rows.map(({ key, amount }) => [key, money(amount)]),
    ),
    reconciliation: {
      provider_local_mismatch_count:
        Number(reconciliation.rows[0]?.provider_local_mismatch_count ?? 0) +
        Number(quoteReconciliation.rows[0]?.provider_local_mismatch_count ?? 0),
      oldest_reconciliation_lag_seconds: Math.max(
        0,
        Number(reconciliation.rows[0]?.oldest_reconciliation_lag_seconds ?? 0),
        Number(
          quoteReconciliation.rows[0]?.oldest_reconciliation_lag_seconds ?? 0,
        ),
      ),
    },
    stale_invoice_ids: staleIds,
    stale_quote_ids: staleQuoteIds,
    inconsistent_order_ids: inconsistent.rows.slice(0, 500).map(({ id }) => id),
    review_queues: {
      truncated: {
        inconsistent_orders: inconsistent.rows.length > 500,
        active_commercial_site_licenses: orphanLicenses.rows.length > 500,
        failed_stripe_events: failedStripeEvents.rows.length > 500,
        indeterminate_provider_operations:
          indeterminateOperations.rows.length > 500,
        open_orders_missing_due_date: missingDueDates.rows.length > 500,
        unlinked_commercial_stripe_invoices: false,
      },
      active_commercial_site_license_ids: orphanLicenses.rows
        .slice(0, 500)
        .map(({ id }) => id),
      unlinked_commercial_stripe_invoices: [],
      failed_stripe_events: failedStripeEvents.rows
        .slice(0, 500)
        .map((event) => ({
          ...event,
          next_attempt_at: iso(event.next_attempt_at)!,
          created_at: iso(event.created_at)!,
          updated_at: iso(event.updated_at)!,
        })),
      indeterminate_provider_operations: indeterminateOperations.rows
        .slice(0, 500)
        .map((operation) => ({
          ...operation,
          remote_started_at: iso(operation.remote_started_at),
          completed_at: iso(operation.completed_at),
          created_at: iso(operation.created_at)!,
          updated_at: iso(operation.updated_at)!,
        })),
      failed_stripe_event_ids: failedStripeEvents.rows
        .slice(0, 500)
        .map(({ event_id }) => event_id),
      indeterminate_provider_operation_ids: indeterminateOperations.rows
        .slice(0, 500)
        .map(({ id }) => id),
      open_orders_missing_due_date_ids: missingDueDates.rows
        .slice(0, 500)
        .map(({ id }) => id),
    },
  };
}

export async function retryCommercialStripeEvent(
  opts: CommercialStripeEventRetryRequest,
): Promise<CommercialStripeEventRetryResult> {
  const reason = requireReason(opts.reason);
  assertProviderMutationEnums({ source: opts.source });
  if (!opts.account_id) throw Error("account_id is required");
  if (!/^evt_[A-Za-z0-9]+$/.test(opts.event_id)) {
    throw Error("a valid Stripe event id is required");
  }
  const key = commercialIdempotencyKey("stripe-event-retry", opts as any);
  return await withTransaction(async (client) => {
    const { rows } = await client.query(
      "SELECT * FROM commercial_stripe_events WHERE event_id=$1 FOR UPDATE",
      [opts.event_id],
    );
    const before = rows[0];
    if (!before) throw Error("commercial Stripe event not found");
    if (!before.commercial_order_id) {
      throw Error(
        "a Stripe event without a commercial order cannot be retried",
      );
    }
    const replay = await replayOrderId(client, key, {
      action: "stripe-event-retry-requested",
      order_id: before.commercial_order_id,
      payload: opts as any,
    });
    if (replay) {
      return {
        event_id: opts.event_id,
        status: "pending",
        commercial_order_id: before.commercial_order_id,
      };
    }
    if (!["failed", "dead_letter"].includes(before.status)) {
      throw Error(
        `Stripe event cannot be retried from status ${before.status}`,
      );
    }
    const updated = await client.query(
      `UPDATE commercial_stripe_events SET status='pending',attempt_count=0,
         next_attempt_at=NOW(),lease_expires_at=NULL,last_error=NULL,
         processed_at=NULL,updated_at=NOW() WHERE event_id=$1 RETURNING *`,
      [opts.event_id],
    );
    await insertEvent(client, {
      commercial_order_id: before.commercial_order_id,
      event_type: "stripe-event-retry-requested",
      actor_account_id: opts.account_id,
      source: opts.source ?? "cli",
      reason,
      idempotency_key: key,
      before,
      after: updated.rows[0],
      metadata: { stripe_event_id: opts.event_id },
      identity_payload: opts as any,
    });
    return {
      event_id: opts.event_id,
      status: "pending",
      commercial_order_id: before.commercial_order_id,
    };
  });
}

export async function backfillCommercialOrders(
  opts: CommercialBackfillRequest,
): Promise<CommercialBackfillResponse> {
  requireReason(opts.reason);
  if (opts.candidates.length > 500)
    throw Error("backfill is limited to 500 candidates");
  const response: CommercialBackfillResponse = {
    preview: !opts.commit,
    planned: [],
    created: [],
    skipped: [],
  };

  const prepared: PreparedBackfillCandidate[] = [];
  for (let index = 0; index < opts.candidates.length; index += 1) {
    const candidate = opts.candidates[index];
    const result = prepareBackfillCandidate(opts, candidate, index);
    const duplicate = result.plan.blockers.length
      ? undefined
      : await findBackfillDuplicate({
          candidate,
          provenance: result.plan.provenance,
          createKey: result.create.idempotency_key!,
        });
    if (duplicate && !duplicate.replayable) {
      result.skipReason = `already represented by ${duplicate.id}`;
      result.plan.ready = false;
      result.plan.blockers.push(result.skipReason);
    }
    prepared.push(result);
  }

  const seenCandidates = new Map<string, number>();
  for (const entry of prepared) {
    if (entry.plan.blockers.length || entry.skipReason) continue;
    const identifiers = [
      entry.candidate.site_license_id
        ? `site-license:${entry.candidate.site_license_id}`
        : undefined,
      entry.plan.provenance
        ? `provenance:${entry.plan.provenance.source}\0${entry.plan.provenance.reference}`
        : undefined,
      ...(entry.candidate.zendesk_ticket_ids ?? []).map(
        (ticketId) => `zendesk:${ticketId}`,
      ),
    ].filter((value): value is string => value != null);
    const duplicateIndex = identifiers
      .map((identifier) => seenCandidates.get(identifier))
      .find((value) => value != null);
    if (duplicateIndex != null) {
      entry.plan.ready = false;
      entry.plan.blockers.push(
        `duplicates candidate ${duplicateIndex} in this backfill`,
      );
      continue;
    }
    for (const identifier of identifiers) {
      seenCandidates.set(identifier, entry.plan.index);
    }
  }

  response.planned = prepared.map(({ plan }) => plan);
  for (const { plan, skipReason } of prepared) {
    if (skipReason) {
      response.skipped.push({ index: plan.index, reason: skipReason });
    }
  }

  if (!opts.commit) return response;
  const invalid = prepared.find(
    ({ plan, skipReason }) => !skipReason && plan.blockers.length,
  );
  if (invalid) {
    throw Error(
      `backfill candidate ${invalid.plan.index} is invalid: ${invalid.plan.blockers.join("; ")}`,
    );
  }

  for (const entry of prepared) {
    if (entry.skipReason) continue;
    let order = await createCommercialOrder(entry.create);
    if (entry.plan.actions.includes("approve")) {
      order = await approveCommercialOrder({
        account_id: opts.account_id,
        id: order.id,
        expected_version: 1,
        reason: opts.reason,
        source: "migration",
        idempotency_key: backfillActionKey(opts, entry.plan.index, "approve"),
      });
    }
    if (entry.plan.actions.includes("issue_invoice")) {
      const invoice = entry.candidate.invoice!;
      order = await issueManualCommercialInvoice({
        account_id: opts.account_id,
        id: order.id,
        expected_version: 2,
        reason: opts.reason,
        source: "migration",
        idempotency_key: backfillActionKey(
          opts,
          entry.plan.index,
          "issue_invoice",
        ),
        invoice_reference: invoice.reference,
        issued_at: invoice.issued_at,
        due_at: invoice.due_at,
        document_url: invoice.document_url,
        evidence_reference: invoice.evidence_reference,
      });
    }
    if (entry.plan.actions.includes("record_payment")) {
      const payment = entry.candidate.payment!;
      order = await recordManualCommercialPayment({
        account_id: opts.account_id,
        id: order.id,
        expected_version: 3,
        reason: opts.reason,
        source: "migration",
        idempotency_key: backfillActionKey(
          opts,
          entry.plan.index,
          "record_payment",
        ),
        amount: payment.amount,
        currency: entry.candidate.currency ?? "usd",
        received_at: payment.received_at,
        method: payment.method,
        evidence_reference: payment.evidence_reference,
        provider_payment_id: payment.provider_payment_id,
      });
    }
    response.created.push(order);
  }
  return response;
}

interface PreparedBackfillCandidate {
  candidate: CommercialBackfillCandidate;
  create: CommercialOrderCreateRequest;
  plan: CommercialBackfillPlan;
  skipReason?: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function backfillActionKey(
  opts: CommercialBackfillRequest,
  index: number,
  action: string,
): string {
  const root = commercialIdempotencyKey("backfill", opts as any);
  const digest = createHash("sha256")
    .update(`${root}\0${index}\0${action}`)
    .digest("hex");
  return `commercial:backfill:${digest}`;
}

function normalizeBackfillProvenance(
  candidate: CommercialBackfillCandidate,
  blockers: string[],
): CommercialBackfillPlan["provenance"] {
  if (candidate.provenance == null) return;
  const source = `${candidate.provenance.source ?? ""}`.trim();
  const reference = `${candidate.provenance.reference ?? ""}`.trim();
  if (!source || source.length > 120) {
    blockers.push("provenance.source must contain at most 120 characters");
  }
  if (!reference || reference.length > 240) {
    blockers.push("provenance.reference must contain at most 240 characters");
  }
  return { source, reference };
}

function validateHistoricalBackfill(
  candidate: CommercialBackfillCandidate,
  blockers: string[],
): void {
  if (!candidate.site_license_id) {
    blockers.push("site_license_id is required for a historical site license");
  }
  if (!candidate.provenance) {
    blockers.push("provenance is required for a historical site license");
  }
  if (!candidate.service_starts_at || !candidate.service_ends_at) {
    blockers.push(
      "service_starts_at and service_ends_at are required for a historical site license",
    );
  } else {
    try {
      const start = requireTimestamp(
        candidate.service_starts_at,
        "service_starts_at",
      );
      const end = requireTimestamp(
        candidate.service_ends_at,
        "service_ends_at",
      );
      if (start >= end)
        blockers.push("service_ends_at must be after service_starts_at");
    } catch (err) {
      blockers.push(`${err}`.replace(/^Error:\s*/, ""));
    }
  }
  if (!candidate.billing_contact) {
    blockers.push("billing_contact is required for a historical site license");
  }
  if (!candidate.invoice) {
    blockers.push("invoice is required for a historical site license");
    return;
  }
  const invoiceReference = `${candidate.invoice.reference ?? ""}`.trim();
  if (!invoiceReference || invoiceReference.length > 240) {
    blockers.push("invoice.reference must contain at most 240 characters");
  }
  let issuedAt: Date | undefined;
  try {
    issuedAt = requireTimestamp(
      candidate.invoice.issued_at,
      "invoice.issued_at",
    );
    if (candidate.invoice.due_at) {
      const dueAt = requireTimestamp(
        candidate.invoice.due_at,
        "invoice.due_at",
      );
      if (dueAt < issuedAt) {
        blockers.push("invoice.due_at must not be before invoice.issued_at");
      }
    }
  } catch (err) {
    blockers.push(`${err}`.replace(/^Error:\s*/, ""));
  }
  if (candidate.invoice.document_url) {
    try {
      if (new URL(candidate.invoice.document_url).protocol !== "https:") {
        blockers.push("invoice.document_url must use HTTPS");
      }
    } catch {
      blockers.push("invoice.document_url must be a valid HTTPS URL");
    }
  }
  if (!candidate.payment) return;
  try {
    const amount = normalizePositiveMoney(
      candidate.payment.amount,
      "payment amount",
    );
    const total = normalizePositiveMoney(
      candidate.agreed_total,
      "agreed_total",
    );
    if (moneyCompare(amount, total) > 0) {
      blockers.push("payment amount exceeds agreed_total");
    }
    normalizeCurrency(candidate.currency);
    requireTimestamp(candidate.payment.received_at, "payment.received_at");
    assertProviderMutationEnums({
      source: "migration",
      method: candidate.payment.method,
    });
    if (!`${candidate.payment.evidence_reference ?? ""}`.trim()) {
      blockers.push("payment.evidence_reference is required");
    }
  } catch (err) {
    blockers.push(`${err}`.replace(/^Error:\s*/, ""));
  }
}

function prepareBackfillCandidate(
  opts: CommercialBackfillRequest,
  candidate: CommercialBackfillCandidate,
  index: number,
): PreparedBackfillCandidate {
  const blockers: string[] = [];
  const provenance = normalizeBackfillProvenance(candidate, blockers);
  if (
    candidate.site_license_id &&
    !UUID_PATTERN.test(candidate.site_license_id)
  ) {
    blockers.push("site_license_id must be a UUID");
  }
  const historical =
    candidate.provenance != null ||
    candidate.invoice != null ||
    candidate.payment != null;
  if (historical) validateHistoricalBackfill(candidate, blockers);
  const nextActionDueAt =
    candidate.next_action_due_at ??
    candidate.invoice?.due_at ??
    candidate.service_ends_at ??
    candidate.service_starts_at ??
    new Date(Date.now() + 7 * 86_400_000).toISOString();
  const create: CommercialOrderCreateRequest = {
    account_id: opts.account_id,
    reason: opts.reason,
    source: "migration",
    idempotency_key: backfillActionKey(opts, index, "create"),
    organization_name: candidate.organization_name,
    customer_account_id: candidate.customer_account_id,
    site_license_id: candidate.site_license_id,
    zendesk_ticket_ids: candidate.zendesk_ticket_ids,
    collection_mode: "manual_invoice",
    agreed_subtotal: candidate.agreed_total,
    agreed_total: candidate.agreed_total,
    currency: candidate.currency ?? "usd",
    service_starts_at: candidate.service_starts_at,
    service_ends_at: candidate.service_ends_at,
    next_action: candidate.next_action,
    next_action_due_at: nextActionDueAt,
    terms_snapshot: provenance
      ? {
          fulfillment_required: false,
          legacy_import: provenance,
        }
      : {},
    items: [
      {
        description: `${candidate.organization_name} commercial agreement`,
        quantity: "1",
        unit_amount: candidate.agreed_total,
        subtotal: candidate.agreed_total,
        service_start: candidate.service_starts_at,
        service_end: candidate.service_ends_at,
        product_kind: candidate.site_license_id
          ? "site_license"
          : "commercial_service",
      },
    ],
    contacts: candidate.billing_contact ? [candidate.billing_contact] : [],
  };
  try {
    const preview = previewCommercialOrderCreate(create);
    if (historical) blockers.push(...preview.approval_blockers);
  } catch (err) {
    blockers.push(`${err}`.replace(/^Error:\s*/, ""));
  }
  const actions: CommercialBackfillPlan["actions"] = ["create"];
  if (historical) actions.push("approve", "issue_invoice");
  if (candidate.payment) actions.push("record_payment");
  return {
    candidate,
    create,
    plan: {
      index,
      organization_name: `${candidate.organization_name ?? ""}`.trim(),
      site_license_id: candidate.site_license_id,
      provenance,
      actions,
      ready: blockers.length === 0,
      blockers: [...new Set(blockers)],
    },
  };
}

async function findBackfillDuplicate({
  candidate,
  provenance,
  createKey,
}: {
  candidate: CommercialBackfillCandidate;
  provenance?: CommercialBackfillPlan["provenance"];
  createKey: string;
}): Promise<{ id: string; replayable: boolean } | undefined> {
  const { rows } = await getPool().query<{
    id: string;
    replayable: boolean;
  }>(
    `SELECT o.id,
            EXISTS(
              SELECT 1 FROM commercial_order_events event
               WHERE event.commercial_order_id=o.id
                 AND event.idempotency_key=$5
            ) AS replayable
       FROM commercial_orders o
      WHERE ($1::uuid IS NOT NULL AND o.site_license_id=$1) OR
            ($2::integer[] && o.zendesk_ticket_ids) OR
            ($3::text IS NOT NULL AND
             o.terms_snapshot->'legacy_import'->>'source'=$3 AND
             o.terms_snapshot->'legacy_import'->>'reference'=$4)
      ORDER BY o.created_at DESC,o.id
      LIMIT 1`,
    [
      candidate.site_license_id ?? null,
      candidate.zendesk_ticket_ids ?? [],
      provenance?.source ?? null,
      provenance?.reference ?? null,
      createKey,
    ],
  );
  return rows[0];
}
