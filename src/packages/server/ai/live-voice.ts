/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */
// Account-home-bay admission and accounting. WebRTC media goes directly from
// the client to OpenAI; only control and usage events pass through this bay.
import WebSocket from "ws";
import { createHash } from "node:crypto";
import getPool from "@cocalc/database/pool";
import getLogger from "@cocalc/backend/logger";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { isAiLaunchDisabled } from "@cocalc/server/launch/kill-switches";
import { resolveMembershipForAccount } from "@cocalc/server/membership/resolve";
import { getExternalCredentialRouted } from "@cocalc/server/external-credentials/routing";
import { assertProjectCollaboratorAccessAllowRemote } from "@cocalc/server/conat/project-remote-access";
import { isValidUUID } from "@cocalc/util/misc";
import { to_bool } from "@cocalc/util/db-schema/site-defaults";
import type {
  LiveVoiceRequest,
  LiveVoiceResult,
} from "@cocalc/conat/hub/api/live-voice";
import {
  releaseChatSpeechUsage,
  reserveChatSpeechUsage,
  settleChatSpeechUsage,
  type ChatSpeechUsageReservation,
} from "./chat-speech-reservations";
import { getAIUsageStatus } from "./usage-status";

const log = getLogger("server:ai:live-voice");
const MAX_SECONDS = 120;
const LEASE_SECONDS = 25;
const RATE_MICROUSD_PER_MINUTE = 50_000;
const MAX_COST_MICROUSD = (MAX_SECONDS * RATE_MICROUSD_PER_MINUTE) / 60;
const API = "https://api.openai.com/v1/live/sessions";
const MODEL = "gpt-live-1";
const START_WINDOW_SECONDS = 60;
const START_LIMITS = { account: 6, credential: 20, bay: 120 } as const;
const MAX_CREDENTIAL_CALLS = 12;
const FAILURE_WINDOW_SECONDS = 5 * 60;
const FAILURE_LIMITS = { credential_failure: 5, bay_failure: 20 } as const;
const base = { max_seconds: MAX_SECONDS, usd_per_minute: 0.05 };
let schema: Promise<void> | undefined;
let sweeping: Promise<void> | undefined;
let cleanupStopped = false;
let cleanupNeeded: boolean | undefined;

type FundingSource = "site" | "account" | "project";
interface Lease {
  request_id: string;
  account_id: string;
  project_id: string;
  provider_id?: string;
  created_at: Date;
  expires_at: Date;
  heartbeat_at: Date;
  ended: boolean;
  funding_source: FundingSource;
  usage_seconds: number;
  final_usage: boolean;
  provider_closed: boolean;
  close_attempts: number;
  credential_hash?: string;
  creation_failed: boolean;
}

interface Monitor {
  socket: WebSocket;
  confirmedClosed: Promise<void>;
  providerClosed: boolean;
  usageSeconds: number;
}
const monitors = new Map<string, Monitor>();

async function ensureSchema() {
  cleanupNeeded = true;
  schema ??= (async () => {
    const statements = `
      CREATE TABLE IF NOT EXISTS live_voice_sessions (
        request_id UUID PRIMARY KEY,
        account_id UUID NOT NULL,
        project_id UUID NOT NULL,
        provider_id TEXT,
        funding_source TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        closing_at TIMESTAMPTZ,
        ended BOOLEAN NOT NULL DEFAULT FALSE,
        usage_seconds INTEGER NOT NULL DEFAULT 0,
        final_usage BOOLEAN NOT NULL DEFAULT FALSE,
        provider_closed BOOLEAN NOT NULL DEFAULT FALSE,
        close_attempts INTEGER NOT NULL DEFAULT 0,
        retry_after TIMESTAMPTZ,
        credential_hash TEXT,
        credential_slot SMALLINT,
        creation_failed BOOLEAN NOT NULL DEFAULT FALSE
      );
      ALTER TABLE live_voice_sessions
        ADD COLUMN IF NOT EXISTS provider_closed BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE live_voice_sessions
        ADD COLUMN IF NOT EXISTS close_attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE live_voice_sessions
        ADD COLUMN IF NOT EXISTS retry_after TIMESTAMPTZ;
      ALTER TABLE live_voice_sessions
        ADD COLUMN IF NOT EXISTS credential_hash TEXT;
      ALTER TABLE live_voice_sessions
        ADD COLUMN IF NOT EXISTS credential_slot SMALLINT;
      ALTER TABLE live_voice_sessions
        ADD COLUMN IF NOT EXISTS creation_failed BOOLEAN NOT NULL DEFAULT FALSE;
      CREATE UNIQUE INDEX IF NOT EXISTS live_voice_one_account
        ON live_voice_sessions(account_id) WHERE NOT ended;
      CREATE UNIQUE INDEX IF NOT EXISTS live_voice_credential_slots
        ON live_voice_sessions(credential_hash, credential_slot)
        WHERE NOT ended;
      CREATE INDEX IF NOT EXISTS live_voice_ended_retention
        ON live_voice_sessions(created_at) WHERE ended;
      CREATE TABLE IF NOT EXISTS live_voice_start_limits (
        scope TEXT NOT NULL,
        identifier TEXT NOT NULL,
        window_start BIGINT NOT NULL,
        attempts INTEGER NOT NULL,
        PRIMARY KEY (scope, identifier, window_start)
      );
      CREATE INDEX IF NOT EXISTS live_voice_start_limits_retention
        ON live_voice_start_limits(window_start);
    `;
    // PGlite prepares queries and requires one statement per call.
    for (const statement of statements.split(";")) {
      if (statement.trim()) await getPool().query(statement);
    }
  })().catch((error) => {
    schema = undefined;
    throw error;
  });
  await schema;
}

function credentialHash(apiKey: string) {
  return createHash("sha256").update(apiKey).digest("hex");
}

async function limitStartAttempts(accountId: string, keyId: string) {
  const windowStart =
    Math.floor(Date.now() / (START_WINDOW_SECONDS * 1000)) *
    START_WINDOW_SECONDS;
  const failureWindow =
    Math.floor(Date.now() / (FAILURE_WINDOW_SECONDS * 1000)) *
    FAILURE_WINDOW_SECONDS;
  for (const [scope, identifier, maximum] of [
    ["credential_failure", keyId, FAILURE_LIMITS.credential_failure],
    ["bay_failure", "all", FAILURE_LIMITS.bay_failure],
  ] as const) {
    const { rows } = await getPool().query<{ attempts: number }>(
      `SELECT attempts FROM live_voice_start_limits
       WHERE scope=$1 AND identifier=$2 AND window_start=$3`,
      [scope, identifier, failureWindow],
    );
    if ((rows[0]?.attempts ?? 0) >= maximum)
      throw new Error(
        "Live voice starts are temporarily paused after provider failures.",
      );
  }
  for (const [scope, identifier, maximum] of [
    ["account", accountId, START_LIMITS.account],
    ["credential", keyId, START_LIMITS.credential],
    ["bay", "all", START_LIMITS.bay],
  ] as const) {
    const { rows } = await getPool().query<{ attempts: number }>(
      `INSERT INTO live_voice_start_limits
         (scope,identifier,window_start,attempts) VALUES ($1,$2,$3,1)
       ON CONFLICT (scope,identifier,window_start)
       DO UPDATE SET attempts=live_voice_start_limits.attempts+1
       RETURNING attempts`,
      [scope, identifier, windowStart],
    );
    if (rows[0].attempts > maximum)
      throw new Error("Too many live voice starts. Try again in a minute.");
  }
}

async function recordProviderFailure(keyId: string) {
  const windowStart =
    Math.floor(Date.now() / (FAILURE_WINDOW_SECONDS * 1000)) *
    FAILURE_WINDOW_SECONDS;
  for (const [scope, identifier] of [
    ["credential_failure", keyId],
    ["bay_failure", "all"],
  ] as const)
    await getPool().query(
      `INSERT INTO live_voice_start_limits
         (scope,identifier,window_start,attempts) VALUES ($1,$2,$3,1)
       ON CONFLICT (scope,identifier,window_start)
       DO UPDATE SET attempts=live_voice_start_limits.attempts+1`,
      [scope, identifier, windowStart],
    );
}

async function ownCredential(
  account_id: string,
  project_id: string,
  source?: "account" | "project",
) {
  for (const scope of source ? [source] : (["project", "account"] as const)) {
    const result = await getExternalCredentialRouted({
      selector: {
        provider: "openai",
        kind: "openai-api-key",
        scope,
        ...(scope === "project"
          ? { project_id }
          : { owner_account_id: account_id }),
      },
      touchLastUsed: false,
    });
    if (result?.payload.trim())
      return { apiKey: result.payload.trim(), source: scope };
  }
  return undefined;
}

async function siteCredential() {
  const settings = (await getServerSettings()) as Record<string, unknown>;
  const apiKey = String(settings.openai_api_key ?? "").trim();
  return to_bool(settings.openai_enabled) &&
    !(await isAiLaunchDisabled()) &&
    apiKey
    ? { apiKey, source: "site" as const }
    : undefined;
}

async function credentialForLease(row: Lease) {
  // Admission switches must not prevent cleanup of sessions already created.
  const settings =
    row.funding_source === "site" ? await getServerSettings() : undefined;
  const siteKey = String(settings?.openai_api_key ?? "").trim();
  const credential =
    row.funding_source === "site"
      ? siteKey
        ? { apiKey: siteKey, source: "site" as const }
        : undefined
      : await ownCredential(row.account_id, row.project_id, row.funding_source);
  if (!credential) throw new Error("Live voice credential is unavailable.");
  return credential;
}

async function allowance(
  account_id: string,
): Promise<LiveVoiceResult["allowance"]> {
  const status = await getAIUsageStatus({ account_id });
  return status.windows.map((window) => ({
    window: window.window,
    remaining_percent:
      typeof window.limit === "number" && window.limit > 0
        ? Math.max(
            0,
            Math.min(
              100,
              Math.round(
                (100 *
                  (window.remaining ??
                    Math.max(0, window.limit - window.used))) /
                  window.limit,
              ),
            ),
          )
        : 0,
    resets_at: window.resets_at?.getTime() ?? window.reset_at?.getTime(),
  }));
}

async function eligibility(
  account_id: string,
  project_id: string,
  preference: LiveVoiceRequest["funding_preference"],
) {
  const own = await ownCredential(account_id, project_id);
  const own_key_available = !!own;
  if (preference === "own") {
    return {
      credential: own,
      own_key_available,
      allowance: await allowance(account_id).catch(() => undefined),
      reason: own ? undefined : "Connect an account or project OpenAI API key.",
    };
  }
  const membership = await resolveMembershipForAccount(account_id);
  const usage = await allowance(account_id);
  if (membership.class === "free") {
    return {
      credential: undefined,
      own_key_available,
      allowance: usage,
      reason: own
        ? "Included live voice requires a paid membership. Select your own API key to continue."
        : "Live voice requires a paid membership or your own OpenAI API key.",
    };
  }
  const site = await siteCredential();
  if (!site) {
    return {
      credential: undefined,
      own_key_available,
      allowance: usage,
      reason: "Included live voice is unavailable right now.",
    };
  }
  if (usage?.some((window) => window.remaining_percent <= 0)) {
    return {
      credential: undefined,
      own_key_available,
      allowance: usage,
      reason: "Your included AI allowance is exhausted.",
    };
  }
  return { credential: site, own_key_available, allowance: usage };
}

export function liveSessionConfiguration(
  history: LiveVoiceRequest["history"] = [],
) {
  if (
    !Array.isArray(history) ||
    history.length > 20 ||
    history.some(
      (x) =>
        !x ||
        !["user", "assistant"].includes(x.role) ||
        typeof x.text !== "string",
    ) ||
    history.reduce((n, x) => n + x.text.length, 0) > 8000
  ) {
    throw new Error("Invalid live conversation history.");
  }
  return {
    model: MODEL,
    store: false,
    delegation: { type: "client" },
    instructions:
      "You are the voice interface to the user's selected CoCalc agent. Be concise and conversational. CoCalc sends a bounded progress report from the selected turn using only the compact user-visible agent-message preview and turn state. Answer questions about current progress from that report without delegating or starting work. State clearly when information is unavailable or the progress feed is disconnected; do not infer progress from silence or claim to know which command or test is running. Delegate instructions to do or change work to the existing agent. During a running turn, delegated instructions become guidance to that turn. Never claim guidance or new work was accepted or completed until the app reports it. Ask for clarification if a request is ambiguous. Interrupting your speech or ending this call does not stop agent work. Approvals and stopping work use visible chat controls; spoken agreement alone does not approve privileged operations. Do not repeat an already delegated instruction or disclose hidden reasoning.",
    input: history.map(({ role, text }) => ({
      type: "message",
      role,
      content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    })),
    client: {
      data_channel: {
        allowed_client_events: [
          "session.close",
          "session.input_audio.mute",
          "session.input_audio.unmute",
          "session.thinking.append",
          "session.commentary.append",
        ],
        allowed_server_events: [
          "session.started",
          "session.closed",
          "session.usage.updated",
          "error",
          "session.input_transcript.delta",
          "session.output_transcript.delta",
          "session.delegation.created",
          "session.thinking.appended",
          "session.commentary.appended",
        ].map((type) => ({ type })),
      },
    },
  };
}

function attachMonitor(row: Lease, apiKey: string): Promise<void> {
  if (!row.provider_id)
    throw new Error("Live voice session has no provider ID.");
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `wss://api.openai.com/v1/live/sessions/${encodeURIComponent(row.provider_id!)}/attach`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    let opened = false;
    let done = false;
    let resolveConfirmedClosed!: () => void;
    const confirmedClosed = new Promise<void>(
      (r) => (resolveConfirmedClosed = r),
    );
    const timeout = setTimeout(() => {
      if (!opened) socket.terminate();
    }, 8_000);
    socket.on("open", () => {
      opened = true;
      clearTimeout(timeout);
      monitors.set(row.request_id, {
        socket,
        confirmedClosed,
        providerClosed: false,
        usageSeconds: 0,
      });
      resolve();
    });
    socket.on("message", (bytes) => {
      let event: { type?: string; usage?: { seconds?: number } };
      try {
        event = JSON.parse(String(bytes));
      } catch {
        return;
      }
      const seconds = event.usage?.seconds;
      let update: Promise<unknown> = Promise.resolve();
      const validSeconds =
        typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0;
      if (
        event.type === "session.closed" ||
        (event.type === "session.usage.updated" && validSeconds)
      ) {
        const monitor = monitors.get(row.request_id);
        if (monitor && validSeconds)
          monitor.usageSeconds = Math.max(monitor.usageSeconds, seconds);
        update = getPool()
          .query(
            `UPDATE live_voice_sessions SET
               usage_seconds=GREATEST(usage_seconds,$2),
               final_usage=final_usage OR $3,
               provider_closed=provider_closed OR $4
             WHERE request_id=$1`,
            [
              row.request_id,
              validSeconds ? Math.ceil(seconds) : 0,
              event.type === "session.closed" && validSeconds,
              event.type === "session.closed",
            ],
          )
          .catch((error) =>
            log.warn("live voice usage update failed", {
              request_id: row.request_id,
              error: String(error),
            }),
          );
      }
      if (event.type === "session.closed") {
        const monitor = monitors.get(row.request_id);
        if (monitor) monitor.providerClosed = true;
        void update.finally(() => {
          resolveConfirmedClosed();
          void finishSession(row.request_id).catch((error) =>
            log.warn("live voice finalization pending", {
              request_id: row.request_id,
              error: String(error),
            }),
          );
        });
      }
    });
    socket.on("error", (error) => {
      if (!opened && !done) {
        done = true;
        clearTimeout(timeout);
        reject(error);
      }
    });
    socket.on("close", () => {
      clearTimeout(timeout);
      if (!opened && !done) {
        done = true;
        reject(new Error("Could not attach live voice usage monitor."));
      }
      if (monitors.get(row.request_id)?.socket === socket) {
        monitors.delete(row.request_id);
      }
    });
  });
}

// Creation can succeed just before its provider ID fails to save. Close that
// specific provider session with the key already in memory; never retry POST.
async function closeUnrecordedProvider(providerId: string, apiKey: string) {
  return await new Promise<boolean>((resolve) => {
    const socket = new WebSocket(
      `wss://api.openai.com/v1/live/sessions/${encodeURIComponent(providerId)}/attach`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    let done = false;
    const finish = (closed: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      socket.close();
      resolve(closed);
    };
    const timeout = setTimeout(() => {
      socket.terminate();
      finish(false);
    }, 10_000);
    socket.on("open", () =>
      socket.send(JSON.stringify({ type: "session.close" })),
    );
    socket.on("message", (bytes) => {
      try {
        if (JSON.parse(String(bytes)).type === "session.closed") finish(true);
      } catch {
        // Keep waiting for a valid terminal event.
      }
    });
    socket.on("error", () => finish(false));
    socket.on("close", () => finish(false));
  });
}

async function finishSession(request_id: string, knownFailure = false) {
  const { rows } = await getPool().query<Lease>(
    `UPDATE live_voice_sessions SET closing_at=NOW()
     WHERE request_id=$1 AND NOT ended
       AND (retry_after IS NULL OR retry_after <= NOW())
       AND (closing_at IS NULL OR closing_at < NOW()-INTERVAL '30 seconds')
     RETURNING *`,
    [request_id],
  );
  const row = rows[0];
  if (!row) return;
  knownFailure ||= row.creation_failed;
  let monitor = monitors.get(request_id);
  try {
    if (row.provider_id) {
      if (
        !row.provider_closed &&
        !monitor?.providerClosed &&
        (!monitor || monitor.socket.readyState !== WebSocket.OPEN)
      ) {
        try {
          const key = await credentialForLease(row);
          await attachMonitor(row, key.apiKey);
          monitor = monitors.get(request_id);
        } catch (error) {
          log.warn("live voice monitor reattach failed", {
            request_id,
            error: String(error),
          });
        }
      }
      if (
        !row.provider_closed &&
        monitor?.socket.readyState === WebSocket.OPEN &&
        !monitor.providerClosed
      ) {
        monitor.socket.send(JSON.stringify({ type: "session.close" }));
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            monitor.confirmedClosed,
            new Promise((resolve) => {
              timeout = setTimeout(resolve, 3_000);
            }),
          ]);
        } finally {
          clearTimeout(timeout);
        }
      }
    }
    const latest = await getPool().query<Lease>(
      "SELECT * FROM live_voice_sessions WHERE request_id=$1",
      [request_id],
    );
    const usage = latest.rows[0] ?? row;
    if (row.provider_id && monitor?.providerClosed && !usage.provider_closed) {
      await getPool().query(
        `UPDATE live_voice_sessions SET provider_closed=TRUE,
           usage_seconds=GREATEST(usage_seconds,$2),
           final_usage=final_usage OR $3 WHERE request_id=$1`,
        [request_id, Math.ceil(monitor.usageSeconds), monitor.usageSeconds > 0],
      );
      usage.provider_closed = true;
      if (monitor.usageSeconds > 0) {
        usage.final_usage = true;
        usage.usage_seconds = Math.max(
          usage.usage_seconds,
          monitor.usageSeconds,
        );
      }
    }
    if (row.provider_id && !usage.provider_closed)
      throw new Error("Provider closure has not been confirmed.");
    if (!row.provider_id && !knownFailure)
      throw new Error("Provider creation outcome is unknown.");
    if (usage.usage_seconds > MAX_SECONDS)
      log.error("live voice provider duration exceeded reserved allowance", {
        request_id,
        provider_id: row.provider_id,
        provider_seconds: usage.usage_seconds,
        reserved_seconds: MAX_SECONDS,
      });
    if (row.funding_source === "site") {
      const reservation: ChatSpeechUsageReservation = {
        accountId: row.account_id,
        requestId: request_id,
        reservedMicrousd: MAX_COST_MICROUSD,
      };
      if (knownFailure) {
        await releaseChatSpeechUsage(reservation);
      } else {
        const seconds = !usage.final_usage
          ? MAX_SECONDS
          : Math.min(
              MAX_SECONDS,
              Math.max(15, usage.usage_seconds, monitor?.usageSeconds ?? 0),
            );
        await settleChatSpeechUsage({
          reservation,
          projectId: row.project_id,
          operation: "live",
          model: MODEL,
          costMicrousd: Math.ceil((seconds * RATE_MICROUSD_PER_MINUTE) / 60),
          durationMs: seconds * 1000,
          providerRequestId: row.provider_id,
          elapsedMs: Math.max(
            0,
            Date.now() - new Date(row.created_at).getTime(),
          ),
        });
      }
    }
    await getPool().query(
      "UPDATE live_voice_sessions SET ended=TRUE, closing_at=NULL, retry_after=NULL WHERE request_id=$1",
      [request_id],
    );
    monitor?.socket.close();
    monitors.delete(request_id);
  } catch (error) {
    const attempts = row.close_attempts + 1;
    const retrySeconds = Math.min(300, 5 * 2 ** Math.min(attempts - 1, 6));
    await getPool()
      .query(
        `UPDATE live_voice_sessions SET closing_at=NULL,
           close_attempts=close_attempts+1,
           retry_after=NOW()+($2 * INTERVAL '1 second')
         WHERE request_id=$1 AND NOT ended`,
        [request_id, retrySeconds],
      )
      .catch((dbError) =>
        log.error("live voice closure state could not be persisted", {
          request_id,
          provider_id: row.provider_id,
          error: String(dbError),
        }),
      );
    if (attempts >= 3)
      log.error("live voice provider closure needs operator attention", {
        request_id,
        provider_id: row.provider_id,
        attempts,
        error: String(error),
      });
    throw error;
  }
}

export function sweepLiveVoiceSessions(): Promise<void> {
  if (cleanupStopped) return Promise.resolve();
  return (sweeping ??= runSweep().finally(() => {
    sweeping = undefined;
  }));
}

async function runSweep() {
  try {
    if (cleanupNeeded === false) return;
    if (
      cleanupNeeded == null &&
      process.env.COCALC_LIVE_VOICE_ENABLED !== "1" &&
      process.env.COCALC_LIVE_VOICE_DEV !== "1"
    ) {
      // A disabled deployment still owns outstanding calls from before restart.
      // Do not create tables or keep polling on sites that never enabled voice.
      const { rows } = await getPool().query(
        "SELECT to_regclass('live_voice_sessions') AS sessions",
      );
      cleanupNeeded = rows[0]?.sessions != null;
      if (!cleanupNeeded) return;
    }
    await ensureSchema();
    const { rows } = await getPool().query<Lease>(`
      SELECT * FROM live_voice_sessions
      WHERE NOT ended AND
        (expires_at < NOW() OR heartbeat_at < NOW() - INTERVAL '25 seconds')
        AND (retry_after IS NULL OR retry_after <= NOW())
      LIMIT 20
    `);
    for (const row of rows) {
      if (
        !row.provider_id &&
        Date.now() - new Date(row.heartbeat_at).getTime() < 60_000
      )
        continue;
      await finishSession(row.request_id).catch((error) =>
        log.warn("live voice cleanup pending", {
          request_id: row.request_id,
          error: String(error),
        }),
      );
    }
    await getPool().query(
      "DELETE FROM live_voice_sessions WHERE ended AND created_at < NOW() - INTERVAL '30 days'",
    );
    await getPool().query(
      "DELETE FROM live_voice_start_limits WHERE window_start < EXTRACT(EPOCH FROM NOW()) - 86400",
    );
  } catch (error) {
    log.warn("live voice cleanup failed", { error: String(error) });
  }
}

const cleanupTimer = setInterval(() => void sweepLiveVoiceSessions(), 5000);
cleanupTimer.unref();

/** Drain cleanup before closing its database connection (including in tests). */
export async function stopLiveVoiceCleanup() {
  cleanupStopped = true;
  clearInterval(cleanupTimer);
  await sweeping;
}

export async function liveVoice(
  opts: LiveVoiceRequest,
): Promise<LiveVoiceResult> {
  const { account_id, project_id, action } = opts;
  if (!account_id || !isValidUUID(account_id) || !isValidUUID(project_id))
    throw new Error("Invalid live voice account or project.");
  if (!["capabilities", "start", "heartbeat", "end"].includes(action))
    throw new Error("Invalid live voice action.");
  const enabled =
    process.env.COCALC_LIVE_VOICE_ENABLED === "1" ||
    (process.env.COCALC_LIVE_VOICE_DEV === "1" && (await isAdmin(account_id)));
  if (!enabled && action !== "end") {
    if (action === "capabilities")
      return { ...base, enabled: false, reason: "Live voice is not enabled." };
    throw new Error("Live voice is not enabled.");
  }
  // End stays available after project access is removed.
  if (action !== "end")
    await assertProjectCollaboratorAccessAllowRemote({
      account_id,
      project_id,
    });
  if (action === "capabilities") {
    const choice = await eligibility(
      account_id,
      project_id,
      opts.funding_preference,
    );
    return {
      ...base,
      enabled: !!choice.credential,
      reason: choice.reason,
      funding_source: choice.credential?.source,
      own_key_available: choice.own_key_available,
      allowance: choice.allowance,
    };
  }
  await ensureSchema();
  if (action === "start") {
    if (
      !opts.request_id ||
      !isValidUUID(opts.request_id) ||
      typeof opts.sdp !== "string" ||
      !opts.sdp.startsWith("v=0") ||
      opts.sdp.length > 100_000
    )
      throw new Error("Invalid live voice offer.");
    const session = liveSessionConfiguration(opts.history);
    const choice = await eligibility(
      account_id,
      project_id,
      opts.funding_preference,
    );
    const key = choice.credential;
    if (!key) throw new Error(choice.reason ?? "Live voice is unavailable.");
    const keyId = credentialHash(key.apiKey);
    await limitStartAttempts(account_id, keyId);
    // Cleanup may be waiting on an unrelated provider. Admission stays bounded;
    // active-account and credential-slot constraints still protect old calls.
    void sweepLiveVoiceSessions();
    const expires_at = Date.now() + MAX_SECONDS * 1000;
    let inserted = false;
    for (let attempt = 0; attempt < 3 && !inserted; attempt++) {
      const result = await getPool().query(
        `INSERT INTO live_voice_sessions
           (request_id,account_id,project_id,expires_at,funding_source,
            credential_hash,credential_slot)
         SELECT $1,$2,$3,$4,$5,$6,available.slot
         FROM generate_series(1,$7) AS available(slot)
         WHERE NOT EXISTS (
           SELECT 1 FROM live_voice_sessions AS active
           WHERE NOT active.ended AND active.credential_hash=$6
             AND active.credential_slot=available.slot
         )
         ORDER BY available.slot LIMIT 1
         ON CONFLICT DO NOTHING RETURNING request_id`,
        [
          opts.request_id,
          account_id,
          project_id,
          new Date(expires_at),
          key.source,
          keyId,
          MAX_CREDENTIAL_CALLS,
        ],
      );
      inserted = result.rows.length > 0;
    }
    if (!inserted) {
      const active = await getPool().query(
        `SELECT request_id FROM live_voice_sessions
         WHERE account_id=$1 AND NOT ended LIMIT 1`,
        [account_id],
      );
      if (active.rows.length)
        throw new Error(
          "A live call is already starting or active. End it before starting another; do not retry an uncertain start.",
        );
      throw new Error("This OpenAI key has too many active live calls.");
    }
    if (key.source === "site") {
      try {
        await reserveChatSpeechUsage({
          accountId: account_id,
          requestId: opts.request_id,
          operation: "live",
          model: MODEL,
          reservedMicrousd: MAX_COST_MICROUSD,
        });
      } catch (error) {
        await getPool().query(
          "UPDATE live_voice_sessions SET ended=TRUE WHERE request_id=$1",
          [opts.request_id],
        );
        throw error;
      }
    }
    let provider_id: string | undefined;
    let providerRecorded = false;
    let knownFailure = false;
    try {
      const response = await fetch(API, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + key.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session,
          transport: { type: "webrtc", sdp: opts.sdp },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        knownFailure = true;
        // Preserve a definite rejection across release failures and restarts.
        await getPool().query(
          "UPDATE live_voice_sessions SET creation_failed=TRUE WHERE request_id=$1",
          [opts.request_id],
        );
        throw new Error(
          "OpenAI live voice creation failed (" +
            response.status +
            "). Check this key's GPT-Live access.",
        );
      }
      const result = (await response.json()) as {
        session?: { id?: string };
        transport?: { sdp?: string };
      };
      provider_id = result.session?.id;
      if (provider_id) {
        await getPool().query(
          "UPDATE live_voice_sessions SET provider_id=$2, heartbeat_at=NOW() WHERE request_id=$1",
          [opts.request_id, provider_id],
        );
        providerRecorded = true;
      }
      if (!provider_id || typeof result.transport?.sdp !== "string")
        throw new Error("Invalid live voice session response.");
      await attachMonitor(
        {
          request_id: opts.request_id,
          account_id,
          project_id,
          provider_id,
          funding_source: key.source,
          created_at: new Date(),
          expires_at: new Date(expires_at),
          heartbeat_at: new Date(),
          ended: false,
          usage_seconds: 0,
          final_usage: false,
          provider_closed: false,
          close_attempts: 0,
          creation_failed: false,
        },
        key.apiKey,
      );
      return {
        ...base,
        enabled: true,
        session_id: opts.request_id,
        sdp: result.transport.sdp,
        expires_at,
        funding_source: key.source,
        own_key_available: choice.own_key_available,
        allowance: choice.allowance,
      };
    } catch (error) {
      if (!provider_id)
        await recordProviderFailure(keyId).catch((recordError) =>
          log.error("live voice provider failure could not be recorded", {
            request_id: opts.request_id,
            error: String(recordError),
          }),
        );
      if (provider_id && !providerRecorded) {
        try {
          await getPool().query(
            "UPDATE live_voice_sessions SET provider_id=$2 WHERE request_id=$1",
            [opts.request_id, provider_id],
          );
          providerRecorded = true;
        } catch (dbError) {
          log.error("live voice provider ID could not be persisted", {
            request_id: opts.request_id,
            provider_id,
            error: String(dbError),
          });
          const closed = await closeUnrecordedProvider(
            provider_id,
            key.apiKey,
          ).catch(() => false);
          if (closed) {
            await getPool()
              .query(
                `UPDATE live_voice_sessions SET provider_id=$2,
                   provider_closed=TRUE WHERE request_id=$1`,
                [opts.request_id, provider_id],
              )
              .catch((retryError) =>
                log.error("closed live voice session could not be recorded", {
                  request_id: opts.request_id,
                  provider_id,
                  error: String(retryError),
                }),
              );
          } else {
            log.error(
              "unrecorded live voice session needs operator attention",
              {
                request_id: opts.request_id,
                provider_id,
              },
            );
          }
        }
      }
      await finishSession(opts.request_id, knownFailure).catch((cleanupError) =>
        log.warn("live voice startup cleanup pending", {
          request_id: opts.request_id,
          error: String(cleanupError),
        }),
      );
      throw error;
    }
  }
  if (!opts.session_id || !isValidUUID(opts.session_id))
    throw new Error("Invalid live voice session.");
  const { rows } = await getPool().query<Lease>(
    "SELECT * FROM live_voice_sessions WHERE request_id=$1 AND account_id=$2 AND project_id=$3",
    [opts.session_id, account_id, project_id],
  );
  const row = rows[0];
  if (!row) throw new Error("Live voice session not found.");
  if (action === "end") {
    if (!row.ended) await finishSession(row.request_id);
    const latest = await getPool().query<Lease>(
      "SELECT * FROM live_voice_sessions WHERE request_id=$1",
      [row.request_id],
    );
    if (!latest.rows[0]?.ended)
      throw new Error("Live voice provider closure is still pending.");
    return {
      ...base,
      enabled: false,
      allowance:
        row.funding_source === "site" ? await allowance(account_id) : undefined,
    };
  }
  if (
    row.ended ||
    new Date(row.expires_at).getTime() <= Date.now() ||
    Date.now() - new Date(row.heartbeat_at).getTime() > LEASE_SECONDS * 1000
  )
    throw new Error("Live call ended or expired. Start a new call explicitly.");
  await getPool().query(
    "UPDATE live_voice_sessions SET heartbeat_at=NOW() WHERE request_id=$1 AND NOT ended",
    [opts.session_id],
  );
  return {
    ...base,
    enabled: true,
    expires_at: new Date(row.expires_at).getTime(),
    funding_source: row.funding_source,
    allowance:
      row.funding_source === "site" ? await allowance(account_id) : undefined,
  };
}
