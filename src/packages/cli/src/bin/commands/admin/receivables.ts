/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { Command } from "commander";

import type {
  CommercialBackfillRequest,
  CommercialBillingDetailsUpdateRequest,
  CommercialCollectionModeUpdateRequest,
  CommercialInvoiceLinkRequest,
  CommercialManualInvoiceIssueRequest,
  CommercialInvoiceMutationRequest,
  CommercialManualPaymentRequest,
  CommercialMutationRequest,
  CommercialOrderCreateRequest,
  CommercialOrderDocumentUploadRequest,
  CommercialOrderDocumentVoidRequest,
  CommercialOrderListRequest,
  CommercialOrderRevisionRequest,
  CommercialOrderUpdateRequest,
  CommercialProvisionRequest,
  CommercialQuoteIssueRequest,
  CommercialStripeQuoteAcceptRequest,
  CommercialStripeQuoteCreateRequest,
  CommercialStripeQuoteMutationRequest,
  CommercialQuoteVoidRequest,
} from "@cocalc/conat/hub/api/commercial-orders";
import {
  COMMERCIAL_COLLECTION_STATES,
  COMMERCIAL_ORDER_DOCUMENT_MAX_BYTES,
  COMMERCIAL_FULFILLMENT_STATES,
  COMMERCIAL_NEXT_ACTIONS,
  COMMERCIAL_PAYMENT_METHODS,
  COMMERCIAL_WORKFLOW_STATES,
  type CommercialCollectionState,
  type CommercialCollectionMode,
  type CommercialFulfillmentState,
  type CommercialNextAction,
  type CommercialOrder,
  type CommercialPaymentMethod,
  type CommercialWorkflowState,
} from "@cocalc/util/commercial-orders";

export type ReceivablesCommandDeps = {
  withContext: any;
  resolveAccountByIdentifier: any;
  isValidUUID: any;
};

type MutationOptions = {
  commit?: boolean;
  reason?: string;
  expectedVersion?: string;
  expectedUpdatedAt?: string;
  idempotencyKey?: string;
};

type JsonObject = Record<string, unknown>;

type InvoiceCollectionMode = Exclude<CommercialCollectionMode, "complimentary">;

function normalizeInvoiceCollectionMode(value: unknown): InvoiceCollectionMode {
  const mode = `${value ?? ""}`.trim();
  const allowed: readonly string[] = ["stripe_invoice", "manual_invoice"];
  if (!allowed.includes(mode)) {
    throw Error("--mode must be stripe_invoice or manual_invoice");
  }
  return mode as InvoiceCollectionMode;
}

function normalizeNextAction(value: unknown): CommercialNextAction {
  const action = `${value ?? ""}`.trim();
  if (!COMMERCIAL_NEXT_ACTIONS.includes(action as CommercialNextAction)) {
    throw Error(
      `--next-action must be one of: ${COMMERCIAL_NEXT_ACTIONS.join(", ")}`,
    );
  }
  return action as CommercialNextAction;
}

const READ_REASONS = {
  list: "Review commercial receivables queue",
  show: "Review commercial order",
  events: "Review commercial order audit events",
  invoicePreview: "Review commercial invoice preview",
  quotePreview: "Review commercial quote preview",
  quoteDocument: "Download stored commercial quote document",
  orderDocument: "Download stored commercial purchase order",
  fulfillmentPreview: "Review commercial fulfillment preview",
  diagnostics: "Review commercial receivables diagnostics",
} as const;

function requireReason(value: string | undefined): string {
  const reason = `${value ?? ""}`.trim();
  if (reason.length < 4) {
    throw new Error("--reason must contain at least 4 characters");
  }
  if (reason.length > 2_000) {
    throw new Error("--reason must contain at most 2000 characters");
  }
  return reason;
}

function readReason(value: string | undefined, fallback: string): string {
  const reason = `${value ?? ""}`.trim();
  return reason ? requireReason(reason) : fallback;
}

function normalizeOrderReference(value: string): string {
  const id = `${value ?? ""}`.trim();
  if (!id) throw new Error("commercial order id or order number is required");
  return id;
}

function parsePositiveInteger(
  value: string | undefined,
  name: string,
  { maximum }: { maximum?: number } = {},
): number | undefined {
  if (value == null || `${value}`.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  if (maximum != null && parsed > maximum) {
    throw new Error(`${name} must be at most ${maximum}`);
  }
  return parsed;
}

function normalizeIso(
  value: string | undefined,
  name: string,
): string | undefined {
  const raw = `${value ?? ""}`.trim();
  if (!raw) return undefined;
  const date = new Date(raw);
  if (!Number.isFinite(date.valueOf())) {
    throw new Error(`${name} must be an ISO-8601 timestamp`);
  }
  return date.toISOString();
}

function normalizeState(value: string): string {
  return value.trim().toLowerCase().replace(/-/g, "_");
}

function parseStates<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  name: string,
): T[] | undefined {
  if (!value?.trim()) return undefined;
  const result = [
    ...new Set(value.split(",").map(normalizeState).filter(Boolean)),
  ];
  for (const state of result) {
    if (!(allowed as readonly string[]).includes(state)) {
      throw new Error(`${name} contains invalid state '${state}'`);
    }
  }
  return result as T[];
}

function parseCombinedStates(value: string | undefined): {
  workflow_states?: CommercialWorkflowState[];
  collection_states?: CommercialCollectionState[];
  fulfillment_states?: CommercialFulfillmentState[];
} {
  if (!value?.trim()) return {};
  const workflow = new Set<CommercialWorkflowState>();
  const collection = new Set<CommercialCollectionState>();
  const fulfillment = new Set<CommercialFulfillmentState>();
  for (const raw of value.split(",")) {
    const state = normalizeState(raw);
    if (!state) continue;
    if ((COMMERCIAL_WORKFLOW_STATES as readonly string[]).includes(state)) {
      workflow.add(state as CommercialWorkflowState);
    } else if (
      (COMMERCIAL_COLLECTION_STATES as readonly string[]).includes(state)
    ) {
      collection.add(state as CommercialCollectionState);
    } else if (
      (COMMERCIAL_FULFILLMENT_STATES as readonly string[]).includes(state)
    ) {
      fulfillment.add(state as CommercialFulfillmentState);
    } else {
      throw new Error(`--state contains invalid state '${state}'`);
    }
  }
  return {
    ...(workflow.size ? { workflow_states: [...workflow] } : {}),
    ...(collection.size ? { collection_states: [...collection] } : {}),
    ...(fulfillment.size ? { fulfillment_states: [...fulfillment] } : {}),
  };
}

function parseMoney(
  value: string | undefined,
  name: string,
): string | undefined {
  const raw = `${value ?? ""}`.trim();
  if (!raw) return undefined;
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) {
    throw new Error(`${name} must be a nonnegative decimal amount`);
  }
  return raw;
}

function requirePositiveMoney(value: string | undefined, name: string): string {
  const amount = parseMoney(value, name);
  if (!amount || /^0(?:\.0+)?$/.test(amount)) {
    throw new Error(`${name} must be a positive decimal amount`);
  }
  return amount;
}

function parseCurrency(value: string | undefined): string {
  const currency = `${value ?? "usd"}`.trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) {
    throw new Error("--currency must be a three-letter ISO currency code");
  }
  return currency;
}

function parsePaymentMethod(
  value: string | undefined,
): CommercialPaymentMethod {
  const method = normalizeState(`${value ?? ""}`);
  if (!(COMMERCIAL_PAYMENT_METHODS as readonly string[]).includes(method)) {
    throw new Error(
      `--method must be one of: ${COMMERCIAL_PAYMENT_METHODS.join(", ")}`,
    );
  }
  return method as CommercialPaymentMethod;
}

async function readJsonFile(path: string | undefined, name = "--file") {
  const filename = `${path ?? ""}`.trim();
  if (!filename) throw new Error(`${name} is required`);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(filename, "utf8"));
  } catch (err) {
    throw new Error(`failed to parse JSON from ${filename}: ${err}`);
  }
  return value;
}

function requireObject(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must contain a JSON object`);
  }
  return value as JsonObject;
}

function updateFields(body: JsonObject): JsonObject {
  const structured = ["changes", "items", "contacts"].some(
    (key) => key in body,
  );
  return structured
    ? {
        changes: requireObject(body.changes ?? {}, "changes"),
        ...(body.items !== undefined ? { items: body.items } : {}),
        ...(body.contacts !== undefined ? { contacts: body.contacts } : {}),
      }
    : { changes: body };
}

function normalizeHttpsUrl(
  value: string | undefined,
  name: string,
): string | undefined {
  const raw = `${value ?? ""}`.trim();
  if (!raw) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid HTTPS URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${name} must be a valid HTTPS URL`);
  }
  return parsed.toString();
}

function mutationKey(
  operation: string,
  request: JsonObject,
  explicit?: string,
) {
  const supplied = `${explicit ?? ""}`.trim();
  if (supplied) return supplied;
  const stable = Object.fromEntries(
    Object.entries(request).filter(
      ([key]) => !["reason", "idempotency_key", "commit"].includes(key),
    ),
  );
  return `receivables-${operation}-${createHash("sha256")
    .update(JSON.stringify(stable))
    .digest("hex")
    .slice(0, 32)}`;
}

function mutationOptions(command: Command, commitDescription: string): Command {
  return command
    .requiredOption("--reason <text>", "human-readable audit reason")
    .option("--expected-version <n>", "reviewed commercial order version")
    .option(
      "--expected-updated-at <iso>",
      "reviewed updated_at timestamp; resolved to the matching order version",
    )
    .option("--idempotency-key <key>", "stable logical request key")
    .option("--commit", commitDescription, false);
}

function commitOnlyOptions(
  command: Command,
  commitDescription: string,
): Command {
  return command
    .requiredOption("--reason <text>", "human-readable audit reason")
    .option("--idempotency-key <key>", "stable logical request key")
    .option("--commit", commitDescription, false);
}

function expectedVersion(
  order: CommercialOrder,
  opts: MutationOptions,
): number {
  if (opts.expectedVersion != null && opts.expectedUpdatedAt != null) {
    throw new Error(
      "use only one of --expected-version or --expected-updated-at",
    );
  }
  const explicit = parsePositiveInteger(
    opts.expectedVersion,
    "--expected-version",
  );
  if (explicit != null) return explicit;
  if (opts.expectedUpdatedAt != null) {
    const expected = normalizeIso(
      opts.expectedUpdatedAt,
      "--expected-updated-at",
    )!;
    if (new Date(expected).valueOf() !== new Date(order.updated_at).valueOf()) {
      throw new Error(
        `--expected-updated-at does not match current order timestamp ${order.updated_at}`,
      );
    }
    return order.version;
  }
  if (opts.commit) {
    throw new Error(
      "--expected-version or --expected-updated-at is required with --commit; review the dry-run first",
    );
  }
  return order.version;
}

function orderSummary(order: CommercialOrder) {
  return {
    id: order.id,
    order_number: order.order_number,
    organization: order.organization_name,
    total: order.agreed_total,
    currency: order.currency,
    workflow: order.workflow_state,
    collection: order.collection_state,
    fulfillment: order.fulfillment_state,
    assignee: order.assignee_account_id ?? "unassigned",
    next_action: order.next_action,
    due: order.next_action_due_at ?? "",
    version: order.version,
    updated_at: order.updated_at,
  };
}

function listResult(ctx: any, response: any) {
  if (ctx.globals?.json || ctx.globals?.output === "json") return response;
  return response.orders.map(orderSummary);
}

function eventsResult(ctx: any, response: any) {
  if (ctx.globals?.json || ctx.globals?.output === "json") return response;
  return response.events.map((event: any) => ({
    time: event.created_at,
    type: event.event_type,
    source: event.source,
    actor: event.actor_account_id ?? "system",
    reason: event.reason,
    idempotency_key: event.idempotency_key,
  }));
}

const EXPORT_FIELDS = [
  "order_number",
  "id",
  "organization_name",
  "agreed_total",
  "currency",
  "collection_mode",
  "workflow_state",
  "collection_state",
  "fulfillment_state",
  "assignee_account_id",
  "next_action",
  "next_action_due_at",
  "service_starts_at",
  "service_ends_at",
  "po_number",
  "customer_reference",
  "site_license_id",
  "zendesk_ticket_ids",
  "billing_email",
  "latest_invoice_id",
  "latest_invoice_status",
  "latest_invoice_amount_due",
  "latest_invoice_due_at",
  "latest_invoice_sent_at",
  "latest_invoice_created_at",
  "last_activity_at",
  "created_at",
  "updated_at",
  "version",
] as const;

function exportRow(
  order: any,
): Record<(typeof EXPORT_FIELDS)[number], unknown> {
  return Object.fromEntries(
    EXPORT_FIELDS.map((field) => [
      field,
      field === "zendesk_ticket_ids"
        ? (order[field] ?? []).join(";")
        : (order[field] ?? null),
    ]),
  ) as Record<(typeof EXPORT_FIELDS)[number], unknown>;
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : `${value}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function formatExport(rows: JsonObject[], format: string): string {
  if (format === "json") return `${JSON.stringify(rows, null, 2)}\n`;
  if (format !== "csv") {
    throw new Error("--format must be json or csv");
  }
  return `${[
    EXPORT_FIELDS.join(","),
    ...rows.map((row) =>
      EXPORT_FIELDS.map((field) => csvCell(row[field])).join(","),
    ),
  ].join("\n")}\n`;
}

function preview(
  operation: string,
  order: CommercialOrder | undefined,
  request: JsonObject,
  extra?: JsonObject,
) {
  return {
    preview: true,
    operation,
    ...(order ? { order: orderSummary(order) } : {}),
    request,
    ...(extra ?? {}),
    commit_hint:
      "Re-run this command with --commit after reviewing the request.",
  };
}

async function resolveAccountId(
  ctx: any,
  identifier: string,
  deps: Pick<
    ReceivablesCommandDeps,
    "resolveAccountByIdentifier" | "isValidUUID"
  >,
): Promise<string> {
  const value = `${identifier ?? ""}`.trim();
  if (!value) throw new Error("account identifier must be non-empty");
  if (value === "me") return ctx.accountId;
  if (deps.isValidUUID(value)) return value;
  const result = await deps.resolveAccountByIdentifier(ctx, value);
  const accountId = `${result?.account_id ?? ""}`.trim();
  if (!accountId) throw new Error(`unable to resolve account '${value}'`);
  return accountId;
}

function commonMutationRequest(
  operation: string,
  order: CommercialOrder,
  opts: MutationOptions,
  fields: JsonObject = {},
): CommercialMutationRequest & JsonObject {
  const reason = requireReason(opts.reason);
  const base = {
    ...fields,
    reason,
    source: "cli" as const,
    expected_version: expectedVersion(order, opts),
  };
  return {
    ...base,
    idempotency_key: mutationKey(operation, base, opts.idempotencyKey),
  };
}

function registerReadCommands(
  receivables: Command,
  deps: ReceivablesCommandDeps,
) {
  receivables
    .command("list")
    .description("list the shared commercial receivables queue")
    .option("--state <states>", "comma-separated workflow or collection states")
    .option("--workflow-state <states>", "comma-separated workflow states")
    .option("--collection-state <states>", "comma-separated collection states")
    .option(
      "--fulfillment-state <states>",
      "comma-separated fulfillment states",
    )
    .option("--assignee <user>", "account, email, me, or unassigned")
    .option("--organization <text>", "organization name substring")
    .option("--zendesk-ticket <id>", "linked Zendesk ticket id")
    .option("--site-license <uuid>", "linked site license id")
    .option("--needs-action", "exclude completed and cancelled orders", false)
    .option("--stale-before <iso>", "orders last updated before this time")
    .option(
      "--next-action-due-before <iso>",
      "orders whose explicit next action is due before this time",
    )
    .option("--min-amount <amount>", "minimum agreed total")
    .option("--max-amount <amount>", "maximum agreed total")
    .option("--search <text>", "free-text order search")
    .option("--cursor <cursor>", "pagination cursor")
    .option("--limit <n>", "maximum rows (1-500)", "100")
    .option("--max-bytes <n>", "maximum response bytes")
    .option("--reason <text>", "audit reason for this admin read")
    .action(async (opts: any, command: Command) => {
      await deps.withContext(command, "admin receivables list", async (ctx) => {
        const combined = parseCombinedStates(opts.state);
        const workflow = parseStates(
          opts.workflowState,
          COMMERCIAL_WORKFLOW_STATES,
          "--workflow-state",
        );
        const collection = parseStates(
          opts.collectionState,
          COMMERCIAL_COLLECTION_STATES,
          "--collection-state",
        );
        const fulfillment = parseStates(
          opts.fulfillmentState,
          COMMERCIAL_FULFILLMENT_STATES,
          "--fulfillment-state",
        );
        let assignee: string | null | undefined;
        if (opts.assignee != null) {
          const value = `${opts.assignee}`.trim().toLowerCase();
          assignee = ["unassigned", "none"].includes(value)
            ? null
            : await resolveAccountId(ctx, opts.assignee, deps);
        }
        const request: CommercialOrderListRequest = {
          reason: readReason(opts.reason, READ_REASONS.list),
          ...combined,
          ...(workflow ? { workflow_states: workflow } : {}),
          ...(collection ? { collection_states: collection } : {}),
          ...(fulfillment ? { fulfillment_states: fulfillment } : {}),
          ...(assignee !== undefined ? { assignee_account_id: assignee } : {}),
          organization: `${opts.organization ?? ""}`.trim() || undefined,
          zendesk_ticket_id: parsePositiveInteger(
            opts.zendeskTicket,
            "--zendesk-ticket",
          ),
          site_license_id: `${opts.siteLicense ?? ""}`.trim() || undefined,
          needs_action: opts.needsAction || undefined,
          stale_before: normalizeIso(opts.staleBefore, "--stale-before"),
          next_action_due_before: normalizeIso(
            opts.nextActionDueBefore,
            "--next-action-due-before",
          ),
          min_amount: parseMoney(opts.minAmount, "--min-amount"),
          max_amount: parseMoney(opts.maxAmount, "--max-amount"),
          search: `${opts.search ?? ""}`.trim() || undefined,
          cursor: `${opts.cursor ?? ""}`.trim() || undefined,
          limit: parsePositiveInteger(opts.limit, "--limit", { maximum: 500 }),
          max_bytes: parsePositiveInteger(opts.maxBytes, "--max-bytes", {
            maximum: 5_000_000,
          }),
        };
        return listResult(ctx, await ctx.hub.commercialOrders.list(request));
      });
    });

  receivables
    .command("show <order>")
    .description("show one commercial order")
    .option("--reason <text>", "audit reason for this admin read")
    .action(async (order: string, opts: any, command: Command) => {
      await deps.withContext(
        command,
        "admin receivables show",
        async (ctx) =>
          await ctx.hub.commercialOrders.get({
            id: normalizeOrderReference(order),
            reason: readReason(opts.reason, READ_REASONS.show),
          }),
      );
    });

  receivables
    .command("events <order>")
    .description("show the immutable commercial order audit timeline")
    .option("--cursor <cursor>", "pagination cursor")
    .option("--limit <n>", "maximum events (1-500)", "100")
    .option("--reason <text>", "audit reason for this admin read")
    .action(async (order: string, opts: any, command: Command) => {
      await deps.withContext(
        command,
        "admin receivables events",
        async (ctx) => {
          const response = await ctx.hub.commercialOrders.events({
            id: normalizeOrderReference(order),
            reason: readReason(opts.reason, READ_REASONS.events),
            cursor: `${opts.cursor ?? ""}`.trim() || undefined,
            limit: parsePositiveInteger(opts.limit, "--limit", {
              maximum: 500,
            }),
          });
          return eventsResult(ctx, response);
        },
      );
    });
}

function registerOrderMutationCommands(
  receivables: Command,
  deps: ReceivablesCommandDeps,
) {
  commitOnlyOptions(
    receivables
      .command("create")
      .description("preview or create a commercial order")
      .requiredOption("--file <path>", "commercial order JSON file"),
    "create the commercial order",
  ).action(async (opts: any, command: Command) => {
    await deps.withContext(command, "admin receivables create", async (ctx) => {
      const body = requireObject(await readJsonFile(opts.file), "--file");
      const request = {
        ...body,
        reason: requireReason(opts.reason),
        source: "cli" as const,
      } as unknown as CommercialOrderCreateRequest;
      request.idempotency_key = mutationKey(
        "create",
        request as unknown as JsonObject,
        opts.idempotencyKey,
      );
      if (!opts.commit) {
        const validated = await ctx.hub.commercialOrders.createPreview(request);
        return preview(
          "create",
          undefined,
          validated.normalized_request as unknown as JsonObject,
          {
            approval_ready: validated.approval_ready,
            approval_blockers: validated.approval_blockers,
          },
        );
      }
      return await ctx.hub.commercialOrders.create(request);
    });
  });

  mutationOptions(
    receivables
      .command("update <order>")
      .description("preview or update commercial order terms")
      .requiredOption("--file <path>", "changes JSON file"),
    "update the commercial order",
  ).action(
    async (
      orderRef: string,
      opts: MutationOptions & { file: string },
      command: Command,
    ) => {
      await deps.withContext(
        command,
        "admin receivables update",
        async (ctx) => {
          const order = await ctx.hub.commercialOrders.get({
            id: normalizeOrderReference(orderRef),
            reason: requireReason(opts.reason),
          });
          const body = requireObject(await readJsonFile(opts.file), "--file");
          const fields = updateFields(body);
          const request = {
            id: order.id,
            ...commonMutationRequest("update", order, opts, fields),
          } as unknown as CommercialOrderUpdateRequest;
          if (!opts.commit) {
            return preview("update", order, request as unknown as JsonObject);
          }
          return await ctx.hub.commercialOrders.update(request);
        },
      );
    },
  );

  mutationOptions(
    receivables
      .command("revise <order>")
      .description(
        "preview or explicitly revise approved commercial order terms",
      )
      .requiredOption("--file <path>", "revised terms JSON file"),
    "revise the approved commercial order terms and reset approval",
  ).action(
    async (
      orderRef: string,
      opts: MutationOptions & { file: string },
      command: Command,
    ) => {
      await deps.withContext(
        command,
        "admin receivables revise",
        async (ctx) => {
          const reason = requireReason(opts.reason);
          const order = await ctx.hub.commercialOrders.get({
            id: normalizeOrderReference(orderRef),
            reason,
          });
          const body = requireObject(await readJsonFile(opts.file), "--file");
          const request = {
            id: order.id,
            ...commonMutationRequest("revise", order, opts, updateFields(body)),
          } as unknown as CommercialOrderRevisionRequest;
          if (!opts.commit) {
            return preview("revise", order, request as unknown as JsonObject, {
              approval_effect:
                "Committing this revision resets the order to draft for explicit re-approval.",
            });
          }
          return await ctx.hub.commercialOrders.revise(request);
        },
      );
    },
  );

  const collection = receivables
    .command("collection")
    .description("commercial payment collection configuration");
  mutationOptions(
    collection
      .command("mode <order>")
      .description(
        "change Stripe/manual collection before any invoice or payment exists",
      )
      .requiredOption("--mode <mode>", "stripe_invoice or manual_invoice"),
    "change the commercial order collection mode",
  ).action(async (orderRef: string, opts: any, command: Command) => {
    await deps.withContext(
      command,
      "admin receivables collection mode",
      async (ctx) => {
        const reason = requireReason(opts.reason);
        const order = await ctx.hub.commercialOrders.get({
          id: normalizeOrderReference(orderRef),
          reason,
        });
        const request = {
          id: order.id,
          ...commonMutationRequest("collection-mode", order, opts, {
            collection_mode: normalizeInvoiceCollectionMode(opts.mode),
          }),
        } as CommercialCollectionModeUpdateRequest;
        if (!opts.commit) {
          return preview(
            "collection-mode-update",
            order,
            request as unknown as JsonObject,
            {
              safety:
                "This preserves approval and fulfillment and is rejected after any invoice, payment, complimentary agreement, or provider work exists.",
            },
          );
        }
        return await ctx.hub.commercialOrders.updateCollectionMode(request);
      },
    );
  });

  mutationOptions(
    receivables
      .command("assign <order>")
      .description("preview or assign collection ownership")
      .option("--user <account>", "account UUID, email, or me")
      .option("--unassign", "clear the assignee", false)
      .option("--next-action <text>", "new explicit next action")
      .option("--due-at <iso>", "next action due time")
      .option("--clear-due-at", "clear the next action due time", false),
    "assign the commercial order",
  ).action(async (orderRef: string, opts: any, command: Command) => {
    await deps.withContext(command, "admin receivables assign", async (ctx) => {
      if (!!opts.user === !!opts.unassign) {
        throw new Error("specify exactly one of --user or --unassign");
      }
      if (opts.dueAt && opts.clearDueAt) {
        throw new Error("use only one of --due-at or --clear-due-at");
      }
      const order = await ctx.hub.commercialOrders.get({
        id: normalizeOrderReference(orderRef),
        reason: requireReason(opts.reason),
      });
      const assignee = opts.unassign
        ? null
        : await resolveAccountId(ctx, opts.user, deps);
      const request = {
        id: order.id,
        ...commonMutationRequest("assign", order, opts, {
          assignee_account_id: assignee,
          ...(`${opts.nextAction ?? ""}`.trim()
            ? { next_action: normalizeNextAction(opts.nextAction) }
            : {}),
          ...(opts.clearDueAt
            ? { next_action_due_at: null }
            : opts.dueAt
              ? { next_action_due_at: normalizeIso(opts.dueAt, "--due-at") }
              : {}),
        }),
      };
      if (!opts.commit) return preview("assign", order, request);
      return await ctx.hub.commercialOrders.assign(request);
    });
  });

  mutationOptions(
    receivables
      .command("note <order>")
      .description("preview or append an internal order note")
      .requiredOption("--file <path>", "plain-text or Markdown note file"),
    "append the internal note",
  ).action(async (orderRef: string, opts: any, command: Command) => {
    await deps.withContext(command, "admin receivables note", async (ctx) => {
      const note = (await readFile(opts.file, "utf8")).trim();
      if (!note) throw new Error("--file must contain a non-empty note");
      const order = await ctx.hub.commercialOrders.get({
        id: normalizeOrderReference(orderRef),
        reason: requireReason(opts.reason),
      });
      const request = {
        id: order.id,
        ...commonMutationRequest("note", order, opts, { note }),
      };
      if (!opts.commit) return preview("note", order, request);
      return await ctx.hub.commercialOrders.addNote(request);
    });
  });

  for (const operation of ["approve", "cancel"] as const) {
    mutationOptions(
      receivables
        .command(`${operation} <order>`)
        .description(`preview or ${operation} a commercial order`),
      `${operation} the commercial order`,
    ).action(async (orderRef: string, opts: any, command: Command) => {
      await deps.withContext(
        command,
        `admin receivables ${operation}`,
        async (ctx) => {
          const order = await ctx.hub.commercialOrders.get({
            id: normalizeOrderReference(orderRef),
            reason: requireReason(opts.reason),
          });
          const request = {
            id: order.id,
            ...commonMutationRequest(operation, order, opts),
          };
          if (!opts.commit) return preview(operation, order, request);
          return await ctx.hub.commercialOrders[operation](request);
        },
      );
    });
  }
}

function registerInvoiceCommands(
  receivables: Command,
  deps: ReceivablesCommandDeps,
) {
  const invoice = receivables
    .command("invoice")
    .description("commercial Stripe and manual invoice operations");

  invoice
    .command("preview <order>")
    .description("preview the authoritative Stripe invoice inputs")
    .option("--reason <text>", "audit reason for this admin read")
    .action(async (order: string, opts: any, command: Command) => {
      await deps.withContext(
        command,
        "admin receivables invoice preview",
        async (ctx) =>
          await ctx.hub.commercialOrders.invoicePreview({
            id: normalizeOrderReference(order),
            reason: readReason(opts.reason, READ_REASONS.invoicePreview),
          }),
      );
    });

  for (const operation of ["create", "send", "void"] as const) {
    const apiMethod = {
      create: "createInvoiceDraft",
      send: "sendInvoice",
      void: "voidInvoice",
    }[operation] as "createInvoiceDraft" | "sendInvoice" | "voidInvoice";
    mutationOptions(
      invoice
        .command(`${operation} <order>`)
        .description(`preview or ${operation} a Stripe commercial invoice`)
        .option(
          "--invoice-id <uuid>",
          "specific internal commercial invoice id",
        ),
      `${operation} the Stripe commercial invoice`,
    ).action(async (orderRef: string, opts: any, command: Command) => {
      await deps.withContext(
        command,
        `admin receivables invoice ${operation}`,
        async (ctx) => {
          const reason = requireReason(opts.reason);
          const order = await ctx.hub.commercialOrders.get({
            id: normalizeOrderReference(orderRef),
            reason,
          });
          const request = {
            id: order.id,
            ...commonMutationRequest(`invoice-${operation}`, order, opts, {
              ...(`${opts.invoiceId ?? ""}`.trim()
                ? { commercial_invoice_id: `${opts.invoiceId}`.trim() }
                : {}),
            }),
          } as CommercialInvoiceMutationRequest;
          if (!opts.commit) {
            const extra =
              operation === "create"
                ? {
                    invoice_preview:
                      await ctx.hub.commercialOrders.invoicePreview({
                        id: order.id,
                        reason,
                      }),
                  }
                : undefined;
            return preview(
              `invoice-${operation}`,
              order,
              request as unknown as JsonObject,
              extra,
            );
          }
          return await ctx.hub.commercialOrders[apiMethod](request);
        },
      );
    });
  }

  mutationOptions(
    invoice
      .command("issue-manual <order>")
      .description("preview or issue an internal/manual commercial invoice")
      .requiredOption(
        "--invoice-reference <text>",
        "invoice number or finance-system reference",
      )
      .option("--due-at <iso>", "invoice payment due time")
      .option("--issued-at <iso>", "invoice issue time")
      .option("--document-url <url>", "HTTPS URL for the invoice document")
      .option(
        "--evidence-reference <text>",
        "non-sensitive finance-system evidence reference",
      ),
    "issue the internal/manual commercial invoice",
  ).action(async (orderRef: string, opts: any, command: Command) => {
    await deps.withContext(
      command,
      "admin receivables invoice issue-manual",
      async (ctx) => {
        const reason = requireReason(opts.reason);
        const invoiceReference = `${opts.invoiceReference ?? ""}`.trim();
        if (!invoiceReference) {
          throw new Error("--invoice-reference must be non-empty");
        }
        if (invoiceReference.length > 240) {
          throw new Error("--invoice-reference must be at most 240 characters");
        }
        const order = await ctx.hub.commercialOrders.get({
          id: normalizeOrderReference(orderRef),
          reason,
        });
        const request = {
          id: order.id,
          ...commonMutationRequest("invoice-issue-manual", order, opts, {
            invoice_reference: invoiceReference,
            ...(opts.dueAt
              ? { due_at: normalizeIso(opts.dueAt, "--due-at") }
              : {}),
            ...(opts.issuedAt
              ? { issued_at: normalizeIso(opts.issuedAt, "--issued-at") }
              : {}),
            ...(opts.documentUrl
              ? {
                  document_url: normalizeHttpsUrl(
                    opts.documentUrl,
                    "--document-url",
                  ),
                }
              : {}),
            ...(`${opts.evidenceReference ?? ""}`.trim()
              ? {
                  evidence_reference: `${opts.evidenceReference}`.trim(),
                }
              : {}),
          }),
        } as CommercialManualInvoiceIssueRequest;
        if (!opts.commit) {
          return preview(
            "invoice-issue-manual",
            order,
            request as unknown as JsonObject,
          );
        }
        return await ctx.hub.commercialOrders.issueManualInvoice(request);
      },
    );
  });

  mutationOptions(
    invoice
      .command("link <order>")
      .description("preview or link an existing Stripe invoice for migration")
      .requiredOption(
        "--provider-invoice-id <id>",
        "Stripe invoice id (in_...)",
      ),
    "link the existing Stripe invoice",
  ).action(async (orderRef: string, opts: any, command: Command) => {
    await deps.withContext(
      command,
      "admin receivables invoice link",
      async (ctx) => {
        const providerInvoiceId = `${opts.providerInvoiceId ?? ""}`.trim();
        if (!/^in_[A-Za-z0-9]+$/.test(providerInvoiceId)) {
          throw new Error("--provider-invoice-id must be a Stripe invoice id");
        }
        const order = await ctx.hub.commercialOrders.get({
          id: normalizeOrderReference(orderRef),
          reason: requireReason(opts.reason),
        });
        const request = {
          id: order.id,
          ...commonMutationRequest("invoice-link", order, opts, {
            provider_invoice_id: providerInvoiceId,
          }),
        } as CommercialInvoiceLinkRequest;
        if (!opts.commit) {
          return preview(
            "invoice-link",
            order,
            request as unknown as JsonObject,
          );
        }
        return await ctx.hub.commercialOrders.linkExistingInvoice(request);
      },
    );
  });

  commitOnlyOptions(
    invoice
      .command("reconcile <order>")
      .description("preview or reconcile an invoice from current Stripe state")
      .option("--invoice-id <uuid>", "specific internal commercial invoice id"),
    "reconcile and persist current Stripe invoice state",
  ).action(async (orderRef: string, opts: any, command: Command) => {
    await deps.withContext(
      command,
      "admin receivables invoice reconcile",
      async (ctx) => {
        const reason = requireReason(opts.reason);
        const order = await ctx.hub.commercialOrders.get({
          id: normalizeOrderReference(orderRef),
          reason,
        });
        const base = {
          id: order.id,
          ...(`${opts.invoiceId ?? ""}`.trim()
            ? { commercial_invoice_id: `${opts.invoiceId}`.trim() }
            : {}),
          reason,
          source: "cli" as const,
        };
        const request: CommercialInvoiceMutationRequest = {
          ...base,
          idempotency_key: mutationKey(
            "invoice-reconcile",
            base,
            opts.idempotencyKey,
          ),
        };
        if (!opts.commit) {
          return preview(
            "invoice-reconcile",
            order,
            request as unknown as JsonObject,
            {
              reconcile_preview:
                await ctx.hub.commercialOrders.reconcilePreview({
                  id: order.id,
                  commercial_invoice_id: base.commercial_invoice_id,
                  reason,
                }),
            },
          );
        }
        return await ctx.hub.commercialOrders.reconcileInvoice(request);
      },
    );
  });
}

function registerBillingCommands(
  receivables: Command,
  deps: ReceivablesCommandDeps,
) {
  const billing = receivables
    .command("billing")
    .description("future invoice recipient and billing-address corrections");

  mutationOptions(
    billing
      .command("update <order>")
      .description(
        "preview or correct billing details without reopening fulfilled terms",
      )
      .requiredOption(
        "--file <path>",
        "JSON with billing_contacts and optional procurement_contacts, billing_address, and invoice_memo",
      ),
    "correct future invoice billing details",
  ).action(
    async (
      orderRef: string,
      opts: MutationOptions & { file: string },
      command: Command,
    ) => {
      await deps.withContext(
        command,
        "admin receivables billing update",
        async (ctx) => {
          const reason = requireReason(opts.reason);
          const order = await ctx.hub.commercialOrders.get({
            id: normalizeOrderReference(orderRef),
            reason,
          });
          const body = requireObject(await readJsonFile(opts.file), "--file");
          if (!Array.isArray(body.billing_contacts)) {
            throw new Error("--file must contain a billing_contacts array");
          }
          const request = {
            id: order.id,
            ...commonMutationRequest("billing-update", order, opts, body),
          } as unknown as CommercialBillingDetailsUpdateRequest;
          if (!opts.commit) {
            return preview(
              "billing-update",
              order,
              request as unknown as JsonObject,
              {
                safety:
                  "This preserves approval and fulfillment, changes only future invoice recipient details, and is rejected after a live invoice exists.",
              },
            );
          }
          return await ctx.hub.commercialOrders.updateBillingDetails(request);
        },
      );
    },
  );
}

function registerQuoteCommands(
  receivables: Command,
  deps: ReceivablesCommandDeps,
) {
  const quote = receivables
    .command("quote")
    .description("generate and retain first-class commercial quote PDFs");

  quote
    .command("preview <order>")
    .description("preview authoritative quote inputs and readiness")
    .option("--reason <text>", "audit reason for this admin read")
    .action(async (orderRef: string, opts: any, command: Command) => {
      await deps.withContext(
        command,
        "admin receivables quote preview",
        async (ctx) =>
          await ctx.hub.commercialOrders.quotePreview({
            id: normalizeOrderReference(orderRef),
            reason: readReason(opts.reason, READ_REASONS.quotePreview),
          }),
      );
    });

  const stripe = quote
    .command("stripe")
    .description("manage Stripe-native commercial quote lifecycles");

  stripe
    .command("preview <order>")
    .description("preview authoritative Stripe quote inputs and readiness")
    .option(
      "--valid-until <iso>",
      "quote expiration timestamp; defaults to 30 days",
    )
    .option("--reason <text>", "audit reason for this admin read")
    .action(async (orderRef: string, opts: any, command: Command) => {
      await deps.withContext(
        command,
        "admin receivables quote stripe preview",
        async (ctx) =>
          await ctx.hub.commercialOrders.stripeQuotePreview({
            id: normalizeOrderReference(orderRef),
            ...(opts.validUntil
              ? {
                  valid_until: normalizeIso(opts.validUntil, "--valid-until"),
                }
              : {}),
            reason: readReason(opts.reason, READ_REASONS.quotePreview),
          }),
      );
    });

  mutationOptions(
    stripe
      .command("create <order>")
      .description("preview or create a Stripe quote draft")
      .option(
        "--valid-until <iso>",
        "quote expiration timestamp; defaults to 30 days",
      ),
    "create the Stripe quote draft",
  ).action(async (orderRef: string, opts: any, command: Command) => {
    await deps.withContext(
      command,
      "admin receivables quote stripe create",
      async (ctx) => {
        const reason = requireReason(opts.reason);
        const order = await ctx.hub.commercialOrders.get({
          id: normalizeOrderReference(orderRef),
          reason,
        });
        const validUntil = opts.validUntil
          ? normalizeIso(opts.validUntil, "--valid-until")
          : undefined;
        const request = {
          id: order.id,
          ...commonMutationRequest("quote-stripe-create", order, opts, {
            ...(validUntil ? { valid_until: validUntil } : {}),
          }),
        } as CommercialStripeQuoteCreateRequest;
        if (!opts.commit) {
          return preview(
            "quote-stripe-create",
            order,
            request as unknown as JsonObject,
            {
              stripe_quote_preview:
                await ctx.hub.commercialOrders.stripeQuotePreview({
                  id: order.id,
                  ...(validUntil ? { valid_until: validUntil } : {}),
                  reason,
                }),
            },
          );
        }
        return await ctx.hub.commercialOrders.createStripeQuote(request);
      },
    );
  });

  for (const operation of ["finalize", "cancel", "reconcile"] as const) {
    const apiMethod = {
      finalize: "finalizeStripeQuote",
      cancel: "cancelStripeQuote",
      reconcile: "reconcileStripeQuote",
    }[operation] as
      | "finalizeStripeQuote"
      | "cancelStripeQuote"
      | "reconcileStripeQuote";
    mutationOptions(
      stripe
        .command(`${operation} <order>`)
        .description(`preview or ${operation} a Stripe commercial quote`)
        .requiredOption("--quote-id <uuid>", "internal commercial quote id"),
      `${operation} the Stripe commercial quote`,
    ).action(async (orderRef: string, opts: any, command: Command) => {
      await deps.withContext(
        command,
        `admin receivables quote stripe ${operation}`,
        async (ctx) => {
          const reason = requireReason(opts.reason);
          const order = await ctx.hub.commercialOrders.get({
            id: normalizeOrderReference(orderRef),
            reason,
          });
          const request = {
            id: order.id,
            ...commonMutationRequest(`quote-stripe-${operation}`, order, opts, {
              commercial_quote_id: `${opts.quoteId ?? ""}`.trim(),
            }),
          } as CommercialStripeQuoteMutationRequest;
          if (!opts.commit) {
            return preview(
              `quote-stripe-${operation}`,
              order,
              request as unknown as JsonObject,
            );
          }
          return await ctx.hub.commercialOrders[apiMethod](request);
        },
      );
    });
  }

  mutationOptions(
    stripe
      .command("accept <order>")
      .description(
        "preview or accept a Stripe quote and create its unsent invoice draft",
      )
      .requiredOption("--quote-id <uuid>", "internal commercial quote id")
      .requiredOption(
        "--customer-acceptance-confirmed",
        "confirm that customer acceptance was explicitly authorized",
      ),
    "accept the Stripe commercial quote",
  ).action(async (orderRef: string, opts: any, command: Command) => {
    await deps.withContext(
      command,
      "admin receivables quote stripe accept",
      async (ctx) => {
        const reason = requireReason(opts.reason);
        const order = await ctx.hub.commercialOrders.get({
          id: normalizeOrderReference(orderRef),
          reason,
        });
        const request = {
          id: order.id,
          ...commonMutationRequest("quote-stripe-accept", order, opts, {
            commercial_quote_id: `${opts.quoteId ?? ""}`.trim(),
            customer_acceptance_confirmed: true,
          }),
        } as CommercialStripeQuoteAcceptRequest;
        if (!opts.commit) {
          return preview(
            "quote-stripe-accept",
            order,
            request as unknown as JsonObject,
          );
        }
        return await ctx.hub.commercialOrders.acceptStripeQuote(request);
      },
    );
  });

  mutationOptions(
    quote
      .command("issue <order>")
      .description("preview or issue and store an immutable quote PDF")
      .option(
        "--valid-until <iso>",
        "quote expiration timestamp; defaults to 30 days",
      ),
    "issue and store the commercial quote",
  ).action(async (orderRef: string, opts: any, command: Command) => {
    await deps.withContext(
      command,
      "admin receivables quote issue",
      async (ctx) => {
        const reason = requireReason(opts.reason);
        const order = await ctx.hub.commercialOrders.get({
          id: normalizeOrderReference(orderRef),
          reason,
        });
        const request = {
          id: order.id,
          ...commonMutationRequest("quote-issue", order, opts, {
            ...(opts.validUntil
              ? {
                  valid_until: normalizeIso(opts.validUntil, "--valid-until"),
                }
              : {}),
          }),
        } as CommercialQuoteIssueRequest;
        if (!opts.commit) {
          return preview(
            "quote-issue",
            order,
            request as unknown as JsonObject,
            {
              quote_preview: await ctx.hub.commercialOrders.quotePreview({
                id: order.id,
                reason,
              }),
            },
          );
        }
        return await ctx.hub.commercialOrders.issueQuote(request);
      },
    );
  });

  quote
    .command("download <order>")
    .description("download and verify a stored quote PDF")
    .requiredOption("--quote-id <uuid>", "internal commercial quote id")
    .requiredOption("--output-file <path>", "destination PDF path")
    .option("--force", "replace an existing output file", false)
    .option("--reason <text>", "audit reason for this admin read")
    .action(async (orderRef: string, opts: any, command: Command) => {
      await deps.withContext(
        command,
        "admin receivables quote download",
        async (ctx) => {
          const document = await ctx.hub.commercialOrders.quoteDocument({
            id: normalizeOrderReference(orderRef),
            commercial_quote_id: `${opts.quoteId ?? ""}`.trim(),
            reason: readReason(opts.reason, READ_REASONS.quoteDocument),
          });
          const content = Buffer.from(document.content_base64, "base64");
          await writeFile(opts.outputFile, content, {
            flag: opts.force ? "w" : "wx",
          });
          return {
            quote_number: document.quote.quote_number,
            output: opts.outputFile,
            bytes: content.length,
            sha256: document.quote.document_sha256,
          };
        },
      );
    });

  mutationOptions(
    quote
      .command("share <order>")
      .description(
        "issue an expiring bearer link to a retained PDF (replaces the previous link)",
      )
      .requiredOption("--quote-id <uuid>", "internal commercial quote id")
      .requiredOption(
        "--expires-at <iso>",
        "link expiration, no later than quote expiration",
      ),
    "issue a private quote download link",
  ).action(async (orderRef: string, opts: any, command: Command) => {
    await deps.withContext(
      command,
      "admin receivables quote share",
      async (ctx) => {
        const order = await ctx.hub.commercialOrders.get({
          id: normalizeOrderReference(orderRef),
          reason: requireReason(opts.reason),
        });
        const request = {
          id: order.id,
          ...commonMutationRequest("quote-share", order, opts, {
            commercial_quote_id: `${opts.quoteId}`.trim(),
            expires_at: normalizeIso(opts.expiresAt, "--expires-at"),
          }),
        };
        if (!opts.commit)
          return preview(
            "quote-share",
            order,
            request as unknown as JsonObject,
          );
        // Resolve the public origin before mutation so failures cannot lose a new token.
        const { url: publicUrl } = await ctx.hub.system.getPublicSiteUrl({});
        const base = new URL(publicUrl);
        if (
          !["http:", "https:"].includes(base.protocol) ||
          base.username ||
          base.password
        )
          throw Error("invalid public site URL");
        const result = await ctx.hub.commercialOrders.issueQuoteLink(request);
        return {
          order_number: result.order.order_number,
          version: result.order.version,
          url: result.path
            ? `${publicUrl.replace(/\/+$/, "")}${result.path}`
            : null,
          notice: result.path
            ? "Anyone with this link can download the PDF until expiration or revocation. Store it privately; it is returned only once."
            : "Idempotent replay: no new link was issued. The original token cannot be recovered. To replace it, issue a new request with a new idempotency key and current version.",
        };
      },
    );
  });

  mutationOptions(
    quote
      .command("revoke-link <order>")
      .description(
        "revoke the quote PDF download link without voiding the quote",
      )
      .requiredOption("--quote-id <uuid>", "internal commercial quote id"),
    "revoke the quote download link",
  ).action(async (orderRef: string, opts: any, command: Command) => {
    await deps.withContext(
      command,
      "admin receivables quote revoke-link",
      async (ctx) => {
        const order = await ctx.hub.commercialOrders.get({
          id: normalizeOrderReference(orderRef),
          reason: requireReason(opts.reason),
        });
        const request = {
          id: order.id,
          ...commonMutationRequest("quote-revoke-link", order, opts, {
            commercial_quote_id: `${opts.quoteId}`.trim(),
          }),
        };
        if (!opts.commit)
          return preview(
            "quote-revoke-link",
            order,
            request as unknown as JsonObject,
          );
        return await ctx.hub.commercialOrders.revokeQuoteLink(request);
      },
    );
  });

  mutationOptions(
    quote
      .command("void <order>")
      .description("preview or void a previously issued quote")
      .requiredOption("--quote-id <uuid>", "internal commercial quote id"),
    "void the issued commercial quote",
  ).action(async (orderRef: string, opts: any, command: Command) => {
    await deps.withContext(
      command,
      "admin receivables quote void",
      async (ctx) => {
        const order = await ctx.hub.commercialOrders.get({
          id: normalizeOrderReference(orderRef),
          reason: requireReason(opts.reason),
        });
        const request = {
          id: order.id,
          ...commonMutationRequest("quote-void", order, opts, {
            commercial_quote_id: `${opts.quoteId ?? ""}`.trim(),
          }),
        } as CommercialQuoteVoidRequest;
        if (!opts.commit) {
          return preview("quote-void", order, request as unknown as JsonObject);
        }
        return await ctx.hub.commercialOrders.voidQuote(request);
      },
    );
  });
}

async function readPurchaseOrderPdf(path: string): Promise<{
  content: Buffer;
  filename: string;
  sha256: string;
}> {
  const content = await readFile(path);
  if (!content.length || content.length > COMMERCIAL_ORDER_DOCUMENT_MAX_BYTES) {
    throw new Error("purchase order PDF must be between 1 byte and 5 MiB");
  }
  if (content.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("--file must contain a PDF purchase order");
  }
  const filename = basename(path);
  if (!filename.toLowerCase().endsWith(".pdf") || filename.length > 255) {
    throw new Error(
      "--file must have a PDF filename of at most 255 characters",
    );
  }
  return {
    content,
    filename,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function registerDocumentCommands(
  receivables: Command,
  deps: ReceivablesCommandDeps,
) {
  const document = receivables
    .command("document")
    .description("attach and retain procurement documents");

  mutationOptions(
    document
      .command("upload <order>")
      .description("preview or attach an immutable purchase-order PDF")
      .requiredOption("--file <path>", "purchase-order PDF path")
      .option("--reference <text>", "PO number or procurement reference")
      .option("--note <text>", "internal document note"),
    "attach the reviewed purchase-order PDF",
  ).action(async (orderRef: string, opts: any, command: Command) => {
    await deps.withContext(
      command,
      "admin receivables document upload",
      async (ctx) => {
        const reason = requireReason(opts.reason);
        const order = await ctx.hub.commercialOrders.get({
          id: normalizeOrderReference(orderRef),
          reason,
        });
        const pdf = await readPurchaseOrderPdf(opts.file);
        const fields = {
          document_kind: "purchase_order" as const,
          document_filename: pdf.filename,
          content_base64: pdf.content.toString("base64"),
          ...(`${opts.reference ?? ""}`.trim()
            ? { document_reference: `${opts.reference}`.trim() }
            : {}),
          ...(`${opts.note ?? ""}`.trim()
            ? { note: `${opts.note}`.trim() }
            : {}),
        };
        const request = {
          id: order.id,
          ...commonMutationRequest("document-upload", order, opts, fields),
        } as CommercialOrderDocumentUploadRequest;
        if (!opts.commit) {
          const { content_base64: _content, ...reviewedFields } = request;
          return preview(
            "document-upload",
            order,
            reviewedFields as unknown as JsonObject,
            {
              document: {
                path: opts.file,
                bytes: pdf.content.length,
                sha256: pdf.sha256,
              },
              safety:
                "The PDF is retained immutably. A supplied PO reference also fills an empty order PO number and cannot conflict with an existing one.",
            },
          );
        }
        return await ctx.hub.commercialOrders.uploadDocument(request);
      },
    );
  });

  document
    .command("download <order>")
    .description("download and verify an attached procurement document")
    .requiredOption("--document-id <uuid>", "commercial order document id")
    .requiredOption("--output-file <path>", "destination PDF path")
    .option("--force", "replace an existing output file", false)
    .option("--reason <text>", "audit reason for this admin read")
    .action(async (orderRef: string, opts: any, command: Command) => {
      await deps.withContext(
        command,
        "admin receivables document download",
        async (ctx) => {
          const result = await ctx.hub.commercialOrders.downloadDocument({
            id: normalizeOrderReference(orderRef),
            commercial_order_document_id: `${opts.documentId ?? ""}`.trim(),
            reason: readReason(opts.reason, READ_REASONS.orderDocument),
          });
          const content = Buffer.from(result.content_base64, "base64");
          const sha256 = createHash("sha256").update(content).digest("hex");
          if (sha256 !== result.document.document_sha256) {
            throw new Error(
              "downloaded purchase order failed its integrity check",
            );
          }
          await writeFile(opts.outputFile, content, {
            flag: opts.force ? "w" : "wx",
          });
          return {
            document_id: result.document.id,
            reference: result.document.document_reference,
            filename: result.document.document_filename,
            output: opts.outputFile,
            bytes: content.length,
            sha256,
          };
        },
      );
    });

  mutationOptions(
    document
      .command("void <order>")
      .description("preview or void an attached procurement document")
      .requiredOption("--document-id <uuid>", "commercial order document id"),
    "void the purchase-order attachment while retaining its audit trail",
  ).action(async (orderRef: string, opts: any, command: Command) => {
    await deps.withContext(
      command,
      "admin receivables document void",
      async (ctx) => {
        const order = await ctx.hub.commercialOrders.get({
          id: normalizeOrderReference(orderRef),
          reason: requireReason(opts.reason),
        });
        const request = {
          id: order.id,
          ...commonMutationRequest("document-void", order, opts, {
            commercial_order_document_id: `${opts.documentId ?? ""}`.trim(),
          }),
        } as CommercialOrderDocumentVoidRequest;
        if (!opts.commit) {
          return preview(
            "document-void",
            order,
            request as unknown as JsonObject,
          );
        }
        return await ctx.hub.commercialOrders.voidDocument(request);
      },
    );
  });
}

function registerPaymentCommands(
  receivables: Command,
  deps: ReceivablesCommandDeps,
) {
  const payment = receivables
    .command("payment")
    .description("commercial payment operations");
  mutationOptions(
    payment
      .command("record <order>")
      .description("preview or record a reviewed manual payment")
      .requiredOption("--amount <decimal>", "payment amount")
      .requiredOption(
        "--method <method>",
        `payment method: ${COMMERCIAL_PAYMENT_METHODS.join(", ")}`,
      )
      .requiredOption("--reference <text>", "non-sensitive evidence reference")
      .option("--currency <code>", "three-letter currency code", "usd")
      .option("--received-at <iso>", "payment receipt time")
      .option("--invoice-id <uuid>", "specific internal commercial invoice id"),
    "record the manual payment",
  ).action(async (orderRef: string, opts: any, command: Command) => {
    await deps.withContext(
      command,
      "admin receivables payment record",
      async (ctx) => {
        const order = await ctx.hub.commercialOrders.get({
          id: normalizeOrderReference(orderRef),
          reason: requireReason(opts.reason),
        });
        const request = {
          id: order.id,
          ...commonMutationRequest("payment-record", order, opts, {
            ...(`${opts.invoiceId ?? ""}`.trim()
              ? { commercial_invoice_id: `${opts.invoiceId}`.trim() }
              : {}),
            amount: requirePositiveMoney(opts.amount, "--amount"),
            currency: parseCurrency(opts.currency),
            method: parsePaymentMethod(opts.method),
            evidence_reference: `${opts.reference ?? ""}`.trim(),
            ...(opts.receivedAt
              ? { received_at: normalizeIso(opts.receivedAt, "--received-at") }
              : {}),
          }),
        } as CommercialManualPaymentRequest;
        if (!request.evidence_reference) {
          throw new Error("--reference must be non-empty");
        }
        if (!opts.commit) {
          return preview(
            "payment-record",
            order,
            request as unknown as JsonObject,
          );
        }
        return await ctx.hub.commercialOrders.recordManualPayment(request);
      },
    );
  });
}

function registerFulfillmentCommands(
  receivables: Command,
  deps: ReceivablesCommandDeps,
) {
  const fulfillment = receivables
    .command("fulfillment")
    .alias("fulfill")
    .description("commercial site-license fulfillment operations");

  fulfillment
    .command("preview <order>")
    .description("preview site-license fulfillment")
    .option("--reason <text>", "audit reason for this admin read")
    .action(async (order: string, opts: any, command: Command) => {
      await deps.withContext(
        command,
        "admin receivables fulfillment preview",
        async (ctx) =>
          await ctx.hub.commercialOrders.fulfillmentPreview({
            id: normalizeOrderReference(order),
            reason: readReason(opts.reason, READ_REASONS.fulfillmentPreview),
          }),
      );
    });

  mutationOptions(
    fulfillment
      .command("provision <order>")
      .alias("site-license")
      .description("preview or provision the approved site license")
      .option(
        "--allow-before-payment",
        "explicitly allow university fulfillment before collection",
        false,
      )
      .option("--site-license <uuid>", "link this existing site license"),
    "provision or link the approved site license",
  ).action(async (orderRef: string, opts: any, command: Command) => {
    await deps.withContext(
      command,
      "admin receivables fulfillment provision",
      async (ctx) => {
        const reason = requireReason(opts.reason);
        const order = await ctx.hub.commercialOrders.get({
          id: normalizeOrderReference(orderRef),
          reason,
        });
        const request = {
          id: order.id,
          ...commonMutationRequest("fulfillment-provision", order, opts, {
            allow_before_payment: opts.allowBeforePayment || undefined,
            existing_site_license_id:
              `${opts.siteLicense ?? ""}`.trim() || undefined,
          }),
        } as CommercialProvisionRequest;
        if (!opts.commit) {
          return preview(
            "fulfillment-provision",
            order,
            request as unknown as JsonObject,
            {
              fulfillment_preview:
                await ctx.hub.commercialOrders.fulfillmentPreview({
                  id: order.id,
                  reason,
                }),
            },
          );
        }
        return await ctx.hub.commercialOrders.provision(request);
      },
    );
  });

  mutationOptions(
    fulfillment
      .command("end <order>")
      .description("preview or end commercial fulfillment"),
    "end the provisioned commercial fulfillment",
  ).action(async (orderRef: string, opts: any, command: Command) => {
    await deps.withContext(
      command,
      "admin receivables fulfillment end",
      async (ctx) => {
        const order = await ctx.hub.commercialOrders.get({
          id: normalizeOrderReference(orderRef),
          reason: requireReason(opts.reason),
        });
        const request = {
          id: order.id,
          ...commonMutationRequest("fulfillment-end", order, opts),
        };
        if (!opts.commit) return preview("fulfillment-end", order, request);
        return await ctx.hub.commercialOrders.endFulfillment(request);
      },
    );
  });
}

function registerMaintenanceCommands(
  receivables: Command,
  deps: ReceivablesCommandDeps,
) {
  commitOnlyOptions(
    receivables
      .command("retry-stripe-event <event-id>")
      .description("requeue one failed or dead-lettered Stripe event"),
    "requeue the reviewed Stripe event",
  ).action(async (eventId: string, opts: any, command: Command) => {
    await deps.withContext(
      command,
      "admin receivables retry-stripe-event",
      async (ctx) => {
        if (!/^evt_[A-Za-z0-9]+$/.test(eventId)) {
          throw new Error("event-id must be a Stripe event id");
        }
        const base = {
          event_id: eventId,
          reason: requireReason(opts.reason),
          source: "cli" as const,
        };
        const request = {
          ...base,
          idempotency_key: mutationKey(
            "stripe-event-retry",
            base,
            opts.idempotencyKey,
          ),
        };
        if (!opts.commit)
          return preview("stripe-event-retry", undefined, request);
        return await ctx.hub.commercialOrders.retryStripeEvent(request);
      },
    );
  });

  receivables
    .command("export")
    .description("export all receivables pages using stable bookkeeping fields")
    .option("--format <format>", "json or csv", "json")
    .option("--max-rows <n>", "hard export row cap (maximum 10000)", "5000")
    .option("--state <states>", "comma-separated workflow or collection states")
    .option("--needs-action", "exclude completed and cancelled orders", false)
    .option("--stale-before <iso>", "orders last updated before this time")
    .option(
      "--next-action-due-before <iso>",
      "orders whose explicit next action is due before this time",
    )
    .option("--reason <text>", "audit reason for this admin read")
    .action(async (opts: any, command: Command) => {
      await deps.withContext(
        command,
        "admin receivables export",
        async (ctx) => {
          const maxRows = parsePositiveInteger(opts.maxRows, "--max-rows", {
            maximum: 10_000,
          })!;
          const states = parseCombinedStates(opts.state);
          const rows: JsonObject[] = [];
          const seenCursors = new Set<string>();
          let cursor: string | undefined;
          let remainingCursor: string | undefined;
          do {
            const response = await ctx.hub.commercialOrders.list({
              reason: readReason(
                opts.reason,
                "Export commercial receivables for management review",
              ),
              ...states,
              needs_action: opts.needsAction || undefined,
              stale_before: normalizeIso(opts.staleBefore, "--stale-before"),
              next_action_due_before: normalizeIso(
                opts.nextActionDueBefore,
                "--next-action-due-before",
              ),
              cursor,
              limit: Math.min(500, maxRows - rows.length),
              max_bytes: 5_000_000,
            });
            rows.push(...response.orders.map(exportRow));
            remainingCursor = response.next_cursor;
            if (!remainingCursor || rows.length >= maxRows) break;
            if (seenCursors.has(remainingCursor)) {
              throw new Error("server returned a repeated receivables cursor");
            }
            seenCursors.add(remainingCursor);
            cursor = remainingCursor;
          } while (rows.length < maxRows);
          if (remainingCursor && rows.length >= maxRows) {
            throw new Error(
              `export exceeds --max-rows ${maxRows}; raise the bound (maximum 10000) or narrow the filters`,
            );
          }
          return formatExport(rows, `${opts.format ?? "json"}`.toLowerCase());
        },
      );
    });

  receivables
    .command("diagnostics")
    .description(
      "inspect commercial receivables consistency and reconciliation health",
    )
    .option("--reconcile", "request reconciliation-aware diagnostics", false)
    .option("--reason <text>", "audit reason for this admin read")
    .action(async (opts: any, command: Command) => {
      await deps.withContext(
        command,
        "admin receivables diagnostics",
        async (ctx) =>
          await ctx.hub.commercialOrders.diagnostics({
            reason: readReason(opts.reason, READ_REASONS.diagnostics),
            reconcile: opts.reconcile || undefined,
          }),
      );
    });

  commitOnlyOptions(
    receivables
      .command("backfill")
      .description(
        "preview or import legacy orders and historical site-license accounting",
      )
      .requiredOption(
        "--file <path>",
        "JSON candidate array or object with a candidates array",
      )
      .addHelpText(
        "after",
        `
Historical site-license candidates require site_license_id, service dates,
billing_contact, provenance, and invoice. An optional payment creates local
cash history. Preview is the default; --commit requires fresh authentication.
`,
      ),
    "create eligible commercial orders from the backfill",
  ).action(async (opts: any, command: Command) => {
    await deps.withContext(
      command,
      "admin receivables backfill",
      async (ctx) => {
        const input = await readJsonFile(opts.file);
        const candidates = Array.isArray(input)
          ? input
          : requireObject(input, "--file").candidates;
        if (!Array.isArray(candidates)) {
          throw new Error("--file must contain a candidate array");
        }
        if (candidates.length > 500) {
          throw new Error("backfill is limited to 500 candidates");
        }
        const base = {
          candidates,
          reason: requireReason(opts.reason),
          source: "cli" as const,
          commit: !!opts.commit,
        };
        const request: CommercialBackfillRequest = {
          ...base,
          idempotency_key: mutationKey("backfill", base, opts.idempotencyKey),
        } as CommercialBackfillRequest;
        return await ctx.hub.commercialOrders.backfill(request);
      },
    );
  });
}

export function registerReceivablesCommand(
  admin: Command,
  deps: ReceivablesCommandDeps,
): Command {
  const receivables = admin
    .command("receivables")
    .description("shared commercial accounts-receivable operations")
    .addHelpText(
      "after",
      `
Safety workflow:
  1. Run a mutation without --commit and review its order version and request.
  2. Re-run with --expected-version <version>, --reason <audit reason>, and --commit.
  3. Quote, invoice, payment, approval, cancellation, fulfillment, and backfill actions
     never take effect without explicit --commit.

Bundled operations guide:
  cocalc docs show admin/accounts-receivable --include-admin
  cocalc docs search "accounts receivable" --include-admin
  cocalc docs skill-context --query "accounts receivable" --include-admin

Examples:
  cocalc admin receivables list --state ready-to-invoice,overdue --json
  cocalc admin receivables show AR-2026-000123 --json
  cocalc admin receivables quote preview AR-2026-000123
  cocalc admin receivables quote issue AR-2026-000123 --reason "formal quote"
  cocalc admin receivables quote stripe preview AR-2026-000123
  cocalc admin receivables quote stripe create AR-2026-000123 --reason "draft Stripe quote"
  cocalc admin receivables document upload AR-2026-000123 --file PO.pdf \
    --reference PO-123 --reason "attach received purchase order"
  cocalc admin receivables collection mode AR-2026-000123 \
    --mode stripe_invoice --reason "use Stripe hosted invoicing"
  cocalc admin receivables invoice preview AR-2026-000123
  cocalc admin receivables payment record AR-2026-000123 --amount 3900 \\
    --method check --reference CHECK-123 --reason "check deposited"
`,
    );
  registerReadCommands(receivables, deps);
  registerOrderMutationCommands(receivables, deps);
  registerBillingCommands(receivables, deps);
  registerQuoteCommands(receivables, deps);
  registerDocumentCommands(receivables, deps);
  registerInvoiceCommands(receivables, deps);
  registerPaymentCommands(receivables, deps);
  registerFulfillmentCommands(receivables, deps);
  registerMaintenanceCommands(receivables, deps);
  return receivables;
}
