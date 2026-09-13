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
import { billingAuthorityLane } from "./protocol";
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
const DEFAULT_DEDUPLICATION_MS = 15 * 60_000;
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
      key = `commercial:${Math.floor(Date.now() / (5 * 60_000))}`;
      break;
    case "commercial-seed":
      key = recordField(command.request.payload, "idempotency_key");
      break;
    case "http":
      key = recordField(command.input, "idempotency_key");
      break;
    case "account-local":
      key = recordField(command.input, "idempotency_key");
      break;
    case "hub-api":
      key = recordField(command.call.args[0], "idempotency_key");
      break;
  }
  return key
    ? deterministicUuid(`cocalc-billing-authority:${command.kind}:${key}`)
    : undefined;
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
    throw Object.assign(
      new Error(
        "billing is unavailable on attached bays until the authority has a dedicated authenticated transport",
      ),
      { code: 503, status: 503 },
    );
  }
  const { handleBillingAuthorityTransportRequest } = await import("./service");
  return unwrapTransport(await handleBillingAuthorityTransportRequest(request));
}

function throwTerminal(record: BillingAuthorityCommandRecord): never {
  const message =
    record.error?.message ??
    `billing authority command ended with status ${record.status}`;
  const err = new Error(message);
  Object.assign(err, {
    code: record.error?.code,
    status: record.error?.status,
    billing_authority_command_id: record.command_id,
    billing_authority_status: record.status,
  });
  throw err;
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
      deduplicate_for_ms:
        options.deduplicate_for_ms ?? DEFAULT_DEDUPLICATION_MS,
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
    { kind: "http", operation, input },
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
}: {
  account_id: string;
  frozen: boolean;
  reason: string;
  actor_account_id?: string;
}): Promise<{ account_id: string; frozen: boolean; generation: number }> {
  return (await transport({
    action: frozen ? "freeze-account" : "unfreeze-account",
    account_id,
    reason,
    actor_account_id,
  })) as { account_id: string; frozen: boolean; generation: number };
}

export async function getBillingAuthorityStatus(): Promise<BillingAuthorityHealth> {
  return (await transport({ action: "health" })) as BillingAuthorityHealth;
}

export function resetBillingAuthorityClientForTests(): void {
  // Kept for existing callers; the durable client has no process-local RPC cache.
}

export const __test__ = {
  deterministicUuid,
  intrinsicCommandId,
  terminalValue,
};
