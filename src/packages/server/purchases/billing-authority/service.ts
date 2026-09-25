/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import getLogger from "@cocalc/backend/logger";
import { getClient } from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  getConfiguredClusterRole,
  getConfiguredClusterSeedBayId,
} from "@cocalc/server/cluster-config";

import {
  createBillingAuthorityProviderMutationTracker,
  enableStripeMutationAuthorityEnforcement,
  getBillingAuthorityProviderMutationOutcome,
  runInBillingAuthorityContext,
} from "./context";
import { isBillingAuthorityEnabled } from "./config";
import { dispatchBillingAuthorityCommand } from "./dispatch";
import { normalizeBillingAuthorityError } from "./error-normalization";
import type {
  BillingAuthorityAccountLocalOperation,
  BillingAuthorityCommercialMaintenanceTask,
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
import { billingAuthorityAccountIds } from "./protocol";
import {
  ensureBillingAccounts,
  updateBillingAccountLifecycle,
} from "@cocalc/server/purchases/billing-account";
import { isBillingAuthorityHubApiCall } from "./classification";
import {
  acquireBillingAuthorityLease,
  advanceBillingAuthorityActivation,
  assertBillingAuthorityLease,
  beginBillingAuthorityCommandExecution,
  cancelQueuedBillingAuthorityCommand,
  claimNextBillingAuthorityCommand,
  finishBillingAuthorityCommand,
  getBillingAuthorityCommand,
  getBillingAuthorityHealth as getStoredHealth,
  markBillingAuthorityLeaseServing,
  pruneBillingAuthorityCommands,
  registerBillingAuthorityCommandAccount,
  recordBillingAuthorityProviderMutationStart,
  reconcileExpiredBillingAuthorityLease,
  requestBillingAuthorityDrain,
  releaseBillingAuthorityLease,
  renewBillingAuthorityLease,
  resumeBillingAuthorityGlobally,
  setBillingAuthorityAccountFrozen,
  setBillingAuthorityDraining,
  submitBillingAuthorityCommand,
} from "./store";

const logger = getLogger("purchases:billing-authority");
const INSTANCE_ID = randomUUID();
const LEASE_MS = 12_000;
const LOCAL_LEASE_MARGIN_MS = 4_000;
const HEARTBEAT_MS = 2_000;
const LEASE_QUERY_TIMEOUT_MS = 2_500;
const ACTIVATION_QUERY_TIMEOUT_MS = 30_000;
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
  lease_client?: ReturnType<typeof getClient>;
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
let pruneTimer: ReturnType<typeof setInterval> | undefined;
let shutdownHooksInstalled = false;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function serializeError(err: unknown): BillingAuthorityError {
  return normalizeBillingAuthorityError(err);
}

function classifyCommandOutcome({
  error,
  provider,
}: {
  error?: BillingAuthorityError;
  provider: { successful: boolean; ambiguous: boolean };
}): {
  status: "succeeded" | "failed" | "uncertain";
  error?: BillingAuthorityError;
} {
  const uncertain =
    provider.ambiguous || (error != null && provider.successful);
  if (uncertain) {
    return {
      status: "uncertain",
      error: error ?? {
        message:
          "Stripe mutation outcome is ambiguous; reconcile this command before retrying",
        code: "stripe_mutation_outcome_ambiguous",
        status: 503,
      },
    };
  }
  return error ? { status: "failed", error } : { status: "succeeded" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "string" && value[key].trim() !== "";
}

const ACCOUNT_LOCAL_OPERATIONS = new Set<BillingAuthorityAccountLocalOperation>(
  [
    "apply-funding-approval",
    "admin-create-membership-package-purchase",
    "admin-provision-site-license",
    "legacy-apply-financial-home-bay",
    "legacy-apply-financial-migration",
    "legacy-configure-financial-renewal-home-bay",
    "compute-funding-check",
    "compute-funding-fallback",
    "compute-funding-lookup",
    "compute-funding-reserve",
    "compute-funding-settle",
    "get-dedicated-host-financial-snapshot",
    "update-billing-account-home",
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
  "monthly-collections",
  "credit-transfers",
  "provider-refunds",
  "automatic-payments",
  "auto-balance",
  "payment-intents",
  "statements",
  "subscriptions",
  "team-licenses",
]);

const COMMERCIAL_MAINTENANCE_TASKS =
  new Set<BillingAuthorityCommercialMaintenanceTask>([
    "invoices",
    "quotes",
    "stripe-events",
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
      return COMMERCIAL_MAINTENANCE_TASKS.has(
        command.task as BillingAuthorityCommercialMaintenanceTask,
      );
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

async function boundedDedicatedQuery<T>({
  client,
  promise,
  timeoutMs,
}: {
  client: ReturnType<typeof getClient>;
  promise: Promise<T>;
  timeoutMs: number;
}): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // Closing the dedicated socket cancels the PostgreSQL operation. A
          // plain Promise.race would permit a timed-out acquisition to succeed
          // later and create a ghost authority.
          reject(new Error("billing authority lease query timed out"));
          // Settle the timeout first. Destroying an active pg query can settle
          // its promise synchronously; letting that race win would report an
          // arbitrary query outcome instead of the authoritative timeout.
          void client.end().catch(() => undefined);
        }, timeoutMs);
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
  const client = runtime.lease_client;
  if (!client) {
    throw Object.assign(
      new Error("billing authority lease session is absent"),
      {
        code: 503,
        status: 503,
      },
    );
  }
  await boundedDedicatedQuery({
    client,
    promise: assertBillingAuthorityLease(lease, client),
    timeoutMs: LEASE_QUERY_TIMEOUT_MS,
  });
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
  account_ids,
}: {
  lease: ActiveLease;
  command_id: string;
  command: BillingAuthorityCommand;
  lane: keyof typeof COMMAND_RUNTIME_MS;
  account_ids: string[];
}): Promise<void> {
  runtime.active_command_id = command_id;
  const executionDb = getClient();
  let executionTransactionOpen = false;
  const operation = billingAuthorityOperationName(command);
  const startedAt = Date.now();
  let result: unknown;
  let error: BillingAuthorityError | undefined;
  const providerTracker = createBillingAuthorityProviderMutationTracker();
  const commandWatchdog = setTimeout(() => {
    failStopBillingAuthorityWorker({
      err: new Error(
        `billing authority ${lane} command exceeded its runtime bound`,
      ),
    });
  }, COMMAND_RUNTIME_MS[lane]);
  commandWatchdog.unref?.();
  try {
    await boundedDedicatedQuery({
      client: executionDb,
      promise: executionDb.connect(),
      timeoutMs: LEASE_QUERY_TIMEOUT_MS,
    });
    await boundedDedicatedQuery({
      client: executionDb,
      promise: beginBillingAuthorityCommandExecution({
        identity: lease,
        db: executionDb,
      }),
      timeoutMs: LEASE_QUERY_TIMEOUT_MS,
    });
    executionTransactionOpen = true;
    await assertAuthorityFenced(lease);
    result = await runInBillingAuthorityContext({
      operation,
      request_id: command_id,
      authority_active: () => authorityLocallyActive(lease),
      assert_authority: async () => await assertAuthorityFenced(lease),
      record_provider_start: async () =>
        await recordBillingAuthorityProviderMutationStart({
          ...lease,
          command_id,
        }),
      register_account: async (account_id) =>
        await registerBillingAuthorityCommandAccount({
          ...lease,
          command_id,
          account_id,
        }),
      pre_registered_accounts: account_ids,
      provider_tracker: providerTracker,
      fn: async () => await dispatchBillingAuthorityCommand(command),
    });
  } catch (err) {
    error = serializeError(err);
  }
  const provider = getBillingAuthorityProviderMutationOutcome(providerTracker);
  const completion = classifyCommandOutcome({ error, provider });
  error = completion.error;
  try {
    await assertAuthorityFenced(lease);
    await finishBillingAuthorityCommand({
      ...lease,
      command_id,
      db: executionDb,
      ...(completion.status === "succeeded"
        ? { result, status: completion.status }
        : { error: completion.error!, status: completion.status }),
    });
    await executionDb.query("COMMIT");
    executionTransactionOpen = false;
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
    if (executionTransactionOpen) {
      await executionDb.query("ROLLBACK").catch(() => undefined);
    }
    await executionDb.end().catch(() => undefined);
    clearTimeout(commandWatchdog);
    runtime.active_command_id = undefined;
  }
}

async function processingLoop(
  lease: ActiveLease,
  claimClient: ReturnType<typeof getClient>,
): Promise<void> {
  while (authorityLocallyActive(lease)) {
    if (runtime.draining) {
      await delay(IDLE_POLL_MS);
      continue;
    }
    let claimed;
    try {
      // Claiming must not wait behind ordinary hub traffic in the shared pool.
      // Otherwise the lease heartbeat can remain healthy while the singleton
      // silently stops executing commands.
      claimed = await boundedDedicatedQuery({
        client: claimClient,
        promise: claimNextBillingAuthorityCommand(lease, claimClient),
        timeoutMs: LEASE_QUERY_TIMEOUT_MS,
      });
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
      account_ids:
        claimed.record.account_ids ??
        (claimed.record.account_id ? [claimed.record.account_id] : []),
    });
  }
}

async function heartbeatLoop(lease: ActiveLease): Promise<void> {
  while (authorityLocallyActive(lease)) {
    await delay(HEARTBEAT_MS);
    if (!authorityLocallyActive(lease)) break;
    try {
      const client = runtime.lease_client;
      if (!client) throw new Error("billing authority lease session is absent");
      const renewed = await boundedDedicatedQuery({
        client,
        promise: renewBillingAuthorityLease({
          ...lease,
          lease_ms: LEASE_MS,
          db: client,
        }),
        timeoutMs: LEASE_QUERY_TIMEOUT_MS,
      });
      runtime.draining = !renewed.enabled || renewed.draining;
      runtime.local_deadline_ms =
        performance.now() + LEASE_MS - LOCAL_LEASE_MARGIN_MS;
      if (runtime.draining && !runtime.active_command_id) {
        await releaseBillingAuthorityLease(lease, client);
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

async function runLease(
  lease: ActiveLease,
  claimClient: ReturnType<typeof getClient>,
): Promise<void> {
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
    await Promise.all([
      processingLoop(lease, claimClient),
      heartbeatLoop(lease),
    ]);
  } finally {
    clearInterval(watchdog);
  }
}

async function electionLoop(): Promise<void> {
  assertAuthorityBay();
  while (!runtime.stopping) {
    const leaseClient = getClient();
    const claimClient = getClient();
    try {
      await boundedDedicatedQuery({
        client: leaseClient,
        promise: leaseClient.connect(),
        timeoutMs: LEASE_QUERY_TIMEOUT_MS,
      });
      let activation;
      do {
        activation = await boundedDedicatedQuery({
          client: leaseClient,
          promise: advanceBillingAuthorityActivation({ db: leaseClient }),
          timeoutMs: ACTIVATION_QUERY_TIMEOUT_MS,
        });
        if (!activation.complete) {
          logger.info("billing authority preactivation migration advanced", {
            phase: activation.phase,
            processed_in_batch: activation.processed_in_batch,
            processed_count: activation.processed_count,
          });
          await delay(10);
        }
      } while (!activation.complete && !runtime.stopping);
      if (runtime.stopping) break;
      const acquired = await boundedDedicatedQuery({
        client: leaseClient,
        promise: acquireBillingAuthorityLease({
          instance_id: INSTANCE_ID,
          lease_ms: LEASE_MS,
          db: leaseClient,
        }),
        timeoutMs: LEASE_QUERY_TIMEOUT_MS,
      });
      if (!acquired) {
        await delay(ELECTION_RETRY_MS);
        continue;
      }
      const lease = {
        instance_id: INSTANCE_ID,
        generation: acquired.generation,
      };
      if (runtime.stopping) {
        await boundedDedicatedQuery({
          client: leaseClient,
          promise: releaseBillingAuthorityLease(lease, leaseClient),
          timeoutMs: LEASE_QUERY_TIMEOUT_MS,
        });
        break;
      }
      await boundedDedicatedQuery({
        client: claimClient,
        promise: claimClient.connect(),
        timeoutMs: LEASE_QUERY_TIMEOUT_MS,
      });
      runtime.lease_client = leaseClient;
      await boundedDedicatedQuery({
        client: leaseClient,
        promise: markBillingAuthorityLeaseServing(lease, leaseClient),
        timeoutMs: LEASE_QUERY_TIMEOUT_MS,
      });
      // stopBillingAuthorityService can run while the serving update is in
      // flight. Never leave a lease advertised as ready if shutdown won that
      // race, even though no command loop has started yet.
      if (runtime.stopping) {
        await boundedDedicatedQuery({
          client: leaseClient,
          promise: releaseBillingAuthorityLease(lease, leaseClient),
          timeoutMs: LEASE_QUERY_TIMEOUT_MS,
        });
        break;
      }
      await runLease(lease, claimClient);
    } catch (err) {
      if (runtime.lease) failStopBillingAuthorityWorker({ err });
      logger.warn("billing authority election attempt failed", { err });
    } finally {
      await leaseClient.end().catch(() => undefined);
      await claimClient.end().catch(() => undefined);
      runtime.lease = undefined;
      runtime.lease_client = undefined;
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
  exclude_holder_id,
}: {
  timeout_ms?: number;
  exclude_holder_id?: string;
} = {}): Promise<BillingAuthorityHealth> {
  assertAuthorityBay();
  await requestBillingAuthorityDrain({ exclude_holder_id });
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
  await drainBillingAuthority({
    timeout_ms,
    exclude_holder_id: before.instance_id,
  });
  const deadline = Date.now() + timeout_ms;
  await resumeBillingAuthorityGlobally();
  while (Date.now() < deadline) {
    const health = await getStoredHealth();
    if (
      health.ready &&
      health.instance_id !== before.instance_id &&
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
    if (!isBillingAuthorityEnabled()) {
      throw Object.assign(new Error("billing authority is not enabled"), {
        status: 503,
        code: 503,
      });
    }
    assertAuthorityBay();
    switch (request.action) {
      case "submit":
        if (!isSubmitRequest(request.request)) {
          throw Object.assign(
            new Error("invalid billing authority submission"),
            { status: 400, code: 400 },
          );
        }
        await ensureBillingAccounts(
          billingAuthorityAccountIds(request.request.command),
        );
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
      case "freeze-account": {
        const value = await setBillingAuthorityAccountFrozen({
          account_id: request.account_id,
          frozen: true,
          cause: request.cause,
          reason: request.reason,
          actor_account_id: request.actor_account_id,
        });
        await updateBillingAccountLifecycle({
          account_id: request.account_id,
          ...(request.cause === "ban" ? { banned: true } : {}),
          ...(request.cause === "deletion" ? { deleted: true } : {}),
        });
        return {
          ok: true,
          value,
        };
      }
      case "unfreeze-account": {
        const value = await setBillingAuthorityAccountFrozen({
          account_id: request.account_id,
          frozen: false,
          cause: request.cause,
          reason: request.reason,
          actor_account_id: request.actor_account_id,
        });
        await updateBillingAccountLifecycle({
          account_id: request.account_id,
          ...(request.cause === "ban" ? { banned: false } : {}),
          ...(request.cause === "deletion" ? { deleted: false } : {}),
        });
        return {
          ok: true,
          value,
        };
      }
      case "stripe-webhook-raw": {
        if (request.body_base64.length > 3 * 1024 * 1024) {
          throw Object.assign(
            new Error("Stripe webhook payload is too large"),
            {
              status: 413,
              code: 413,
            },
          );
        }
        const { verifyAndProcessStripeWebhookPayload } =
          await import("../stripe/webhook");
        return {
          ok: true,
          value: await verifyAndProcessStripeWebhookPayload({
            body: Buffer.from(request.body_base64, "base64"),
            signature: request.signature,
          }),
        };
      }
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
  if (started) return;
  started = true;
  if (!isBillingAuthorityEnabled()) {
    logger.info(
      "billing authority is disabled; using legacy direct billing execution",
    );
    return;
  }
  enableStripeMutationAuthorityEnforcement();
  if (getConfiguredClusterRole() === "attached") {
    logger.info("billing authority executor is seed-bay only");
    return;
  }
  electionPromise = electionLoop();
  void electionPromise;
  pruneTimer = setInterval(() => {
    if (runtime.lease && authorityLocallyActive(runtime.lease)) {
      void pruneBillingAuthorityCommands().catch((err) =>
        logger.warn("failed to prune billing authority journal", { err }),
      );
    }
  }, 60 * 60_000);
  pruneTimer.unref?.();
  installBillingAuthorityShutdownHooks();
}

export async function stopBillingAuthorityService({
  timeout_ms = 30_000,
}: { timeout_ms?: number } = {}): Promise<void> {
  if (!started || !isBillingAuthorityEnabled()) return;
  const lease = runtime.lease;
  const leaseClient = runtime.lease_client;
  if (lease && leaseClient && authorityLocallyActive(lease)) {
    runtime.draining = true;
    await setBillingAuthorityDraining(lease, leaseClient);
    const deadline = Date.now() + timeout_ms;
    while (runtime.lease && Date.now() < deadline) {
      await delay(50);
    }
    if (runtime.lease) {
      throw Object.assign(
        new Error("billing authority graceful shutdown timed out"),
        { code: 408, status: 408 },
      );
    }
  }
  runtime.stopping = true;
  runtime.local_deadline_ms = 0;
  if (pruneTimer) clearInterval(pruneTimer);
  pruneTimer = undefined;
  await leaseClient?.end().catch(() => undefined);
}

function installBillingAuthorityShutdownHooks(): void {
  if (shutdownHooksInstalled) return;
  shutdownHooksInstalled = true;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void stopBillingAuthorityService()
        .catch((err) =>
          logger.error("billing authority graceful shutdown failed", { err }),
        )
        .finally(() => process.exit(signal === "SIGINT" ? 130 : 0));
    });
  }
}

export const __test__ = {
  authorityLocallyActive,
  boundedDedicatedQuery,
  classifyCommandOutcome,
  failStopBillingAuthorityWorker,
  isSubmitRequest,
  serializeError,
  runtime,
};
