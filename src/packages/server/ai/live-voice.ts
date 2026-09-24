/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */
// Account-home-bay admission and accounting. WebRTC media goes directly from
// the client to OpenAI; only control and usage events pass through this bay.
import WebSocket from "ws";
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
const base = { max_seconds: MAX_SECONDS, usd_per_minute: 0.05 };
let schema: Promise<void> | undefined;
let sweeping = false;

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
}

interface Monitor {
  socket: WebSocket;
  closed: Promise<void>;
  resolveClosed: () => void;
  finalUsage: boolean;
  usageSeconds: number;
}
const monitors = new Map<string, Monitor>();

async function ensureSchema() {
  schema ??= getPool()
    .query(
      `
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
        final_usage BOOLEAN NOT NULL DEFAULT FALSE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS live_voice_one_account
        ON live_voice_sessions(account_id) WHERE NOT ended;
    `,
    )
    .then(() => {})
    .catch((error) => {
      schema = undefined;
      throw error;
    });
  await schema;
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
  const credential =
    row.funding_source === "site"
      ? await siteCredential()
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
      "You are the voice interface to the user's selected CoCalc agent. Be concise and conversational. Delegate every request to do project work or obtain project facts to the backend. The app sends spoken requests to that existing agent. Never claim a task was accepted or completed until the app reports it. Ask for clarification if a request is ambiguous. Interrupting your speech or ending this call does not stop agent work. Approvals and stopping work use the visible chat controls; spoken agreement alone does not approve privileged operations. Report only actual backend results. Do not repeat an already delegated task.",
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
    let resolveClosed!: () => void;
    const closed = new Promise<void>((r) => (resolveClosed = r));
    const timeout = setTimeout(() => {
      if (!opened) socket.terminate();
    }, 8_000);
    socket.on("open", () => {
      opened = true;
      clearTimeout(timeout);
      monitors.set(row.request_id, {
        socket,
        closed,
        resolveClosed,
        finalUsage: false,
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
      if (
        (event.type === "session.usage.updated" ||
          event.type === "session.closed") &&
        typeof seconds === "number" &&
        Number.isFinite(seconds) &&
        seconds >= 0
      ) {
        const monitor = monitors.get(row.request_id);
        if (monitor)
          monitor.usageSeconds = Math.max(monitor.usageSeconds, seconds);
        update = getPool()
          .query(
            `UPDATE live_voice_sessions SET
               usage_seconds=GREATEST(usage_seconds,$2),
               final_usage=final_usage OR $3
             WHERE request_id=$1`,
            [
              row.request_id,
              Math.min(MAX_SECONDS, Math.ceil(seconds)),
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
        if (monitor) monitor.finalUsage = true;
        resolveClosed();
        void update.finally(() =>
          finishSession(row.request_id).catch((error) =>
            log.warn("live voice finalization pending", {
              request_id: row.request_id,
              error: String(error),
            }),
          ),
        );
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
        resolveClosed();
      }
    });
  });
}

async function finishSession(request_id: string, knownFailure = false) {
  const { rows } = await getPool().query<Lease>(
    `UPDATE live_voice_sessions SET closing_at=NOW()
     WHERE request_id=$1 AND NOT ended
       AND (closing_at IS NULL OR closing_at < NOW()-INTERVAL '30 seconds')
     RETURNING *`,
    [request_id],
  );
  const row = rows[0];
  if (!row) return;
  let monitor = monitors.get(request_id);
  try {
    if (row.provider_id) {
      if (
        !row.final_usage &&
        !monitor?.finalUsage &&
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
        !row.final_usage &&
        monitor?.socket.readyState === WebSocket.OPEN &&
        !monitor.finalUsage
      ) {
        monitor.socket.send(JSON.stringify({ type: "session.close" }));
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            monitor.closed,
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
    if (row.funding_source === "site") {
      const reservation: ChatSpeechUsageReservation = {
        accountId: row.account_id,
        requestId: request_id,
        reservedMicrousd: MAX_COST_MICROUSD,
      };
      if (knownFailure) {
        await releaseChatSpeechUsage(reservation);
      } else {
        const elapsed = Math.ceil(
          (Date.now() - new Date(row.created_at).getTime()) / 1000,
        );
        // A timed-out creation request can have succeeded at the provider
        // without returning its session ID. Charge the reserved upper bound.
        const seconds =
          !row.provider_id || !(usage.final_usage || monitor?.finalUsage)
            ? MAX_SECONDS
            : Math.min(
                MAX_SECONDS,
                Math.max(
                  15,
                  usage.final_usage || monitor?.finalUsage
                    ? Math.max(usage.usage_seconds, monitor?.usageSeconds ?? 0)
                    : elapsed,
                ),
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
      "UPDATE live_voice_sessions SET ended=TRUE, closing_at=NULL WHERE request_id=$1",
      [request_id],
    );
    monitor?.socket.close();
    monitors.delete(request_id);
  } catch (error) {
    await getPool().query(
      "UPDATE live_voice_sessions SET closing_at=NULL WHERE request_id=$1 AND NOT ended",
      [request_id],
    );
    throw error;
  }
}

async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    await ensureSchema();
    const { rows } = await getPool().query<Lease>(`
      SELECT * FROM live_voice_sessions
      WHERE NOT ended AND
        (expires_at < NOW() OR heartbeat_at < NOW() - INTERVAL '25 seconds')
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
  } catch (error) {
    log.warn("live voice cleanup failed", { error: String(error) });
  } finally {
    sweeping = false;
  }
}

if (
  process.env.COCALC_LIVE_VOICE_ENABLED === "1" ||
  process.env.COCALC_LIVE_VOICE_DEV === "1"
) {
  const timer = setInterval(() => void sweep(), 5000);
  timer.unref();
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
  if (!enabled) {
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
    await sweep();
    const expires_at = Date.now() + MAX_SECONDS * 1000;
    try {
      await getPool().query(
        `INSERT INTO live_voice_sessions
           (request_id,account_id,project_id,expires_at,funding_source)
         VALUES($1,$2,$3,$4,$5)`,
        [
          opts.request_id,
          account_id,
          project_id,
          new Date(expires_at),
          key.source,
        ],
      );
    } catch (error) {
      if ((error as any).code === "23505")
        throw new Error(
          "A live call is already starting or active. End it before starting another; do not retry an uncertain start.",
        );
      throw error;
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
      if (provider_id)
        await getPool().query(
          "UPDATE live_voice_sessions SET provider_id=$2, heartbeat_at=NOW() WHERE request_id=$1",
          [opts.request_id, provider_id],
        );
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
