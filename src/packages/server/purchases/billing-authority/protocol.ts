/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

export const BILLING_AUTHORITY_SUBJECT =
  "internal.billing-authority.v1" as const;

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
  | {
      kind: "account-stripe-cleanup";
      account_id: string;
    }
  | {
      kind: "cancel-usage-subscription";
      account_id: string;
    }
  | {
      kind: "quarantine-stripe-resources";
      account_id: string;
      action: "cancel-payment-intents" | "detach-payment-methods";
    }
  | {
      kind: "commercial-maintenance";
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
    }
  | {
      kind: "hub-api";
      call: BillingAuthorityHubApiCall;
    }
  | {
      kind: "maintenance";
      task: BillingAuthorityMaintenanceTask;
    }
  | {
      kind: "reconcile-legacy-credit";
      source:
        | { kind: "paid-invoices"; account_id: string }
        | { kind: "payment-intent"; payment_intent_id: string };
    }
  | {
      kind: "stripe-webhook";
      event: unknown;
    };

export interface BillingAuthorityRequest {
  request_id: string;
  command: BillingAuthorityCommand;
}

export interface BillingAuthorityError {
  message: string;
  code?: number | string;
  status?: number;
}

export type BillingAuthorityResponse =
  | { ok: true; value: unknown }
  | { ok: false; error: BillingAuthorityError };

export interface BillingAuthorityHealth {
  pid: number;
  started_at: string;
  active: boolean;
  queue_depth: number;
  completed: number;
  failed: number;
}

export interface BillingAuthorityApi {
  executeCommand: (
    request: BillingAuthorityRequest,
  ) => Promise<BillingAuthorityResponse>;
  executeRead: (
    request: BillingAuthorityRequest,
  ) => Promise<BillingAuthorityResponse>;
  health: () => Promise<BillingAuthorityHealth>;
}

export function billingAuthorityOperationName(
  command: BillingAuthorityCommand,
): string {
  switch (command.kind) {
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
