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
  | "automatic-payments"
  | "auto-balance"
  | "payment-intents"
  | "statements"
  | "subscriptions"
  | "team-licenses";

export type BillingAuthorityAccountLocalOperation =
  | "admin-create-membership-package-purchase"
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
    }
  | { kind: "cancel-usage-subscription"; account_id: string }
  | { kind: "quarantine-account-stripe-cleanup"; account_id: string }
  | {
      kind: "quarantine-stripe-resources";
      account_id: string;
      action: "cancel-payment-intents" | "detach-payment-methods";
    }
  | { kind: "commercial-maintenance" }
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

export interface BillingAuthorityCommandRecord {
  command_id: string;
  operation: string;
  lane: BillingAuthorityLane;
  account_id?: string;
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
      reason: string;
      actor_account_id?: string;
    }
  | {
      action: "unfreeze-account";
      account_id: string;
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

export function billingAuthorityAccountId(
  command: BillingAuthorityCommand,
): string | undefined {
  switch (command.kind) {
    case "account-stripe-cleanup":
    case "cancel-usage-subscription":
    case "quarantine-account-stripe-cleanup":
    case "quarantine-stripe-resources":
      return command.account_id;
    case "reconcile-legacy-credit":
      return command.source.kind === "paid-invoices"
        ? command.source.account_id
        : undefined;
    case "http":
      return stringField(command.input, [
        "user_account_id",
        "customer_account_id",
        "owner_account_id",
        "account_id",
      ]);
    case "account-local":
      return stringField(command.input, [
        "user_account_id",
        "customer_account_id",
        "owner_account_id",
        "account_id",
      ]);
    case "hub-api": {
      const explicit = stringField(command.call, ["account_id"]);
      return (
        stringField(command.call.args[0], [
          "user_account_id",
          "customer_account_id",
          "owner_account_id",
          "target_account_id",
          "account_id",
        ]) ?? explicit
      );
    }
    case "commercial-seed":
      return stringField(command.request.payload, [
        "user_account_id",
        "customer_account_id",
        "owner_account_id",
        "account_id",
      ]);
    case "stripe-webhook": {
      const event = command.event as any;
      return stringField(event?.data?.object?.metadata, [
        "account_id",
        "user_account_id",
      ]);
    }
    default:
      return undefined;
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
