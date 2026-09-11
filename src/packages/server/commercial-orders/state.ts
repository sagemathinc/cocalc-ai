/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  COMMERCIAL_COLLECTION_MODES,
  COMMERCIAL_COLLECTION_STATES,
  COMMERCIAL_CONTACT_ROLES,
  COMMERCIAL_EVENT_SOURCES,
  COMMERCIAL_FULFILLMENT_STATES,
  COMMERCIAL_NEXT_ACTIONS,
  COMMERCIAL_PAYMENT_METHODS,
  COMMERCIAL_WORKFLOW_STATES,
  type CommercialCollectionState,
  type CommercialInvoice,
  type CommercialNextAction,
  type CommercialOrder,
  type CommercialWorkflowState,
} from "@cocalc/util/commercial-orders";
import {
  moneyAdd,
  moneyCompare,
  moneyMultiply,
  moneyRoundToCents,
  moneyToDbString,
  toDecimal,
} from "@cocalc/util/money";
import type {
  CommercialOrderContactInput,
  CommercialOrderCreateRequest,
  CommercialOrderItemInput,
} from "@cocalc/conat/hub/api/commercial-orders";
import { commercialTaxPolicy } from "./tax";

const WORKFLOW_TRANSITIONS: Record<
  CommercialWorkflowState,
  ReadonlySet<CommercialWorkflowState>
> = {
  draft: new Set([
    "draft",
    "awaiting_customer",
    "ready_to_invoice",
    "complete",
    "cancelled",
  ]),
  awaiting_customer: new Set([
    "awaiting_customer",
    "draft",
    "ready_to_invoice",
    "complete",
    "cancelled",
  ]),
  ready_to_invoice: new Set([
    "ready_to_invoice",
    "draft",
    "awaiting_customer",
    "awaiting_payment",
    "complete",
    "cancelled",
  ]),
  awaiting_payment: new Set([
    "awaiting_payment",
    "ready_to_invoice",
    "complete",
    "cancelled",
  ]),
  complete: new Set(),
  cancelled: new Set(),
};

export function requireReason(reason: string | undefined): string {
  const value = `${reason ?? ""}`.trim();
  if (value.length < 4) {
    throw Error("an audit reason of at least 4 characters is required");
  }
  if (value.length > 2_000) {
    throw Error("audit reason must be at most 2000 characters");
  }
  return value;
}

export function requireExpectedVersion(
  current: number,
  expected: number | undefined,
): void {
  if (!Number.isInteger(expected) || expected! < 1) {
    throw Error("expected_version is required");
  }
  if (expected !== current) {
    const err = Error(
      `commercial order changed: expected version ${expected}, current version is ${current}`,
    );
    err.name = "CommercialOrderVersionConflict";
    throw err;
  }
}

export function assertWorkflowTransition(
  from: CommercialWorkflowState,
  to: CommercialWorkflowState,
): void {
  if (!WORKFLOW_TRANSITIONS[from]?.has(to)) {
    throw Error(`invalid commercial workflow transition: ${from} -> ${to}`);
  }
}

function assertEnum<T extends string>(
  value: unknown,
  values: readonly T[],
  label: string,
): asserts value is T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw Error(`${label} is invalid`);
  }
}

export function normalizeNextAction(value: unknown): CommercialNextAction {
  const nextAction = `${value ?? ""}`.trim();
  assertEnum(nextAction, COMMERCIAL_NEXT_ACTIONS, "next_action");
  return nextAction;
}

export function normalizeCurrency(currency: string | undefined): string {
  const value = `${currency ?? "usd"}`.trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(value)) {
    throw Error("currency must be a three-letter ISO code");
  }
  if (value !== "usd") {
    throw Error("commercial receivables currently support USD only");
  }
  return value;
}

export function normalizeTimestamp(
  value: string | undefined,
  label: string,
): string | undefined {
  const raw = `${value ?? ""}`.trim();
  if (!raw) return undefined;
  const timestamp = new Date(raw);
  if (!Number.isFinite(timestamp.valueOf())) {
    throw Error(`${label} must be an ISO-8601 timestamp`);
  }
  return timestamp.toISOString();
}

export function normalizeMoney(value: string, label: string): string {
  let amount;
  try {
    amount = toDecimal(value);
  } catch {
    throw Error(`${label} must be an exact decimal amount`);
  }
  if (!Number.isFinite(Number(amount.toString()))) {
    throw Error(`${label} must be finite`);
  }
  const rounded = moneyRoundToCents(amount);
  if (!rounded.eq(amount)) {
    throw Error(`${label} must use no more than two decimal places`);
  }
  return moneyToDbString(rounded);
}

export function normalizePositiveMoney(value: string, label: string): string {
  const normalized = normalizeMoney(value, label);
  if (moneyCompare(normalized, 0) <= 0) {
    throw Error(`${label} must be positive`);
  }
  return normalized;
}

function normalizeItem(
  item: CommercialOrderItemInput,
  position: number,
): CommercialOrderItemInput & { position: number } {
  const description = `${item.description ?? ""}`.trim();
  const productKind = `${item.product_kind ?? ""}`.trim();
  if (!description)
    throw Error(`line item ${position + 1} needs a description`);
  if (!productKind)
    throw Error(`line item ${position + 1} needs a product_kind`);
  const quantity = normalizePositiveMoney(
    `${item.quantity}`,
    `line item ${position + 1} quantity`,
  );
  const unitAmount = normalizePositiveMoney(
    `${item.unit_amount}`,
    `line item ${position + 1} unit_amount`,
  );
  const calculated = moneyToDbString(
    moneyRoundToCents(moneyMultiply(quantity, unitAmount)),
  );
  const subtotal = normalizePositiveMoney(
    `${item.subtotal}`,
    `line item ${position + 1} subtotal`,
  );
  if (moneyCompare(calculated, subtotal) !== 0) {
    throw Error(
      `line item ${position + 1} subtotal ${subtotal} does not equal quantity times unit amount ${calculated}`,
    );
  }
  return {
    ...item,
    position,
    description,
    product_kind: productKind,
    quantity,
    unit_amount: unitAmount,
    subtotal,
    metadata: item.metadata ?? {},
  };
}

export function normalizeItems(
  items: CommercialOrderItemInput[],
  expectedSubtotal: string,
): Array<CommercialOrderItemInput & { position: number }> {
  if (!Array.isArray(items) || items.length === 0) {
    throw Error("at least one line item is required");
  }
  if (items.length > 100) throw Error("at most 100 line items are allowed");
  const normalized = items.map((item, position) =>
    normalizeItem(item, position),
  );
  const sum = normalized.reduce(
    (total, item) => moneyAdd(total, item.subtotal),
    toDecimal(0),
  );
  if (moneyCompare(sum, expectedSubtotal) !== 0) {
    throw Error(
      `line item total ${moneyToDbString(sum)} does not equal agreed_subtotal ${expectedSubtotal}`,
    );
  }
  return normalized;
}

export function normalizeContacts(
  contacts: CommercialOrderContactInput[],
): CommercialOrderContactInput[] {
  if (!Array.isArray(contacts) || contacts.length > 100) {
    throw Error("contacts must contain at most 100 entries");
  }
  return contacts.map((contact, index) => {
    assertEnum(contact.role, COMMERCIAL_CONTACT_ROLES, "contact role");
    const name = `${contact.name_snapshot ?? ""}`.trim();
    const email = `${contact.email_snapshot ?? ""}`.trim().toLowerCase();
    if (!name) throw Error(`contact ${index + 1} needs a name`);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw Error(`contact ${index + 1} needs a valid email address`);
    }
    return { ...contact, name_snapshot: name, email_snapshot: email };
  });
}

export function assertInvoiceTermsSnapshot(
  termsSnapshot: Record<string, unknown> | undefined,
): void {
  const value = termsSnapshot?.invoice;
  if (value == null) return;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw Error("terms_snapshot.invoice must be an object");
  }
  const invoice = value as Record<string, unknown>;
  commercialTaxPolicy(termsSnapshot);
  if (
    invoice.memo != null &&
    (typeof invoice.memo !== "string" || invoice.memo.trim().length > 1_000)
  ) {
    throw Error("invoice memo must be a string of at most 1000 characters");
  }
  if (invoice.billing_address == null) return;
  if (
    typeof invoice.billing_address !== "object" ||
    Array.isArray(invoice.billing_address)
  ) {
    throw Error("invoice billing_address must be an object");
  }
  const allowed = new Set([
    "line1",
    "line2",
    "city",
    "state",
    "postal_code",
    "country",
  ]);
  for (const [field, entry] of Object.entries(invoice.billing_address)) {
    if (!allowed.has(field)) {
      throw Error(`invoice billing address field ${field} is not supported`);
    }
    if (typeof entry !== "string" || entry.trim().length > 240) {
      throw Error(
        `invoice billing address field ${field} must be a string of at most 240 characters`,
      );
    }
  }
  const country = (invoice.billing_address as Record<string, unknown>).country;
  if (country != null && !/^[A-Za-z]{2}$/.test(`${country}`)) {
    throw Error("invoice billing address country must be a two-letter code");
  }
}

export function normalizeCreateRequest(opts: CommercialOrderCreateRequest) {
  const organizationName = `${opts.organization_name ?? ""}`.trim();
  const nextAction = normalizeNextAction(opts.next_action);
  const workflowState = opts.workflow_state ?? "draft";
  const nextActionDueAt = normalizeTimestamp(
    opts.next_action_due_at,
    "next_action_due_at",
  );
  if (!organizationName) throw Error("organization_name is required");
  if (!["complete", "cancelled"].includes(workflowState) && !nextActionDueAt) {
    throw Error("next_action_due_at is required for an open commercial order");
  }
  assertEnum(workflowState, COMMERCIAL_WORKFLOW_STATES, "workflow_state");
  assertInvoiceTermsSnapshot(opts.terms_snapshot);
  if (!["draft", "awaiting_customer"].includes(workflowState)) {
    throw Error(
      "new commercial orders must start in draft or awaiting_customer",
    );
  }
  assertEnum(
    opts.collection_mode ?? "stripe_invoice",
    COMMERCIAL_COLLECTION_MODES,
    "collection_mode",
  );
  const subtotal = normalizePositiveMoney(
    `${opts.agreed_subtotal}`,
    "agreed_subtotal",
  );
  const total = normalizePositiveMoney(
    `${opts.agreed_total ?? opts.agreed_subtotal}`,
    "agreed_total",
  );
  if (moneyCompare(total, subtotal) < 0) {
    throw Error("agreed_total must not be less than agreed_subtotal");
  }
  return {
    organization_name: organizationName,
    next_action: nextAction,
    next_action_due_at: nextActionDueAt,
    workflow_state: workflowState,
    collection_mode: opts.collection_mode ?? "stripe_invoice",
    currency: normalizeCurrency(opts.currency),
    agreed_subtotal: subtotal,
    agreed_total: total,
    items: normalizeItems(opts.items, subtotal),
    contacts: normalizeContacts(opts.contacts),
  };
}

export function validateIndependentStates(order: CommercialOrder): void {
  assertEnum(
    order.workflow_state,
    COMMERCIAL_WORKFLOW_STATES,
    "workflow_state",
  );
  assertEnum(
    order.collection_state,
    COMMERCIAL_COLLECTION_STATES,
    "collection_state",
  );
  assertEnum(
    order.fulfillment_state,
    COMMERCIAL_FULFILLMENT_STATES,
    "fulfillment_state",
  );
  assertEnum(
    order.collection_mode,
    COMMERCIAL_COLLECTION_MODES,
    "collection_mode",
  );
  normalizeNextAction(order.next_action);
  if (
    !["complete", "cancelled"].includes(order.workflow_state) &&
    !order.next_action.trim()
  ) {
    throw Error("an open commercial order requires a next action");
  }
  if (
    !["complete", "cancelled"].includes(order.workflow_state) &&
    !order.next_action_due_at
  ) {
    throw Error("an open commercial order requires a next-action due date");
  }
}

export function invoiceCollectionState(
  invoice: Pick<
    CommercialInvoice,
    "status" | "amount_due" | "amount_paid" | "due_at"
  >,
  now = new Date(),
): CommercialCollectionState {
  if (invoice.status === "draft" || invoice.status === "creating") {
    return "draft_invoice";
  }
  if (invoice.status === "paid") return "paid";
  if (invoice.status === "void") return "void";
  if (invoice.status === "uncollectible") return "uncollectible";
  if (moneyCompare(invoice.amount_paid, 0) > 0) return "partially_paid";
  if (
    invoice.status === "open" &&
    invoice.due_at &&
    new Date(invoice.due_at).getTime() < now.getTime() &&
    moneyCompare(invoice.amount_due, 0) > 0
  ) {
    return "overdue";
  }
  return invoice.status === "open" ? "open" : "not_invoiced";
}

export function collectionSatisfied(order: CommercialOrder): boolean {
  return (
    order.collection_mode === "complimentary" ||
    order.collection_state === "paid" ||
    order.collection_state === "waived"
  );
}

export function fulfillmentSatisfied(order: CommercialOrder): boolean {
  const required = order.terms_snapshot.fulfillment_required !== false;
  return (
    !required || ["provisioned", "ended"].includes(order.fulfillment_state)
  );
}

export function shouldComplete(order: CommercialOrder): boolean {
  return collectionSatisfied(order) && fulfillmentSatisfied(order);
}

export function assertInvoiceReady(order: CommercialOrder): void {
  if (order.collection_mode !== "stripe_invoice") {
    throw Error("collection_mode must be stripe_invoice");
  }
  if (!order.approved_at || !order.approved_by_account_id) {
    throw Error("the commercial order must be approved before invoicing");
  }
  if (order.workflow_state === "cancelled") {
    throw Error("a cancelled commercial order cannot be invoiced");
  }
  if (moneyCompare(order.agreed_total, 0) <= 0) {
    throw Error("the invoice total must be positive");
  }
  if (!order.items.length) throw Error("the order has no line items");
  if (order.contacts.filter(({ role }) => role === "billing").length !== 1) {
    throw Error("the order must have exactly one billing contact");
  }
}

export function assertProviderMutationEnums(opts: {
  source?: string;
  method?: string;
}): void {
  if (opts.source != null) {
    assertEnum(opts.source, COMMERCIAL_EVENT_SOURCES, "event source");
  }
  if (opts.method != null) {
    assertEnum(opts.method, COMMERCIAL_PAYMENT_METHODS, "payment method");
  }
}
