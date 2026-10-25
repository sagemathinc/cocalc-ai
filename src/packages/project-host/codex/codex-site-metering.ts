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
import type {
  SiteFundedCodexAdmission,
  SiteFundedCodexUsageEvent,
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

/** Records one funded provider request's usage: durable, then retried. */
export async function persistSiteFundedUsageEvent(
  event: SiteFundedCodexUsageEvent,
): Promise<void> {
  // Queued synchronously, in the order of the calls.
  enqueueOutbox("usage", event);
  await flushSiteFundedCodexOutbox();
}

const persistUsageEvent = persistSiteFundedUsageEvent;

/** Settles a funded turn: durable, then retried. */
export async function finishSiteFundedTurn(finish: {
  reservation_id: string;
  status: "committed" | "interrupted" | "failed" | "released";
  outcome?: string;
}): Promise<void> {
  enqueueOutbox("finish", finish);
  await flushSiteFundedCodexOutbox();
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
    enqueueOutbox("finish", {
      reservation_id: admission.reservation.reservationId,
      status: "released",
      outcome: "provider proxy failed to start",
    });
    await flushSiteFundedCodexOutbox();
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
          if (!result?.active) proxySession.deactivate(reservationId);
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
      enqueueOutbox("finish", {
        reservation_id: reservationId,
        status,
        outcome,
      });
      await flushSiteFundedCodexOutbox();
    };
    activeFinish = finish;

    return {
      reservation: currentAdmission.reservation,
      policy: currentAdmission.reservation.policy,
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
          enqueueOutbox("finish", {
            reservation_id: nextAdmission.reservation.reservationId,
            status: "released",
            outcome: "provider proxy failed to activate",
          });
          await flushSiteFundedCodexOutbox();
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
