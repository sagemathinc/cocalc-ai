/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import getLogger from "@cocalc/backend/logger";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  getConfiguredClusterRole,
  getConfiguredClusterSeedBayId,
} from "@cocalc/server/cluster-config";

import {
  enableStripeMutationAuthorityEnforcement,
  runInBillingAuthorityContext,
} from "./context";
import { dispatchBillingAuthorityCommand } from "./dispatch";
import type {
  BillingAuthorityAccountLocalOperation,
  BillingAuthorityCommand,
  BillingAuthorityError,
  BillingAuthorityHealth,
  BillingAuthorityHttpOperation,
  BillingAuthorityMaintenanceTask,
  BillingAuthoritySubmitRequest,
  BillingAuthorityTransportRequest,
  BillingAuthorityTransportResponse,
} from "./protocol";
import { billingAuthorityOperationName } from "./protocol";
import { isBillingAuthorityHubApiCall } from "./classification";
import {
  acquireBillingAuthorityLease,
  assertBillingAuthorityLease,
  cancelQueuedBillingAuthorityCommand,
  claimNextBillingAuthorityCommand,
  finishBillingAuthorityCommand,
  getBillingAuthorityCommand,
  getBillingAuthorityHealth as getStoredHealth,
  pruneBillingAuthorityCommands,
  reconcileExpiredBillingAuthorityLease,
  requestBillingAuthorityDrain,
  releaseBillingAuthorityLease,
  renewBillingAuthorityLease,
  resumeBillingAuthorityGlobally,
  setBillingAuthorityAccountFrozen,
  submitBillingAuthorityCommand,
} from "./store";

const logger = getLogger("purchases:billing-authority");
const INSTANCE_ID = randomUUID();
const LEASE_MS = 12_000;
const LOCAL_LEASE_MARGIN_MS = 4_000;
const HEARTBEAT_MS = 2_000;
const LEASE_QUERY_TIMEOUT_MS = 2_500;
const IDLE_POLL_MS = 250;
const ELECTION_RETRY_MS = 1_000;
const DRAIN_TIMEOUT_MS = 10 * 60_000;
const COMMAND_RUNTIME_MS = {
  critical: 5 * 60_000,
  interactive: 5 * 60_000,
  maintenance: 2 * 60_000,
} as const;

interface ActiveLease {
  instance_id: string;
  generation: number;
}

interface RuntimeState {
  lease?: ActiveLease;
  local_deadline_ms: number;
  draining: boolean;
  stopping: boolean;
  active_command_id?: string;
}

const runtime: RuntimeState = {
  local_deadline_ms: 0,
  draining: false,
  stopping: false,
};

let started = false;
let electionPromise: Promise<void> | undefined;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function serializeError(err: unknown): BillingAuthorityError {
  const candidate = err as {
    message?: unknown;
    code?: unknown;
    status?: unknown;
  };
  const code =
    typeof candidate?.code === "number" || typeof candidate?.code === "string"
      ? candidate.code
      : undefined;
  const status =
    typeof candidate?.status === "number" ? candidate.status : undefined;
  return {
    message: `${candidate?.message ?? err}`.slice(0, 4000),
    ...(code == null ? {} : { code }),
    ...(status == null ? {} : { status }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "string" && value[key].trim() !== "";
}

const ACCOUNT_LOCAL_OPERATIONS = new Set<BillingAuthorityAccountLocalOperation>(
  [
    "admin-create-membership-package-purchase",
    "legacy-apply-financial-home-bay",
    "legacy-apply-financial-migration",
    "legacy-configure-financial-renewal-home-bay",
    "purchase-team-license-change",
  ],
);

const HTTP_OPERATIONS = new Set<BillingAuthorityHttpOperation>([
  "admin-purchase",
  "cancel-payment-intent",
  "cancel-subscription",
  "create-payment-intent",
  "create-refund",
  "create-setup-intent",
  "create-subscription-payment",
  "delete-payment-method",
  "get-billing-readiness",
  "get-checkout-session",
  "get-customer",
  "get-customer-session",
  "get-invoice",
  "get-invoice-url",
  "get-open-payments",
  "get-payment-intent-account-id",
  "get-payment-method",
  "get-payment-methods",
  "get-payments",
  "get-unpaid-invoices",
  "membership-change",
  "process-payment-intents",
  "renew-subscription",
  "resume-subscription",
  "set-customer",
  "set-default-payment-method",
]);

const MAINTENANCE_TASKS = new Set<BillingAuthorityMaintenanceTask>([
  "automatic-payments",
  "auto-balance",
  "payment-intents",
  "statements",
  "subscriptions",
  "team-licenses",
]);

export function isBillingAuthorityCommand(
  command: unknown,
): command is BillingAuthorityCommand {
  if (!isRecord(command) || typeof command.kind !== "string") return false;
  switch (command.kind) {
    case "account-local":
      return (
        ACCOUNT_LOCAL_OPERATIONS.has(
          command.operation as BillingAuthorityAccountLocalOperation,
        ) && isRecord(command.input)
      );
    case "account-stripe-cleanup":
    case "cancel-usage-subscription":
    case "quarantine-account-stripe-cleanup":
      return hasString(command, "account_id");
    case "quarantine-stripe-resources":
      return (
        hasString(command, "account_id") &&
        (command.action === "cancel-payment-intents" ||
          command.action === "detach-payment-methods")
      );
    case "commercial-maintenance":
      return true;
    case "commercial-seed":
      return (
        isRecord(command.request) &&
        hasString(command.request, "action") &&
        hasString(command.request, "actor_account_id") &&
        isRecord(command.request.payload)
      );
    case "http":
      return (
        HTTP_OPERATIONS.has(
          command.operation as BillingAuthorityHttpOperation,
        ) && isRecord(command.input)
      );
    case "hub-api":
      return (
        isRecord(command.call) &&
        hasString(command.call, "name") &&
        isBillingAuthorityHubApiCall(command.call.name as string) &&
        Array.isArray(command.call.args)
      );
    case "maintenance":
      return MAINTENANCE_TASKS.has(
        command.task as BillingAuthorityMaintenanceTask,
      );
    case "reconcile-legacy-credit":
      if (!isRecord(command.source)) return false;
      return command.source.kind === "paid-invoices"
        ? hasString(command.source, "account_id")
        : command.source.kind === "payment-intent" &&
            hasString(command.source, "payment_intent_id");
    case "stripe-webhook":
      return isRecord(command.event);
    default:
      return false;
  }
}

function isSubmitRequest(
  value: unknown,
): value is BillingAuthoritySubmitRequest {
  if (!isRecord(value)) return false;
  return (
    hasString(value, "command_id") &&
    hasString(value, "expires_at") &&
    isBillingAuthorityCommand(value.command)
  );
}

function assertAuthorityBay(): void {
  const role = getConfiguredClusterRole();
  if (
    role === "attached" ||
    (role === "seed" &&
      getConfiguredBayId() !== getConfiguredClusterSeedBayId())
  ) {
    throw Object.assign(
      new Error("billing authority is seed-bay authoritative"),
      {
        code: 503,
        status: 503,
      },
    );
  }
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("billing authority lease query timed out")),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function authorityLocallyActive(lease: ActiveLease): boolean {
  return (
    runtime.lease?.instance_id === lease.instance_id &&
    runtime.lease?.generation === lease.generation &&
    performance.now() < runtime.local_deadline_ms &&
    !runtime.stopping
  );
}

async function assertAuthorityFenced(lease: ActiveLease): Promise<void> {
  if (!authorityLocallyActive(lease)) {
    throw Object.assign(new Error("billing authority local lease expired"), {
      code: 503,
      status: 503,
    });
  }
  await bounded(assertBillingAuthorityLease(lease), LEASE_QUERY_TIMEOUT_MS);
  if (!authorityLocallyActive(lease)) {
    throw Object.assign(new Error("billing authority local lease expired"), {
      code: 503,
      status: 503,
    });
  }
}

function failStopBillingAuthorityWorker({
  err,
  exit = (code) => process.exit(code),
}: {
  err: unknown;
  exit?: (code: number) => never;
}): never {
  runtime.stopping = true;
  runtime.local_deadline_ms = 0;
  logger.error("billing authority lease safety failed; fail-stopping worker", {
    instance_id: INSTANCE_ID,
    generation: runtime.lease?.generation,
    err,
  });
  return exit(1);
}

async function executeClaimedCommand({
  lease,
  command_id,
  command,
  lane,
}: {
  lease: ActiveLease;
  command_id: string;
  command: BillingAuthorityCommand;
  lane: keyof typeof COMMAND_RUNTIME_MS;
}): Promise<void> {
  runtime.active_command_id = command_id;
  const operation = billingAuthorityOperationName(command);
  const startedAt = Date.now();
  let result: unknown;
  let error: BillingAuthorityError | undefined;
  const commandWatchdog = setTimeout(() => {
    failStopBillingAuthorityWorker({
      err: new Error(
        `billing authority ${lane} command exceeded its runtime bound`,
      ),
    });
  }, COMMAND_RUNTIME_MS[lane]);
  commandWatchdog.unref?.();
  try {
    await assertAuthorityFenced(lease);
    result = await runInBillingAuthorityContext({
      operation,
      request_id: command_id,
      authority_active: () => authorityLocallyActive(lease),
      assert_authority: async () => await assertAuthorityFenced(lease),
      fn: async () => await dispatchBillingAuthorityCommand(command),
    });
  } catch (err) {
    error = serializeError(err);
  }
  try {
    await assertAuthorityFenced(lease);
    await finishBillingAuthorityCommand({
      ...lease,
      command_id,
      ...(error ? { error } : { result }),
    });
    logger[error ? "warn" : "debug"]("billing authority command finished", {
      command_id,
      operation,
      generation: lease.generation,
      duration_ms: Date.now() - startedAt,
      ...(error ? { error } : {}),
    });
  } catch (err) {
    failStopBillingAuthorityWorker({ err });
  } finally {
    clearTimeout(commandWatchdog);
    runtime.active_command_id = undefined;
  }
}

async function processingLoop(lease: ActiveLease): Promise<void> {
  while (authorityLocallyActive(lease)) {
    if (runtime.draining) {
      await delay(IDLE_POLL_MS);
      continue;
    }
    let claimed;
    try {
      claimed = await claimNextBillingAuthorityCommand(lease);
    } catch (err) {
      failStopBillingAuthorityWorker({ err });
    }
    if (!claimed) {
      await delay(IDLE_POLL_MS);
      continue;
    }
    await executeClaimedCommand({
      lease,
      command_id: claimed.record.command_id,
      command: claimed.command,
      lane: claimed.record.lane,
    });
  }
}

async function heartbeatLoop(lease: ActiveLease): Promise<void> {
  while (authorityLocallyActive(lease)) {
    await delay(HEARTBEAT_MS);
    if (!authorityLocallyActive(lease)) break;
    try {
      const renewed = await bounded(
        renewBillingAuthorityLease({ ...lease, lease_ms: LEASE_MS }),
        LEASE_QUERY_TIMEOUT_MS,
      );
      runtime.draining = !renewed.enabled || renewed.draining;
      runtime.local_deadline_ms =
        performance.now() + LEASE_MS - LOCAL_LEASE_MARGIN_MS;
      if (runtime.draining && !runtime.active_command_id) {
        await releaseBillingAuthorityLease(lease);
        if (
          runtime.lease?.instance_id === lease.instance_id &&
          runtime.lease?.generation === lease.generation
        ) {
          runtime.lease = undefined;
          runtime.local_deadline_ms = 0;
        }
        return;
      }
    } catch (err) {
      failStopBillingAuthorityWorker({ err });
    }
  }
}

async function runLease(lease: ActiveLease): Promise<void> {
  runtime.lease = lease;
  runtime.draining = false;
  runtime.local_deadline_ms =
    performance.now() + LEASE_MS - LOCAL_LEASE_MARGIN_MS;
  logger.info("billing authority elected", lease);
  const watchdog = setInterval(() => {
    if (
      runtime.lease === lease &&
      !runtime.stopping &&
      performance.now() >= runtime.local_deadline_ms
    ) {
      failStopBillingAuthorityWorker({
        err: new Error("billing authority local lease deadline elapsed"),
      });
    }
  }, 250);
  watchdog.unref?.();
  try {
    await Promise.all([processingLoop(lease), heartbeatLoop(lease)]);
  } finally {
    clearInterval(watchdog);
  }
}

async function electionLoop(): Promise<void> {
  assertAuthorityBay();
  while (!runtime.stopping) {
    try {
      const acquired = await bounded(
        acquireBillingAuthorityLease({
          instance_id: INSTANCE_ID,
          lease_ms: LEASE_MS,
        }),
        LEASE_QUERY_TIMEOUT_MS,
      );
      if (!acquired) {
        await delay(ELECTION_RETRY_MS);
        continue;
      }
      const lease = {
        instance_id: INSTANCE_ID,
        generation: acquired.generation,
      };
      await runLease(lease);
    } catch (err) {
      if (runtime.lease) failStopBillingAuthorityWorker({ err });
      logger.warn("billing authority election attempt failed", { err });
    } finally {
      runtime.lease = undefined;
      runtime.local_deadline_ms = 0;
      runtime.draining = false;
      runtime.active_command_id = undefined;
    }
    await delay(ELECTION_RETRY_MS);
  }
}

export async function getBillingAuthorityHealth(): Promise<BillingAuthorityHealth> {
  assertAuthorityBay();
  const health = await getStoredHealth();
  return {
    ...health,
    ...(health.instance_id === INSTANCE_ID && runtime.active_command_id
      ? { active_command_id: runtime.active_command_id }
      : {}),
  };
}

export async function drainBillingAuthority({
  timeout_ms = DRAIN_TIMEOUT_MS,
}: { timeout_ms?: number } = {}): Promise<BillingAuthorityHealth> {
  assertAuthorityBay();
  await requestBillingAuthorityDrain();
  const deadline = Date.now() + timeout_ms;
  while (Date.now() < deadline) {
    await reconcileExpiredBillingAuthorityLease();
    const health = await getStoredHealth();
    if (!health.instance_id && !health.active_command_id) return health;
    await delay(100);
  }
  throw Object.assign(new Error("billing authority drain timed out"), {
    status: 408,
    code: 408,
  });
}

export async function resumeBillingAuthority(): Promise<BillingAuthorityHealth> {
  assertAuthorityBay();
  await resumeBillingAuthorityGlobally();
  const deadline = Date.now() + LEASE_MS;
  while (Date.now() < deadline) {
    const health = await getStoredHealth();
    if (health.ready) return health;
    await delay(100);
  }
  throw Object.assign(new Error("billing authority did not become ready"), {
    status: 503,
    code: 503,
  });
}

export async function handoffBillingAuthority({
  timeout_ms = DRAIN_TIMEOUT_MS,
}: { timeout_ms?: number } = {}): Promise<BillingAuthorityHealth> {
  assertAuthorityBay();
  const before = await getStoredHealth();
  await drainBillingAuthority({ timeout_ms });
  const deadline = Date.now() + timeout_ms;
  await resumeBillingAuthorityGlobally();
  while (Date.now() < deadline) {
    const health = await getStoredHealth();
    if (
      health.ready &&
      (before.generation == null ||
        (health.generation ?? 0) > before.generation)
    ) {
      return health;
    }
    await delay(100);
  }
  throw Object.assign(new Error("billing authority handoff timed out"), {
    status: 408,
    code: 408,
  });
}

export async function handleBillingAuthorityTransportRequest(
  request: BillingAuthorityTransportRequest,
): Promise<BillingAuthorityTransportResponse> {
  try {
    assertAuthorityBay();
    switch (request.action) {
      case "submit":
        if (!isSubmitRequest(request.request)) {
          throw Object.assign(
            new Error("invalid billing authority submission"),
            { status: 400, code: 400 },
          );
        }
        return {
          ok: true,
          value: await submitBillingAuthorityCommand(request.request),
        };
      case "status":
        return {
          ok: true,
          value: (await getBillingAuthorityCommand(request.command_id)) ?? null,
        };
      case "cancel":
        return {
          ok: true,
          value:
            (await cancelQueuedBillingAuthorityCommand(request.command_id)) ??
            null,
        };
      case "freeze-account":
        return {
          ok: true,
          value: await setBillingAuthorityAccountFrozen({
            account_id: request.account_id,
            frozen: true,
            reason: request.reason,
            actor_account_id: request.actor_account_id,
          }),
        };
      case "unfreeze-account":
        return {
          ok: true,
          value: await setBillingAuthorityAccountFrozen({
            account_id: request.account_id,
            frozen: false,
            reason: request.reason,
            actor_account_id: request.actor_account_id,
          }),
        };
      case "health":
        return { ok: true, value: await getBillingAuthorityHealth() };
      default:
        throw Object.assign(
          new Error("invalid billing authority transport action"),
          { status: 400, code: 400 },
        );
    }
  } catch (err) {
    return { ok: false, error: serializeError(err) };
  }
}

export function startBillingAuthorityService(): void {
  enableStripeMutationAuthorityEnforcement();
  if (started) return;
  started = true;
  if (getConfiguredClusterRole() === "attached") {
    logger.info("billing authority executor is seed-bay only");
    return;
  }
  electionPromise = electionLoop();
  void electionPromise;
  const pruneTimer = setInterval(() => {
    if (runtime.lease && authorityLocallyActive(runtime.lease)) {
      void pruneBillingAuthorityCommands().catch((err) =>
        logger.warn("failed to prune billing authority journal", { err }),
      );
    }
  }, 60 * 60_000);
  pruneTimer.unref?.();
}

export const __test__ = {
  authorityLocallyActive,
  failStopBillingAuthorityWorker,
  isSubmitRequest,
  runtime,
};
