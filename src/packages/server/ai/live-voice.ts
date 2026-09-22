/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */
// Development-only WebRTC admission. Media goes directly to OpenAI; chat work
// stays on the existing project-host connection. Never enabled for customers.
import getPool from "@cocalc/database/pool";
import getLogger from "@cocalc/backend/logger";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { getExternalCredentialRouted } from "@cocalc/server/external-credentials/routing";
import { assertProjectCollaboratorAccessAllowRemote } from "@cocalc/server/conat/project-remote-access";
import { isValidUUID } from "@cocalc/util/misc";
import type {
  LiveVoiceRequest,
  LiveVoiceResult,
} from "@cocalc/conat/hub/api/live-voice";

const log = getLogger("server:ai:live-voice");
const MAX_SECONDS = 120;
const LEASE_SECONDS = 25;
const API = "https://api.openai.com/v1/live/sessions";
const base = { max_seconds: MAX_SECONDS, usd_per_minute: 0.05 };
let schema: Promise<void> | undefined;
let sweeping = false;

interface Lease {
  request_id: string;
  account_id: string;
  project_id: string;
  provider_id?: string;
  expires_at: Date;
  heartbeat_at: Date;
  ended: boolean;
  funding_source: "account" | "project";
}

async function ensureSchema() {
  schema ??= getPool()
    .query(
      `
    CREATE TABLE IF NOT EXISTS development_live_voice_sessions (
      request_id UUID PRIMARY KEY,
      account_id UUID NOT NULL,
      project_id UUID NOT NULL,
      provider_id TEXT,
      funding_source TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS development_live_voice_one_account
      ON development_live_voice_sessions(account_id) WHERE NOT ended;
  `,
    )
    .then(() => {})
    .catch((error) => {
      schema = undefined;
      throw error;
    });
  await schema;
}

async function credential(
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
  throw new Error(
    "Live voice preview needs an account or project OpenAI API key. Site-funded live voice is not enabled yet.",
  );
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
    model: "gpt-live-1",
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

async function hangup(row: Lease) {
  if (row.provider_id) {
    const key = await credential(
      row.account_id,
      row.project_id,
      row.funding_source,
    );
    const response = await fetch(
      API + "/" + encodeURIComponent(row.provider_id) + "/hangup",
      {
        method: "POST",
        headers: { Authorization: "Bearer " + key.apiKey },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok && response.status !== 404 && response.status !== 410)
      throw new Error(
        "Live voice close failed (" +
          response.status +
          "). Cleanup will retry.",
      );
  }
  await getPool().query(
    "UPDATE development_live_voice_sessions SET ended=TRUE WHERE request_id=$1",
    [row.request_id],
  );
}

async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    await ensureSchema();
    const { rows } = await getPool().query<Lease>(`
      SELECT * FROM development_live_voice_sessions
      WHERE NOT ended AND (expires_at < NOW() OR heartbeat_at < NOW() - INTERVAL '25 seconds')
      LIMIT 20
    `);
    for (const row of rows) {
      // In-flight creation is bounded to 15 seconds. Give a lost response one
      // minute to settle; never automatically repeat a provider creation.
      if (
        !row.provider_id &&
        Date.now() - new Date(row.heartbeat_at).getTime() < 60_000
      )
        continue;
      try {
        await hangup(row);
      } catch (error) {
        log.warn("live voice cleanup pending", {
          request_id: row.request_id,
          error: String(error),
        });
      }
    }
  } catch (error) {
    log.warn("live voice cleanup failed", { error: String(error) });
  } finally {
    sweeping = false;
  }
}

// Each account-home bay sweeps its own durable leases, including after restart.
// This preview switch must remain set until every development session is closed.
if (process.env.COCALC_LIVE_VOICE_DEV === "1") {
  const timer = setInterval(() => void sweep(), 5000);
  timer.unref();
}

export async function liveVoice(
  opts: LiveVoiceRequest,
): Promise<LiveVoiceResult> {
  const { account_id, project_id, action } = opts;
  if (!account_id || !isValidUUID(account_id) || !isValidUUID(project_id))
    throw new Error("Invalid live voice account or project.");
  if (
    process.env.COCALC_LIVE_VOICE_DEV !== "1" ||
    !(await isAdmin(account_id))
  ) {
    if (action === "capabilities")
      return {
        ...base,
        enabled: false,
        reason: "Live voice preview is not enabled for this account.",
      };
    throw new Error("Live voice preview is not enabled for this account.");
  }
  if (!["capabilities", "start", "heartbeat", "end"].includes(action))
    throw new Error("Invalid live voice action.");
  // End remains possible after project access is removed.
  if (action !== "end")
    await assertProjectCollaboratorAccessAllowRemote({
      account_id,
      project_id,
    });
  if (action === "capabilities") {
    try {
      const key = await credential(account_id, project_id);
      return { ...base, enabled: true, funding_source: key.source };
    } catch {
      return {
        ...base,
        enabled: false,
        reason:
          "Connect an account or project OpenAI API key to try live voice. Site-funded live voice is not enabled yet.",
      };
    }
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
    const key = await credential(account_id, project_id);
    await sweep();
    const expires_at = Date.now() + MAX_SECONDS * 1000;
    try {
      await getPool().query(
        `
        INSERT INTO development_live_voice_sessions(request_id,account_id,project_id,expires_at,funding_source)
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
    let provider_id: string | undefined;
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
      if (!response.ok)
        throw new Error(
          "OpenAI live voice creation failed (" +
            response.status +
            "). Check this key's GPT-Live access.",
        );
      const result = (await response.json()) as {
        session?: { id?: string };
        transport?: { sdp?: string };
      };
      provider_id = result.session?.id;
      if (
        typeof provider_id !== "string" ||
        !provider_id ||
        typeof result.transport?.sdp !== "string"
      )
        throw new Error("Invalid live voice session response.");
      await getPool().query(
        "UPDATE development_live_voice_sessions SET provider_id=$2, heartbeat_at=NOW() WHERE request_id=$1",
        [opts.request_id, provider_id],
      );
      return {
        ...base,
        enabled: true,
        session_id: opts.request_id,
        sdp: result.transport!.sdp!,
        expires_at,
        funding_source: key.source,
      };
    } catch (error) {
      if (provider_id) {
        await hangup({
          request_id: opts.request_id,
          account_id,
          project_id,
          provider_id,
          funding_source: key.source,
          expires_at: new Date(expires_at),
          heartbeat_at: new Date(),
          ended: false,
        }).catch(() => {});
      }
      // Unknown provider outcomes must not cause automatic retries.
      throw error;
    }
  }
  if (!opts.session_id || !isValidUUID(opts.session_id))
    throw new Error("Invalid live voice session.");
  const { rows } = await getPool().query<Lease>(
    "SELECT * FROM development_live_voice_sessions WHERE request_id=$1 AND account_id=$2 AND project_id=$3",
    [opts.session_id, account_id, project_id],
  );
  const row = rows[0];
  if (!row) throw new Error("Live voice session not found.");
  if (action === "end") {
    if (!row.ended) await hangup(row);
    return { ...base, enabled: false };
  }
  if (
    row.ended ||
    new Date(row.expires_at).getTime() <= Date.now() ||
    Date.now() - new Date(row.heartbeat_at).getTime() > LEASE_SECONDS * 1000
  )
    throw new Error("Live call ended or expired. Start a new call explicitly.");
  await getPool().query(
    "UPDATE development_live_voice_sessions SET heartbeat_at=NOW() WHERE request_id=$1 AND NOT ended",
    [opts.session_id],
  );
  return {
    ...base,
    enabled: true,
    expires_at: new Date(row.expires_at).getTime(),
    funding_source: row.funding_source,
  };
}
