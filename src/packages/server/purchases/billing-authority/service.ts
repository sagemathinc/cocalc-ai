/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { conat } from "@cocalc/backend/conat";
import getLogger from "@cocalc/backend/logger";
import {
  createServiceClient,
  createServiceHandler,
} from "@cocalc/conat/service/typed";
import getPool, { type PoolClient } from "@cocalc/database/pool";
import { isMultiBayCluster } from "@cocalc/server/cluster-config";

import {
  enableStripeMutationAuthorityEnforcement,
  runInBillingAuthorityContext,
} from "./context";
import { dispatchBillingAuthorityCommand } from "./dispatch";
import type {
  BillingAuthorityApi,
  BillingAuthorityError,
  BillingAuthorityRequest,
  BillingAuthorityResponse,
} from "./protocol";
import {
  BILLING_AUTHORITY_SUBJECT,
  billingAuthorityOperationName,
} from "./protocol";
import { BillingAuthoritySerialQueue } from "./serial-queue";
import {
  isBillingAuthorityHubApiCall,
  isBillingAuthorityReadCommand,
} from "./classification";

const logger = getLogger("purchases:billing-authority");
const ELECTION_RETRY_MS = 2_000;
const ELECTION_HEARTBEAT_MS = 1_000;
const SERVICE_HEALTH_TIMEOUT_MS = 3_000;
const ADVISORY_LOCK_NAMESPACE = 1_122_493_772;
const ADVISORY_LOCK_ID = 1_111_575_377;

const startedAt = new Date().toISOString();
let started = false;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function failStopBillingAuthorityWorker({
  err,
  deactivate,
  closeService,
  exit = (code) => process.exit(code),
}: {
  err: unknown;
  deactivate: () => void;
  closeService: () => void;
  exit?: (code: number) => never;
}): never {
  deactivate();
  try {
    closeService();
  } catch (closeErr) {
    logger.error("failed to close billing authority during fail-stop", {
      closeErr,
    });
  }
  logger.error(
    "billing authority lease failed after election; fail-stopping worker",
    { err },
  );
  return exit(1);
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
    message: `${candidate?.message ?? err}`,
    ...(code == null ? {} : { code }),
    ...(status == null ? {} : { status }),
  };
}

async function execute(
  request: unknown,
  serialized: boolean,
  queue: BillingAuthoritySerialQueue,
  dispatch: (command: BillingAuthorityRequest["command"]) => Promise<unknown>,
  authorityActive: () => boolean,
): Promise<BillingAuthorityResponse> {
  const started = Date.now();
  let operation = "invalid-request";
  let requestId: string | undefined;
  try {
    if (!isBillingAuthorityRequest(request)) {
      const err = new Error("invalid billing authority request");
      Object.assign(err, { code: 400, status: 400 });
      throw err;
    }
    requestId = request.request_id;
    operation = billingAuthorityOperationName(request.command);
    if (
      request.command.kind === "hub-api" &&
      !isBillingAuthorityHubApiCall(request.command.call.name)
    ) {
      const err = new Error("the billing authority only accepts billing APIs");
      Object.assign(err, { code: 400, status: 400 });
      throw err;
    }
    const fn = async () => {
      if (!authorityActive()) {
        const err = new Error("billing authority lease is no longer active");
        Object.assign(err, { code: 503, status: 503 });
        throw err;
      }
      return await dispatch(request.command);
    };
    const value = serialized
      ? await queue.run(
          async () =>
            await runInBillingAuthorityContext({
              operation,
              request_id: request.request_id,
              authority_active: authorityActive,
              fn,
            }),
        )
      : await fn();
    logger.debug("billing authority request completed", {
      request_id: request.request_id,
      operation,
      serialized,
      duration_ms: Date.now() - started,
    });
    return { ok: true, value: value ?? null };
  } catch (err) {
    logger.warn("billing authority request failed", {
      request_id: requestId,
      operation,
      serialized,
      duration_ms: Date.now() - started,
      err,
    });
    return { ok: false, error: serializeError(err) };
  }
}

function isBillingAuthorityRequest(
  request: unknown,
): request is BillingAuthorityRequest {
  if (request == null || typeof request !== "object") return false;
  const candidate = request as Partial<BillingAuthorityRequest>;
  return (
    typeof candidate.request_id === "string" &&
    candidate.request_id.length >= 1 &&
    candidate.request_id.length <= 128 &&
    isBillingAuthorityCommand(candidate.command)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "string" && value[key] !== "";
}

function isBillingAuthorityCommand(
  command: unknown,
): command is BillingAuthorityRequest["command"] {
  if (!isRecord(command) || typeof command.kind !== "string") return false;
  switch (command.kind) {
    case "account-stripe-cleanup":
    case "cancel-usage-subscription":
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
      return hasString(command, "operation") && isRecord(command.input);
    case "hub-api":
      return (
        isRecord(command.call) &&
        hasString(command.call, "name") &&
        Array.isArray(command.call.args)
      );
    case "maintenance":
      return hasString(command, "task");
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

export function createBillingAuthorityApi({
  dispatch = dispatchBillingAuthorityCommand,
  queue = new BillingAuthoritySerialQueue(),
  serviceStartedAt = startedAt,
  authorityActive = () => true,
}: {
  dispatch?: (command: BillingAuthorityRequest["command"]) => Promise<unknown>;
  queue?: BillingAuthoritySerialQueue;
  serviceStartedAt?: string;
  authorityActive?: () => boolean;
} = {}): BillingAuthorityApi {
  return {
    executeCommand: async (request) =>
      await execute(request, true, queue, dispatch, authorityActive),
    executeRead: async (request) => {
      if (!isBillingAuthorityRequest(request)) {
        return await execute(request, false, queue, dispatch, authorityActive);
      }
      if (!isBillingAuthorityReadCommand(request.command)) {
        return {
          ok: false,
          error: {
            message: "operation is not approved for concurrent billing reads",
            code: 400,
            status: 400,
          },
        };
      }
      return await execute(request, false, queue, dispatch, authorityActive);
    },
    health: async () => ({
      pid: process.pid,
      started_at: serviceStartedAt,
      ...queue.stats(),
    }),
  };
}

function createAuthorityHealthClient(): BillingAuthorityApi {
  return createServiceClient<BillingAuthorityApi>({
    client: conat(),
    service: "billing-authority-health",
    subject: BILLING_AUTHORITY_SUBJECT,
    timeout: SERVICE_HEALTH_TIMEOUT_MS,
    noRetry: true,
    transport: "request",
  });
}

async function assertElectedServiceHealthy(
  client: Pick<BillingAuthorityApi, "health">,
): Promise<void> {
  const health = await client.health();
  if (health.pid !== process.pid) {
    throw new Error(
      `billing authority split-brain detected: elected pid ${process.pid}, responding pid ${health.pid}`,
    );
  }
}

async function electionLoop(): Promise<void> {
  if (isMultiBayCluster()) {
    logger.error(
      "billing authority refused to start in multi-bay mode; configure a global authority before enabling multi-bay billing",
    );
    return;
  }
  while (true) {
    let db: PoolClient | undefined;
    let service:
      | ReturnType<typeof createServiceHandler<BillingAuthorityApi>>
      | undefined;
    let destroyConnection = false;
    let acquired = false;
    let authorityActive = false;
    let onDatabaseError: ((err: Error) => void) | undefined;
    try {
      db = await getPool().connect();
      onDatabaseError = (err) => {
        destroyConnection = true;
        if (acquired) {
          failStopBillingAuthorityWorker({
            err,
            deactivate: () => {
              authorityActive = false;
            },
            closeService: () => service?.close(),
          });
        }
        authorityActive = false;
        service?.close();
        logger.error("billing authority election connection failed", { err });
      };
      db.on("error", onDatabaseError);
      const { rows } = await db.query(
        "SELECT pg_try_advisory_lock($1, $2) AS acquired",
        [ADVISORY_LOCK_NAMESPACE, ADVISORY_LOCK_ID],
      );
      acquired = rows[0]?.acquired === true;
      if (acquired) {
        authorityActive = true;
        const impl = createBillingAuthorityApi({
          authorityActive: () => authorityActive,
        });
        service = createServiceHandler<BillingAuthorityApi>({
          client: conat(),
          service: "billing-authority",
          subject: BILLING_AUTHORITY_SUBJECT,
          transport: "request",
          parallel: true,
          impl,
        });
        logger.info("billing authority elected", {
          pid: process.pid,
          subject: BILLING_AUTHORITY_SUBJECT,
        });
        const healthClient = createAuthorityHealthClient();
        while (true) {
          await delay(ELECTION_HEARTBEAT_MS);
          await Promise.all([
            db.query("SELECT 1"),
            assertElectedServiceHealthy(healthClient),
          ]);
        }
      }
    } catch (err) {
      destroyConnection = true;
      if (acquired) {
        failStopBillingAuthorityWorker({
          err,
          deactivate: () => {
            authorityActive = false;
          },
          closeService: () => service?.close(),
        });
      }
      logger.error("billing authority election/service failed", { err });
    } finally {
      authorityActive = false;
      service?.close();
      if (db && onDatabaseError) {
        db.off("error", onDatabaseError);
      }
      if (db && acquired && !destroyConnection) {
        try {
          await db.query("SELECT pg_advisory_unlock($1, $2)", [
            ADVISORY_LOCK_NAMESPACE,
            ADVISORY_LOCK_ID,
          ]);
        } catch {
          destroyConnection = true;
        }
      }
      if (db) {
        try {
          db.release(destroyConnection);
        } catch {
          // The pool may already have discarded a broken election connection.
        }
      }
    }
    await delay(ELECTION_RETRY_MS);
  }
}

export function startBillingAuthorityService(): void {
  enableStripeMutationAuthorityEnforcement();
  if (started) return;
  started = true;
  void electionLoop();
}

export const __test__ = {
  assertElectedServiceHealthy,
  failStopBillingAuthorityWorker,
};
