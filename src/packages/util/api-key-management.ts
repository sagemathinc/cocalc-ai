/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { isValidUUID } from "./misc";

// This contract does not enable a capability or authorize execution.
export const API_KEY_ACTION_TTL_MS = 5 * 60 * 1000;
export const MAX_PENDING_API_KEY_ACTIONS = 20;

export interface RevokeApiKeyAction {
  kind: "revoke_api_key";
  target_key_id: string;
}

export interface ApiKeyActionRequest {
  request_id: string;
  action: RevokeApiKeyAction;
}

// Supplied only by the authenticated API gateway over trusted bay transport.
export interface ApiKeyActionPrincipal {
  account_id: string;
  api_key_id: number;
  key_id: string;
  scope_revision?: number;
  auth_method: "api_key";
}

export interface ApiKeyActionDecision {
  account_id: string;
  session_hash: string;
  reviewed: ApiKeyActionReview;
  decision: "reject" | "execute";
}

export interface ApiKeyActionBinding {
  account_id: string;
  requesting_key_id: string;
  requesting_scope_revision: number;
  target_key_id: string;
  target_scope_revision: number;
}

export interface ApiKeyActionReview {
  request_id: string;
  action: RevokeApiKeyAction;
  binding: ApiKeyActionBinding;
  target_name: string;
  target_trunc: string;
  created_at: number;
  expires_at: number;
  status: "pending" | "rejected" | "executed";
}

function object(
  input: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("API key action must be an object");
  }
  if (Object.keys(input).some((key) => !fields.includes(key))) {
    throw new Error("unknown API key action field");
  }
  return input as Record<string, unknown>;
}

function keyId(input: unknown): string {
  if (typeof input !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(input)) {
    throw new Error("invalid API key lookup id");
  }
  return input;
}

function revision(input: unknown): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1) {
    throw new Error("invalid API key scope revision");
  }
  return input;
}

export function normalizeApiKeyActionRequest(
  input: unknown,
): ApiKeyActionRequest {
  const request = object(input, ["request_id", "action"]);
  if (
    typeof request.request_id !== "string" ||
    !isValidUUID(request.request_id)
  ) {
    throw new Error("invalid API key action request id");
  }
  const action = object(request.action, ["kind", "target_key_id"]);
  if (action.kind !== "revoke_api_key") {
    throw new Error("unsupported API key action");
  }
  return {
    request_id: request.request_id,
    action: {
      kind: "revoke_api_key",
      target_key_id: keyId(action.target_key_id),
    },
  };
}

// Called with server-resolved identities and current database revisions, never
// values supplied by the requester or approving browser.
export function normalizeApiKeyActionBinding(
  input: unknown,
): ApiKeyActionBinding {
  const binding = object(input, [
    "account_id",
    "requesting_key_id",
    "requesting_scope_revision",
    "target_key_id",
    "target_scope_revision",
  ]);
  if (
    typeof binding.account_id !== "string" ||
    !isValidUUID(binding.account_id)
  ) {
    throw new Error("invalid API key action owner");
  }
  const requesting_key_id = keyId(binding.requesting_key_id);
  const target_key_id = keyId(binding.target_key_id);
  if (requesting_key_id === target_key_id) {
    throw new Error("API key management requests cannot target their own key");
  }
  return {
    account_id: binding.account_id,
    requesting_key_id,
    requesting_scope_revision: revision(binding.requesting_scope_revision),
    target_key_id,
    target_scope_revision: revision(binding.target_scope_revision),
  };
}

export function apiKeyActionExpiresAt(
  now: number,
  parentExpiresAt?: number,
): number {
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(now + API_KEY_ACTION_TTL_MS)
  ) {
    throw new Error("invalid API key action time");
  }
  if (
    parentExpiresAt != null &&
    (!Number.isSafeInteger(parentExpiresAt) || parentExpiresAt <= now)
  ) {
    throw new Error("requesting API key has expired");
  }
  return Math.min(now + API_KEY_ACTION_TTL_MS, parentExpiresAt ?? Infinity);
}
