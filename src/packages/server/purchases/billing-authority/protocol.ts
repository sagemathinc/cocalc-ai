/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

export type BillingAuthorityHttpOperation =
  | "admin-purchase"
  | "cancel-payment-intent"
  | "cancel-subscription"
  | "create-payment-intent"
  | "create-refund"
  | "create-setup-intent"
  | "create-subscription-payment"
  | "delete-payment-method"
  | "get-billing-readiness"
  | "get-checkout-session"
  | "get-customer"
  | "get-customer-session"
  | "get-invoice"
  | "get-invoice-url"
  | "get-open-payments"
  | "get-payment-intent-account-id"
  | "get-payment-method"
  | "get-payment-methods"
  | "get-payments"
  | "get-unpaid-invoices"
  | "membership-change"
  | "process-payment-intents"
  | "renew-subscription"
  | "resume-subscription"
  | "set-customer"
  | "set-default-payment-method";

export type BillingAuthorityMaintenanceTask =
  | "monthly-collections"
  | "credit-transfers"
  | "provider-refunds"
  | "automatic-payments"
  | "auto-balance"
  | "payment-intents"
  | "statements"
  | "subscriptions"
  | "team-licenses";

export type BillingAuthorityCommercialMaintenanceTask =
  | "invoices"
  | "quotes"
  | "stripe-events";

export type BillingAuthorityAccountLocalOperation =
  | "apply-funding-approval"
  | "admin-create-membership-package-purchase"
  | "admin-provision-site-license"
  | "legacy-apply-financial-home-bay"
  | "legacy-apply-financial-migration"
  | "legacy-configure-financial-renewal-home-bay"
  | "purchase-team-license-change";

export interface BillingAuthorityHubApiCall {
  name: string;
  args: unknown[];
  account_id?: string;
  auth_session_hash?: string | null;
  project_id?: string;
  host_id?: string;
  auth_actor?: string;
  auth_token_fingerprint?: string;
  auth_iat_s?: number;
  auth_exp_s?: number;
}

export type BillingAuthorityCommand =
  | { kind: "account-stripe-cleanup"; account_id: string }
  | {
      kind: "account-local";
      operation: BillingAuthorityAccountLocalOperation;
      input: Record<string, unknown>;
      actor_account_id?: string;
    }
  | { kind: "cancel-usage-subscription"; account_id: string }
  | { kind: "quarantine-account-stripe-cleanup"; account_id: string }
  | {
      kind: "quarantine-stripe-resources";
      account_id: string;
      action: "cancel-payment-intents" | "detach-payment-methods";
    }
  | {
      kind: "commercial-maintenance";
      task: BillingAuthorityCommercialMaintenanceTask;
    }
  | {
      kind: "commercial-seed";
      request: {
        action: string;
        actor_account_id: string;
        payload: Record<string, unknown>;
      };
    }
  | {
      kind: "http";
      operation: BillingAuthorityHttpOperation;
      input: Record<string, unknown>;
      actor_account_id?: string;
    }
  | { kind: "hub-api"; call: BillingAuthorityHubApiCall }
  | { kind: "maintenance"; task: BillingAuthorityMaintenanceTask }
  | {
      kind: "reconcile-legacy-credit";
      source:
        | { kind: "paid-invoices"; account_id: string }
        | { kind: "payment-intent"; payment_intent_id: string };
    }
  | { kind: "stripe-webhook"; event: unknown };

export type BillingAuthorityLane = "critical" | "interactive" | "maintenance";

export type BillingAuthorityCommandStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled"
  | "expired"
  | "uncertain";

export interface BillingAuthorityError {
  message: string;
  code?: number | string;
  status?: number;
}

export interface BillingAuthoritySubmitRequest {
  command_id: string;
  command: BillingAuthorityCommand;
  expires_at: string;
  deduplicate_for_ms?: number;
}

export type BillingAuthorityFenceCause =
  | "ban"
  | "deletion"
  | "incident-response"
  | "operator"
  | "quarantine";

export interface BillingAuthorityCommandRecord {
  command_id: string;
  operation: string;
  lane: BillingAuthorityLane;
  account_id?: string;
  account_ids?: string[];
  actor_account_id?: string;
  status: BillingAuthorityCommandStatus;
  result?: unknown;
  error?: BillingAuthorityError;
  created_at: string;
  updated_at: string;
  started_at?: string;
  finished_at?: string;
  expires_at: string;
  authority_generation?: number;
  reused?: boolean;
}

export interface BillingAuthorityHealth {
  instance_id?: string;
  generation?: number;
  lease_until?: string;
  ready: boolean;
  enabled: boolean;
  draining: boolean;
  active_command_id?: string;
  queue_depth: Record<BillingAuthorityLane, number>;
  completed: number;
  failed: number;
}

export type BillingAuthorityTransportRequest =
  | { action: "submit"; request: BillingAuthoritySubmitRequest }
  | { action: "status"; command_id: string }
  | { action: "cancel"; command_id: string }
  | {
      action: "freeze-account";
      account_id: string;
      cause: BillingAuthorityFenceCause;
      reason: string;
      actor_account_id?: string;
    }
  | {
      action: "unfreeze-account";
      account_id: string;
      cause: BillingAuthorityFenceCause;
      reason: string;
      actor_account_id?: string;
    }
  | { action: "health" };

export type BillingAuthorityTransportResponse =
  | { ok: true; value: unknown }
  | { ok: false; error: BillingAuthorityError };

export function billingAuthorityOperationName(
  command: BillingAuthorityCommand,
): string {
  switch (command.kind) {
    case "account-local":
      return `account-local:${command.operation}`;
    case "http":
      return `http:${command.operation}`;
    case "hub-api":
      return `hub-api:${command.call.name}`;
    case "maintenance":
      return `maintenance:${command.task}`;
    case "commercial-maintenance":
      return `commercial-maintenance:${command.task}`;
    default:
      return command.kind;
  }
}

export function billingAuthorityLane(
  command: BillingAuthorityCommand,
): BillingAuthorityLane {
  switch (command.kind) {
    case "stripe-webhook":
    case "account-stripe-cleanup":
    case "cancel-usage-subscription":
    case "quarantine-account-stripe-cleanup":
    case "quarantine-stripe-resources":
    case "reconcile-legacy-credit":
      return "critical";
    case "maintenance":
    case "commercial-maintenance":
      return "maintenance";
    default:
      return "interactive";
  }
}

function stringField(
  value: unknown,
  names: readonly string[],
): string | undefined {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const name of names) {
    const candidate = `${record[name] ?? ""}`.trim().toLowerCase();
    if (candidate) return candidate;
  }
  return undefined;
}

function stringFields(value: unknown, names: readonly string[]): string[] {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const record = value as Record<string, unknown>;
  return names
    .map((name) => `${record[name] ?? ""}`.trim().toLowerCase())
    .filter(Boolean);
}

function metadata(value: unknown): unknown {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return (value as Record<string, unknown>).metadata;
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => !!value))];
}

export function billingAuthorityActorAccountId(
  command: BillingAuthorityCommand,
): string | undefined {
  switch (command.kind) {
    case "http":
    case "account-local":
      return stringField(command, ["actor_account_id"]);
    case "hub-api":
      return stringField(command.call, ["account_id"]);
    case "commercial-seed":
      return command.request.actor_account_id.trim().toLowerCase();
    default:
      return undefined;
  }
}

export function billingAuthorityAccountIds(
  command: BillingAuthorityCommand,
): string[] {
  const values: Array<string | undefined> = [];
  switch (command.kind) {
    case "account-stripe-cleanup":
    case "cancel-usage-subscription":
    case "quarantine-account-stripe-cleanup":
    case "quarantine-stripe-resources":
      values.push(command.account_id);
      break;
    case "reconcile-legacy-credit":
      if (command.source.kind === "paid-invoices") {
        values.push(command.source.account_id);
      }
      break;
    case "http":
    case "account-local":
      values.push(
        ...stringFields(command.input, [
          "user_account_id",
          "payer_account_id",
          "recipient_account_id",
          "customer_account_id",
          "owner_account_id",
          "target_account_id",
          "account_id",
        ]),
      );
      break;
    case "hub-api":
      values.push(
        ...stringFields(command.call.args[0], [
          "user_account_id",
          "customer_account_id",
          "owner_account_id",
          "target_account_id",
          "account_id",
        ]),
      );
      break;
    case "commercial-seed":
      values.push(
        ...stringFields(command.request.payload, [
          "user_account_id",
          "customer_account_id",
          "owner_account_id",
          "account_id",
        ]),
      );
      break;
    case "stripe-webhook": {
      const object = (command.event as any)?.data?.object;
      const metadataSources = [
        object?.metadata,
        object?.parent?.invoice_details?.metadata,
        object?.parent?.subscription_details?.metadata,
        object?.subscription_details?.metadata,
        ...(Array.isArray(object?.lines?.data)
          ? object.lines.data.map((line: unknown) => metadata(line))
          : []),
      ];
      for (const source of metadataSources) {
        values.push(...stringFields(source, ["account_id"]));
      }
      break;
    }
  }
  values.push(billingAuthorityActorAccountId(command));
  return unique(values);
}

export function billingAuthorityAccountId(
  command: BillingAuthorityCommand,
): string | undefined {
  return billingAuthorityAccountIds(command)[0];
}

export function billingAuthorityAccountsAllowedWhenFrozen(
  command: BillingAuthorityCommand,
): string[] {
  switch (command.kind) {
    case "account-stripe-cleanup":
    case "cancel-usage-subscription":
    case "quarantine-account-stripe-cleanup":
    case "quarantine-stripe-resources":
      return [command.account_id];
    default:
      return [];
  }
}

export function billingAuthorityCommandAllowedWhenFrozen(
  command: BillingAuthorityCommand,
): boolean {
  return (
    command.kind === "account-stripe-cleanup" ||
    command.kind === "cancel-usage-subscription" ||
    command.kind === "quarantine-account-stripe-cleanup" ||
    command.kind === "quarantine-stripe-resources"
  );
}
