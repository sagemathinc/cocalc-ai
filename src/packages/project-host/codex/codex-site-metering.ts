import getLogger from "@cocalc/backend/logger";
import callHub from "@cocalc/conat/hub/call-hub";
import {
  setCodexSiteKeyGovernor,
  type CodexSiteFundedTurnRequest,
  type CodexSiteFundedTurnRuntime,
} from "@cocalc/ai/acp";
import { getMasterConatClient } from "../master-conat-client";
import { getLocalHostId } from "../sqlite/hosts";
import { getDatabase, initDatabase } from "@cocalc/lite/hub/sqlite/database";
import {
  computeSiteFundedCodexRequestCost,
  siteFundedTurnEndReason,
  type SiteFundedCodexAdmission,
  type SiteFundedCodexUsageEvent,
} from "@cocalc/util/ai/site-funded-codex";
import { startSiteFundedCodexProxySession } from "./site-funded-proxy";

const logger = getLogger("project-host:codex-site-metering");

function getHubCaller():
  | {
      client: NonNullable<ReturnType<typeof getMasterConatClient>>;
      host_id: string;
    }
  | undefined {
  const client = getMasterConatClient();
  const host_id = getLocalHostId();
  if (!client || !host_id) {
    return;
  }
  return { client, host_id };
}

const SITE_KEY_POLL_MS = Math.max(
  30_000,
  Number(process.env.COCALC_CODEX_SITE_USAGE_POLL_MS ?? 2 * 60_000),
);

const SITE_KEY_FAIL_OPEN_MS = Math.max(
  10_000,
  Number(process.env.COCALC_CODEX_SITE_FAIL_OPEN_MS ?? 5 * 60_000),
);

const SITE_FUNDED_OUTBOX_FLUSH_MS = Math.max(
  5_000,
  Number(process.env.COCALC_CODEX_SITE_OUTBOX_FLUSH_MS ?? 30_000),
);

function getConfiguredMaxTurnMs(): number | undefined {
  const raw = process.env.COCALC_CODEX_SITE_MAX_TURN_MS;
  if (raw == null || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.max(60_000, n);
}

const SITE_KEY_MAX_TURN_MS = getConfiguredMaxTurnMs();

let meteringHealth: {
  failingSince?: number;
  lastError?: string;
} = {};

let outboxFlushTimer: NodeJS.Timeout | undefined;

function markMeteringSuccess() {
  meteringHealth = {};
}

function markMeteringFailure(err: unknown): {
  deny: boolean;
  reason: string;
} {
  const now = Date.now();
  if (!meteringHealth.failingSince) {
    meteringHealth.failingSince = now;
  }
  meteringHealth.lastError = `${err}`;
  const failingFor = now - meteringHealth.failingSince;
  if (failingFor <= SITE_KEY_FAIL_OPEN_MS) {
    return {
      deny: false,
      reason: "",
    };
  }
  return {
    deny: true,
    reason:
      "Site usage checks are temporarily unavailable, so CoCalc Membership Codex access is paused. Please retry shortly.",
  };
}

export function initCodexSiteKeyGovernor(): void {
  setCodexSiteKeyGovernor({
    pollIntervalMs: SITE_KEY_POLL_MS,
    ...(SITE_KEY_MAX_TURN_MS == null
      ? {}
      : { maxTurnMs: SITE_KEY_MAX_TURN_MS }),
    async checkAllowed({ accountId, projectId, model }) {
      const caller = getHubCaller();
      if (!caller) {
        const verdict = markMeteringFailure("missing hub caller");
        if (verdict.deny) {
          return { allowed: false, reason: verdict.reason };
        }
        return { allowed: true };
      }
      try {
        const result = await callHub({
          ...caller,
          name: "hosts.checkCodexSiteUsageAllowance",
          args: [
            {
              account_id: accountId,
              project_id: projectId,
              model,
            },
          ],
          timeout: 15_000,
        });
        markMeteringSuccess();
        return {
          allowed: !!result?.allowed,
          reason: result?.reason,
          window: result?.window,
          reset_in: result?.reset_in,
        };
      } catch (err) {
        logger.warn("checkCodexSiteUsageAllowance failed", {
          accountId,
          projectId,
          model,
          err: `${err}`,
        });
        const verdict = markMeteringFailure(err);
        // Intentional: fail open briefly for transient hub/network failures so
        // user turns are not disrupted, then fail closed if outage persists.
        if (verdict.deny) {
          return { allowed: false, reason: verdict.reason };
        }
        return { allowed: true };
      }
    },
    async reportUsage({
      accountId,
      projectId,
      model,
      usage,
      totalTimeS,
      path,
    }) {
      const caller = getHubCaller();
      if (!caller) {
        return;
      }
      await callHub({
        ...caller,
        name: "hosts.recordCodexSiteUsage",
        args: [
          {
            account_id: accountId,
            project_id: projectId,
            model,
            path,
            prompt_tokens: Math.max(0, usage.input_tokens),
            completion_tokens: Math.max(0, usage.output_tokens),
            total_time_s: Math.max(0, totalTimeS),
          },
        ],
        timeout: 15_000,
      });
    },
  });
  void flushSiteFundedCodexOutbox();
  if (!outboxFlushTimer) {
    outboxFlushTimer = setInterval(() => {
      void flushSiteFundedCodexOutbox();
    }, SITE_FUNDED_OUTBOX_FLUSH_MS);
    outboxFlushTimer.unref();
  }
}

type OutboxRecord = {
  id: number;
  kind: "usage" | "finish";
  payload: string;
};

function ensureOutbox(): void {
  initDatabase().exec(`
    CREATE TABLE IF NOT EXISTS site_funded_codex_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK (kind IN ('usage', 'finish')),
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
}

function enqueueOutbox(kind: OutboxRecord["kind"], payload: unknown): void {
  ensureOutbox();
  getDatabase()
    .prepare(
      `INSERT INTO site_funded_codex_outbox(kind, payload, created_at)
       VALUES (?, ?, ?)`,
    )
    .run(kind, JSON.stringify(payload), Date.now());
}

// One SQLite lock must not end a funded turn. A record that cannot be written
// is kept in memory, in order, and written before any later record: the hub
// accepts a reservation's usage events only in sequence, and its settlement
// after them.
type PendingOutboxRecord = {
  kind: OutboxRecord["kind"];
  payload: unknown;
  reservationId?: string;
  costMicrousd: number;
};

const pendingOutbox: PendingOutboxRecord[] = [];
const OUTBOX_WRITE_RETRY_DELAYS_MS = [100, 500];
const PENDING_OUTBOX_RETRY_MS = 5_000;
// A turn is paused only when this much of its usage is in memory alone, so a
// host crash during an outage loses at most this.
export const SITE_FUNDED_MAX_UNSAVED_USAGE_EVENTS = 3;
export const SITE_FUNDED_MAX_UNSAVED_USAGE_MICROUSD = 50_000;

let pendingOutboxRetry: NodeJS.Timeout | undefined;

/** Writes the records held in memory, in order; false if one still fails. */
function writePendingOutbox(): boolean {
  while (pendingOutbox.length) {
    const next = pendingOutbox[0];
    try {
      enqueueOutbox(next.kind, next.payload);
    } catch (err) {
      logger.warn("site-funded outbox write failed; keeping it in memory", {
        kind: next.kind,
        reservationId: next.reservationId,
        pending: pendingOutbox.length,
        err: `${err}`,
      });
      return false;
    }
    pendingOutbox.shift();
  }
  return true;
}

function schedulePendingOutboxRetry(): void {
  if (pendingOutboxRetry) return;
  pendingOutboxRetry = setTimeout(() => {
    pendingOutboxRetry = undefined;
    if (!writePendingOutbox()) {
      schedulePendingOutboxRetry();
      return;
    }
    void flushSiteFundedCodexOutbox().catch((err) =>
      logger.warn("site-funded outbox flush failed", { err: `${err}` }),
    );
  }, PENDING_OUTBOX_RETRY_MS);
  pendingOutboxRetry.unref?.();
}

/** Queues a record after every earlier one, retrying a busy database. */
async function writeOutbox(
  kind: OutboxRecord["kind"],
  payload: unknown,
  {
    reservationId,
    costMicrousd = 0,
  }: Omit<Partial<PendingOutboxRecord>, "kind" | "payload"> = {},
): Promise<void> {
  pendingOutbox.push({ kind, payload, reservationId, costMicrousd });
  if (writePendingOutbox()) return;
  for (const delayMs of OUTBOX_WRITE_RETRY_DELAYS_MS) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (writePendingOutbox()) return;
  }
  schedulePendingOutboxRetry();
}

/** The usage of a reservation that is only in memory. */
function unsavedUsage(reservationId: string): {
  events: number;
  costMicrousd: number;
} {
  let events = 0;
  let costMicrousd = 0;
  for (const record of pendingOutbox) {
    if (record.kind !== "usage" || record.reservationId !== reservationId) {
      continue;
    }
    events += 1;
    costMicrousd += record.costMicrousd;
  }
  return { events, costMicrousd };
}

/** Sends what is queued; a failure here is retried by the next flush. */
async function flushOutboxQuietly(): Promise<void> {
  try {
    await flushSiteFundedCodexOutbox();
  } catch (err) {
    logger.warn("site-funded outbox flush failed; will retry", {
      err: `${err}`,
    });
  }
}

const OUTBOX_SCAN_BATCH_SIZE = 100;

let flushingOutbox: Promise<void> | undefined;

function outboxReservationId(
  row: OutboxRecord,
  payload: Record<string, unknown>,
): string | undefined {
  const value =
    row.kind === "usage" ? payload.reservationId : payload.reservation_id;
  const reservationId = `${value ?? ""}`.trim();
  return reservationId || undefined;
}

function isTerminalUsageOutboxError(err: unknown): boolean {
  const message = `${err}`.toLowerCase();
  return (
    message.includes("reservation is not active") ||
    message.includes("reservation not found") ||
    message.includes("usage event sequence is stale")
  );
}

function deleteOutboxRecord(id: number): void {
  getDatabase()
    .prepare(`DELETE FROM site_funded_codex_outbox WHERE id = ?`)
    .run(id);
}

async function sendOutboxRecord(
  caller: NonNullable<ReturnType<typeof getHubCaller>>,
  row: OutboxRecord,
  payload: Record<string, unknown>,
): Promise<void> {
  if (row.kind === "usage") {
    await callHub({
      ...caller,
      name: "hosts.recordSiteFundedCodexUsageEvent",
      args: [{ event: payload }],
      timeout: 15_000,
    });
    return;
  }
  await callHub({
    ...caller,
    name: "hosts.finishSiteFundedCodexTurn",
    args: [payload],
    timeout: 15_000,
  });
}

async function flushSiteFundedCodexOutboxImpl(): Promise<void> {
  // Records still in memory are newer than every row: write them first.
  writePendingOutbox();
  const caller = getHubCaller();
  if (!caller) return;
  ensureOutbox();

  while (true) {
    const blockedReservations = new Set<string>();
    let cursor = 0;
    let deletedInPass = 0;
    while (true) {
      const rows = getDatabase()
        .prepare(
          `SELECT id, kind, payload FROM site_funded_codex_outbox
           WHERE id > ? ORDER BY id LIMIT ?`,
        )
        .all(cursor, OUTBOX_SCAN_BATCH_SIZE) as OutboxRecord[];
      if (!rows.length) break;
      cursor = rows[rows.length - 1].id;
      for (const row of rows) {
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(row.payload);
        } catch (err) {
          logger.error("discarding malformed site-funded Codex outbox row", {
            id: row.id,
            kind: row.kind,
            err: `${err}`,
          });
          deleteOutboxRecord(row.id);
          deletedInPass += 1;
          continue;
        }
        const reservationId = outboxReservationId(row, payload);
        if (reservationId && blockedReservations.has(reservationId)) {
          continue;
        }
        try {
          await sendOutboxRecord(caller, row, payload);
          deleteOutboxRecord(row.id);
          deletedInPass += 1;
        } catch (err) {
          if (row.kind === "usage" && isTerminalUsageOutboxError(err)) {
            logger.warn("discarding stale site-funded Codex usage outbox row", {
              id: row.id,
              reservationId,
              err: `${err}`,
            });
            deleteOutboxRecord(row.id);
            deletedInPass += 1;
            continue;
          }
          if (reservationId) blockedReservations.add(reservationId);
          logger.warn("site-funded Codex outbox record flush failed", {
            id: row.id,
            kind: row.kind,
            reservationId,
            err: `${err}`,
          });
        }
      }
    }
    if (deletedInPass === 0) return;
  }
}

export async function flushSiteFundedCodexOutbox(): Promise<void> {
  if (flushingOutbox) return await flushingOutbox;
  const currentFlush = flushSiteFundedCodexOutboxImpl();
  flushingOutbox = currentFlush;
  try {
    await currentFlush;
  } finally {
    if (flushingOutbox === currentFlush) flushingOutbox = undefined;
  }
}

// Shared by every site-funded provider (Codex and Claude): reservations,
// usage and settlement all go through the same durable outbox.

/**
 * Records one funded provider request's usage: durable, then retried. Throws
 * only when too much of the turn's usage could not be saved, so the caller
 * stops funding it; that usage is still kept and retried.
 */
export async function persistSiteFundedUsageEvent(
  event: SiteFundedCodexUsageEvent,
): Promise<void> {
  let costMicrousd: number;
  try {
    costMicrousd = computeSiteFundedCodexRequestCost({
      model: event.model,
      usage: event,
    }).costMicrousd;
  } catch {
    // Unpriced usage is never left unsaved for long.
    costMicrousd = Number.POSITIVE_INFINITY;
  }
  // Queued in the order of the calls.
  await writeOutbox("usage", event, {
    reservationId: event.reservationId,
    costMicrousd,
  });
  const unsaved = unsavedUsage(event.reservationId);
  if (
    unsaved.events >= SITE_FUNDED_MAX_UNSAVED_USAGE_EVENTS ||
    unsaved.costMicrousd > SITE_FUNDED_MAX_UNSAVED_USAGE_MICROUSD
  ) {
    throw new Error(
      `site-funded usage could not be saved (${unsaved.events} events pending)`,
    );
  }
  if (unsaved.events > 0) return;
  await flushOutboxQuietly();
}

const persistUsageEvent = persistSiteFundedUsageEvent;

/** Settles a funded turn: durable, then retried. */
export async function finishSiteFundedTurn(finish: {
  reservation_id: string;
  status: "committed" | "interrupted" | "failed" | "released";
  outcome?: string;
}): Promise<void> {
  await writeOutbox("finish", finish, {
    reservationId: finish.reservation_id,
  });
  await flushOutboxQuietly();
}

/** Reserves a funded turn on the hub; a refusal throws with its code. */
export async function reserveSiteFundedTurn({
  provider = "openai",
  accountId,
  projectId,
  fundedTurnId,
  idempotencyKey,
  path,
}: {
  provider?: "openai" | "anthropic";
  accountId: string;
  projectId: string;
  fundedTurnId: string;
  idempotencyKey: string;
  path?: string;
}): Promise<Extract<SiteFundedCodexAdmission, { allowed: true }>> {
  const caller = getHubCaller();
  if (!caller) {
    throw Object.assign(
      new Error("Site-funded AI admission is temporarily unavailable."),
      { code: "unavailable" },
    );
  }
  // A transient settlement failure from the preceding turn must be retried
  // before admission, otherwise the account concurrency guard sees its old
  // reservation as active.
  await flushSiteFundedCodexOutbox();
  const admission = (await callHub({
    ...caller,
    name: "hosts.reserveSiteFundedCodexTurn",
    args: [
      {
        account_id: accountId,
        project_id: projectId,
        funded_turn_id: fundedTurnId,
        idempotency_key: idempotencyKey,
        path,
        // Old hubs know only Codex: send the field only when it matters.
        ...(provider === "openai" ? {} : { provider }),
      },
    ],
    timeout: 20_000,
  })) as SiteFundedCodexAdmission;
  if (!admission.allowed) {
    throw Object.assign(new Error(admission.reason), {
      code: admission.code,
    });
  }
  return admission;
}

/** Whether the hub still holds a funded turn active. */
export async function heartbeatSiteFundedTurn(
  reservationId: string,
): Promise<boolean> {
  const caller = getHubCaller();
  if (!caller) return true;
  const result = await callHub({
    ...caller,
    name: "hosts.heartbeatSiteFundedCodexTurn",
    args: [{ reservation_id: reservationId }],
    timeout: 15_000,
  });
  return !!result?.active;
}

/** The site key funding an active Claude turn on this host. */
export async function getSiteFundedClaudeKey(
  reservationId: string,
): Promise<string> {
  const caller = getHubCaller();
  if (!caller) {
    throw new Error("Site-funded Claude is temporarily unavailable.");
  }
  const { api_key } = await callHub({
    ...caller,
    name: "hosts.getSiteFundedClaudeKey",
    args: [{ reservation_id: reservationId }],
    timeout: 15_000,
  });
  if (typeof api_key !== "string" || !api_key) {
    throw new Error("Site-funded Claude key is unavailable.");
  }
  return api_key;
}

export async function beginSiteFundedCodexTurn({
  accountId,
  projectId,
  fundedTurnId,
  idempotencyKey,
  path,
  apiKey,
}: {
  accountId: string;
  projectId: string;
  fundedTurnId: string;
  idempotencyKey: string;
  path?: string;
  apiKey: string;
}): Promise<CodexSiteFundedTurnRuntime> {
  const caller = getHubCaller();
  if (!caller) {
    throw Object.assign(
      new Error("Site-funded Codex admission is temporarily unavailable."),
      { code: "unavailable" },
    );
  }
  const reserve = async (
    request: CodexSiteFundedTurnRequest,
  ): Promise<Extract<SiteFundedCodexAdmission, { allowed: true }>> => {
    // A transient settlement failure from the preceding turn must be retried
    // before admission, otherwise the account concurrency guard sees its old
    // reservation as active and strands an otherwise healthy retained runtime.
    await flushSiteFundedCodexOutbox();
    const admission = (await callHub({
      ...caller,
      name: "hosts.reserveSiteFundedCodexTurn",
      args: [
        {
          account_id: accountId,
          project_id: projectId,
          funded_turn_id: request.fundedTurnId,
          idempotency_key: request.idempotencyKey,
          path: request.path,
        },
      ],
      timeout: 20_000,
    })) as SiteFundedCodexAdmission;
    if (!admission.allowed) {
      throw Object.assign(new Error(admission.reason), {
        code: admission.code,
      });
    }
    return admission;
  };
  const admission = await reserve({ fundedTurnId, idempotencyKey, path });
  let proxySession;
  try {
    proxySession = await startSiteFundedCodexProxySession({
      reservation: admission.reservation,
      apiKey,
      onUsage: persistUsageEvent,
    });
  } catch (err) {
    await finishSiteFundedTurn({
      reservation_id: admission.reservation.reservationId,
      status: "released",
      outcome: "provider proxy failed to start",
    });
    throw err;
  }
  let runtimeClosed = false;
  let activeFinish:
    | ((opts: {
        status: "committed" | "interrupted" | "failed" | "released";
        outcome?: string;
      }) => Promise<void>)
    | undefined;

  const createTurnRuntime = (
    currentAdmission: Extract<SiteFundedCodexAdmission, { allowed: true }>,
  ): CodexSiteFundedTurnRuntime => {
    let finished = false;
    const reservationId = currentAdmission.reservation.reservationId;
    const heartbeat = setInterval(() => {
      void callHub({
        ...caller,
        name: "hosts.heartbeatSiteFundedCodexTurn",
        args: [{ reservation_id: reservationId }],
        timeout: 15_000,
      })
        .then((result) => {
          // Requests after this are told why: its time limit, say.
          if (!result?.active) {
            proxySession.deactivate(
              reservationId,
              siteFundedTurnEndReason(currentAdmission.reservation),
            );
          }
        })
        .catch((err) => {
          logger.warn("site-funded Codex heartbeat failed", {
            reservationId,
            err: `${err}`,
          });
        });
    }, currentAdmission.reservation.heartbeatIntervalMs);
    heartbeat.unref();

    const finish: CodexSiteFundedTurnRuntime["finish"] = async ({
      status,
      outcome,
    }) => {
      if (finished) return;
      finished = true;
      clearInterval(heartbeat);
      proxySession.deactivate(reservationId);
      await finishSiteFundedTurn({
        reservation_id: reservationId,
        status,
        outcome,
      });
    };
    activeFinish = finish;

    return {
      reservation: currentAdmission.reservation,
      policy: currentAdmission.reservation.policy,
      usageWarning: currentAdmission.usageWarning,
      providerBaseUrl: proxySession.baseUrl,
      providerToken: proxySession.token,
      finish,
      beginTurn: async (request) => {
        if (runtimeClosed) {
          throw new Error("site-funded Codex runtime is closed");
        }
        if (!finished) {
          throw new Error(
            "cannot begin a site-funded Codex turn before the previous turn finishes",
          );
        }
        const nextAdmission = await reserve(request);
        try {
          proxySession.activate({
            reservation: nextAdmission.reservation,
            onUsage: persistUsageEvent,
          });
        } catch (err) {
          await finishSiteFundedTurn({
            reservation_id: nextAdmission.reservation.reservationId,
            status: "released",
            outcome: "provider proxy failed to activate",
          });
          throw err;
        }
        return createTurnRuntime(nextAdmission);
      },
      close: async () => {
        if (runtimeClosed) return;
        runtimeClosed = true;
        if (activeFinish) {
          await activeFinish({
            status: "released",
            outcome: "app-server runtime closed",
          });
        }
        proxySession.close();
      },
    };
  };

  return createTurnRuntime(admission);
}
