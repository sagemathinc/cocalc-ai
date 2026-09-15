/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createHash, randomUUID } from "node:crypto";

import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  getConfiguredClusterRole,
  getConfiguredClusterSeedBayId,
} from "@cocalc/server/cluster-config";

import {
  enableStripeMutationAuthorityEnforcement,
  isInBillingAuthorityContext,
} from "./context";
import { isBillingAuthorityEnabled } from "./config";
import { dispatchBillingAuthorityCommand } from "./dispatch";
import type {
  BillingAuthorityCommand,
  BillingAuthorityCommandRecord,
  BillingAuthorityHealth,
  BillingAuthorityHttpOperation,
  BillingAuthorityHubApiCall,
  BillingAuthorityTransportRequest,
  BillingAuthorityTransportResponse,
} from "./protocol";
import {
  billingAuthorityAccountIds,
  billingAuthorityActorAccountId,
  billingAuthorityLane,
  billingAuthorityOperationName,
  type BillingAuthorityFenceCause,
} from "./protocol";
export {
  isBillingAuthorityHubApiCall,
  isBillingAuthorityHubApiRead,
  isBillingAuthorityHttpRead,
} from "./classification";
import {
  isBillingAuthorityHubApiRead,
  isBillingAuthorityHttpRead,
} from "./classification";

const POLL_MS = 250;
const REMOTE_POLL_MS = 750;
const COMMAND_WAIT_MS = 10 * 60_000;
const COMMAND_ID_PROTOCOL_VERSION = "v2";
const QUEUE_TTL_MS = {
  critical: 5 * 60_000,
  interactive: 45_000,
  maintenance: 2 * 60_000,
} as const;

interface CommandOptions {
  read?: boolean;
  command_id?: string;
  queue_ttl_ms?: number;
  wait_timeout_ms?: number;
  deduplicate_for_ms?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function isLocalAuthorityBay(): boolean {
  const role = getConfiguredClusterRole();
  return (
    role === "standalone" ||
    (role === "seed" &&
      getConfiguredBayId() === getConfiguredClusterSeedBayId())
  );
}

export function assertBillingAuthorityTopology(): void {
  // Attached bays use the authenticated inter-bay transport. Configuration
  // errors are surfaced when that transport constructs its fabric client.
  if (!isBillingAuthorityEnabled()) return;
}

function deterministicUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function recordField(value: unknown, key: string): string | undefined {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = `${(value as Record<string, unknown>)[key] ?? ""}`.trim();
  return candidate || undefined;
}

function trustedHttpActorAccountId(
  input: Record<string, unknown>,
): string | undefined {
  return (
    recordField(input, "actor_account_id") ?? recordField(input, "account_id")
  );
}

function intrinsicCommandId(
  command: BillingAuthorityCommand,
): string | undefined {
  let key: string | undefined;
  switch (command.kind) {
    case "stripe-webhook":
      key = recordField(command.event, "id");
      break;
    case "reconcile-legacy-credit":
      key =
        command.source.kind === "paid-invoices"
          ? `paid-invoices:${command.source.account_id}`
          : `payment-intent:${command.source.payment_intent_id}`;
      break;
    case "maintenance":
      key = `${command.task}:${Math.floor(Date.now() / (5 * 60_000))}`;
      break;
    case "commercial-maintenance":
      key = `commercial:${command.task}:${Math.floor(Date.now() / 10_000)}`;
      break;
    case "commercial-seed":
      key = recordField(command.request.payload, "idempotency_key");
      break;
    case "http":
      key = recordField(command.input, "idempotency_key");
      break;
    case "account-local":
      key = recordField(command.input, "idempotency_key");
      if (command.operation === "apply-funding-approval") {
        // Bind retries to both the reviewed intent and independent sign-in.
        // A new sign-in must not reuse a prior session's failed authorization.
        key = JSON.stringify([
          command.input.intent_id,
          command.input.terms_hash,
          command.input.approved_session_hash,
        ]);
      }
      break;
    case "hub-api":
      key = recordField(command.call.args[0], "idempotency_key");
      break;
  }
  if (!key) return undefined;
  const operation = billingAuthorityOperationName(command);
  const accountIds = billingAuthorityAccountIds(command).sort().join(",");
  const actor = billingAuthorityActorAccountId(command) ?? "-";
  return deterministicUuid(
    `cocalc-billing-authority:${COMMAND_ID_PROTOCOL_VERSION}:${operation}:${accountIds}:${actor}:${key}`,
  );
}

function unwrapTransport(response: BillingAuthorityTransportResponse): unknown {
  if (response.ok) return response.value;
  const err = new Error(response.error.message);
  Object.assign(err, {
    code: response.error.code,
    status: response.error.status,
  });
  throw err;
}

async function transport(
  request: BillingAuthorityTransportRequest,
): Promise<unknown> {
  if (!isLocalAuthorityBay()) {
    const { callSeedBillingAuthority } = await import("./inter-bay");
    return unwrapTransport(await callSeedBillingAuthority(request));
  }
  const { handleBillingAuthorityTransportRequest } = await import("./service");
  return unwrapTransport(await handleBillingAuthorityTransportRequest(request));
}

function throwTerminal(record: BillingAuthorityCommandRecord): never {
  const detail =
    record.error?.message ??
    `billing authority command ended with status ${record.status}`;
  const message = `${detail} [billing authority command ${record.command_id}; status ${record.status}]`;
  const err = new Error(message);
  Object.assign(err, {
    code: record.error?.code,
    status: record.error?.status,
    billing_authority_command_id: record.command_id,
    billing_authority_status: record.status,
  });
  throw err;
}

export function billingAuthorityErrorAttrs(
  error: unknown,
): Record<string, unknown> {
  const source =
    error != null && typeof error === "object"
      ? (error as Record<string, unknown>)
      : {};
  return Object.fromEntries(
    ["billing_authority_command_id", "billing_authority_status"].flatMap(
      (key) => (source[key] == null ? [] : [[key, source[key]]]),
    ),
  );
}

function terminalValue<T>(
  record: BillingAuthorityCommandRecord,
): { terminal: false } | { terminal: true; value: T } {
  if (record.status === "succeeded") {
    return { terminal: true, value: record.result as T };
  }
  if (["failed", "canceled", "expired", "uncertain"].includes(record.status)) {
    throwTerminal(record);
  }
  return { terminal: false };
}

export async function getBillingAuthorityCommandOutcome(
  command_id: string,
): Promise<BillingAuthorityCommandRecord | undefined> {
  return ((await transport({ action: "status", command_id })) ?? undefined) as
    | BillingAuthorityCommandRecord
    | undefined;
}

export async function executeBillingAuthorityCommand<T>(
  command: BillingAuthorityCommand,
  options: CommandOptions = {},
): Promise<T> {
  if (!isBillingAuthorityEnabled()) {
    return (await dispatchBillingAuthorityCommand(command)) as T;
  }
  enableStripeMutationAuthorityEnforcement();
  if (isInBillingAuthorityContext()) {
    return (await dispatchBillingAuthorityCommand(command)) as T;
  }
  if (options.read && isLocalAuthorityBay()) {
    return (await dispatchBillingAuthorityCommand(command)) as T;
  }
  const lane = billingAuthorityLane(command);
  let command_id =
    options.command_id ?? intrinsicCommandId(command) ?? randomUUID();
  const expires_at = new Date(
    Date.now() + (options.queue_ttl_ms ?? QUEUE_TTL_MS[lane]),
  ).toISOString();
  let record = (await transport({
    action: "submit",
    request: {
      command_id,
      command,
      expires_at,
      deduplicate_for_ms: options.deduplicate_for_ms ?? 0,
    },
  })) as BillingAuthorityCommandRecord;
  // Semantic deduplication may bind this invocation to an earlier command ID.
  command_id = record.command_id;
  const initial = terminalValue<T>(record);
  if (initial.terminal) return initial.value;

  const deadline = Date.now() + (options.wait_timeout_ms ?? COMMAND_WAIT_MS);
  while (Date.now() < deadline) {
    await delay(isLocalAuthorityBay() ? POLL_MS : REMOTE_POLL_MS);
    const current = await getBillingAuthorityCommandOutcome(command_id);
    if (!current) {
      throw Object.assign(new Error("billing authority lost durable command"), {
        code: 503,
        status: 503,
        billing_authority_command_id: command_id,
      });
    }
    record = current;
    const outcome = terminalValue<T>(record);
    if (outcome.terminal) return outcome.value;
  }

  const canceled = (await transport({
    action: "cancel",
    command_id,
  })) as BillingAuthorityCommandRecord | undefined;
  if (canceled && canceled.status !== "running") {
    throwTerminal(canceled);
  }
  throw Object.assign(
    new Error(
      `billing authority outcome is uncertain; inspect command ${command_id} before retrying`,
    ),
    {
      code: "billing_authority_outcome_uncertain",
      status: 504,
      billing_authority_command_id: command_id,
    },
  );
}

export async function executeBillingHttpCommand<T>(
  operation: BillingAuthorityHttpOperation,
  input: Record<string, unknown>,
  options: Omit<CommandOptions, "read"> = {},
): Promise<T> {
  return await executeBillingAuthorityCommand<T>(
    {
      kind: "http",
      operation,
      input,
      actor_account_id: trustedHttpActorAccountId(input),
    },
    { ...options, read: isBillingAuthorityHttpRead(operation) },
  );
}

export async function executeBillingHubApiCall<T>(
  call: BillingAuthorityHubApiCall,
  options: Omit<CommandOptions, "read"> = {},
): Promise<T> {
  return await executeBillingAuthorityCommand<T>(
    { kind: "hub-api", call },
    { ...options, read: isBillingAuthorityHubApiRead(call.name) },
  );
}

export async function setBillingAccountFrozen({
  account_id,
  frozen,
  reason,
  actor_account_id,
  cause,
}: {
  account_id: string;
  frozen: boolean;
  reason: string;
  actor_account_id?: string;
  cause?: BillingAuthorityFenceCause;
}): Promise<{ account_id: string; frozen: boolean; generation: number }> {
  if (!isBillingAuthorityEnabled()) {
    return { account_id, frozen, generation: 0 };
  }
  return (await transport({
    action: frozen ? "freeze-account" : "unfreeze-account",
    account_id,
    cause: cause ?? inferFenceCause(reason),
    reason,
    actor_account_id,
  })) as { account_id: string; frozen: boolean; generation: number };
}

function inferFenceCause(reason: string): BillingAuthorityFenceCause {
  const value = `${reason}`.toLowerCase();
  if (value.includes("delet")) return "deletion";
  if (value.includes("ban")) return "ban";
  if (value.includes("quarant")) return "quarantine";
  if (value.includes("incident")) return "incident-response";
  return "operator";
}

export async function getBillingAuthorityStatus(): Promise<BillingAuthorityHealth> {
  if (!isBillingAuthorityEnabled()) {
    return {
      ready: false,
      enabled: false,
      draining: true,
      queue_depth: { critical: 0, interactive: 0, maintenance: 0 },
      completed: 0,
      failed: 0,
    };
  }
  return (await transport({ action: "health" })) as BillingAuthorityHealth;
}

export function resetBillingAuthorityClientForTests(): void {
  // Kept for existing callers; the durable client has no process-local RPC cache.
}

export const __test__ = {
  deterministicUuid,
  intrinsicCommandId,
  terminalValue,
  trustedHttpActorAccountId,
};
