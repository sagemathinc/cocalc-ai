/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Purge requests to OAuth clients: when an account is deleted, ask each client
it signed in to (and whose purge the user did not opt out of) to delete its
data. See docs/sagebrush.md.

Account deletion is immediate and final, so the request goes into a durable
outbox, oauth_client_purge_requests, in the same transaction that marks the
account deleted on its home bay. That bay's worker delivers it, retrying with
the same request_id until the client answers 202.
*/

import { createHmac } from "node:crypto";

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import adminAlert from "@cocalc/server/messages/admin-alert";
import { getOAuthClient, type OAuthClient } from "./clients";

const logger = getLogger("server:auth:oauth:purge");

const BATCH_SIZE = 20;
const REQUEST_TIMEOUT_MS = 15_000;
// A claimed row is not picked up again by another worker for this long.
const CLAIM_LEASE_MS = 5 * 60_000;
const MIN_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 6 * 60 * 60_000;
// Admins are alerted when a request is still not accepted after this long.
export const OVERDUE_MS = 24 * 60 * 60_000;

type Queryable = {
  query: <T = any>(
    sql: string,
    params?: any[],
  ) => Promise<{ rows: T[]; rowCount?: number | null }>;
};

/** `sha256=<hex>` over timestamp, method, path and body, joined by newlines.
 * The same scheme signs every admin call between CoCalc and the client. */
export function signAdminRequest({
  secret,
  timestamp,
  method,
  path,
  body,
}: {
  secret: string;
  timestamp: number | string;
  method: string;
  path: string;
  body: string;
}): string {
  const message = `${timestamp}\n${method.toUpperCase()}\n${path}\n${body}`;
  return `sha256=${createHmac("sha256", secret).update(message, "utf8").digest("hex")}`;
}

/** Queue purge requests for a deleted account. Call it with the transaction
 * that marks the account deleted. Every enabled client gets one, whether or
 * not this bay knows the account approved it (an approval recorded before a
 * rehome stays on the old home bay), except those in `keep_client_ids`, whose
 * data the user chose to keep. The client answers 202 for an account it has
 * no data for. Clients that already have a request for this account are
 * skipped. */
export async function queueOAuthClientPurges({
  db,
  account_id,
  client_ids,
  keep_client_ids = [],
}: {
  db: Queryable;
  account_id: string;
  client_ids: string[];
  keep_client_ids?: string[];
}): Promise<string[]> {
  const ids = client_ids.filter((id) => !keep_client_ids.includes(id));
  if (ids.length === 0) return [];
  const { rows } = await db.query<{ client_id: string }>(
    `INSERT INTO oauth_client_purge_requests(
       request_id, client_id, account_id, created, attempts, next_attempt_at)
     SELECT gen_random_uuid(), c.client_id, $1::UUID, NOW(), 0, NOW()
       FROM unnest($2::TEXT[]) AS c(client_id)
      WHERE NOT EXISTS (
          SELECT 1 FROM oauth_client_purge_requests p
           WHERE p.account_id = $1::UUID AND p.client_id = c.client_id)
     RETURNING client_id`,
    [account_id, ids],
  );
  return rows.map((row) => row.client_id);
}

export function purgeBackoffMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 20));
  return Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** exponent);
}

type PurgeRow = {
  request_id: string;
  client_id: string;
  account_id: string;
  created: Date;
  attempts: number;
  alerted_at?: Date | null;
};

type Fetch = typeof globalThis.fetch;

// Response bodies are read only this far: an acknowledgment is small, and a
// broken endpoint must not make the worker buffer an unbounded body.
const MAX_RESPONSE_BYTES = 4096;

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader == null) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < MAX_RESPONSE_BYTES) {
      const { done, value } = await reader.read();
      if (done || value == null) break;
      chunks.push(value);
      size += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, MAX_RESPONSE_BYTES).toString("utf8");
}

/** Whether a 202 body is the client's acknowledgment of this request. Any
 * other 202 (a wrong route, a proxy page) is retried, not counted. */
function isAcknowledgment(body: string, request_id: string): boolean {
  try {
    const ack = JSON.parse(body);
    return ack?.request_id === request_id && ack?.status === "accepted";
  } catch {
    return false;
  }
}

/** Send one purge request. Resolves to { accepted: true } only when the
 * client acknowledged this request, and otherwise to the reason it failed. */
export async function sendPurgeRequest({
  client,
  row,
  fetch = globalThis.fetch,
  now = Date.now,
}: {
  client: OAuthClient;
  row: Pick<PurgeRow, "request_id" | "account_id">;
  fetch?: Fetch;
  now?: () => number;
}): Promise<{ accepted?: true; status?: number; error?: string }> {
  if (client.purge == null) {
    return { error: "purge is not configured for this client" };
  }
  const body = JSON.stringify({
    account_id: row.account_id,
    request_id: row.request_id,
  });
  const timestamp = Math.floor(now() / 1000);
  let response: Response;
  try {
    const url = new URL(client.purge.url);
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sagebrush-Timestamp": `${timestamp}`,
        "X-Sagebrush-Signature": signAdminRequest({
          secret: client.purge.secret,
          timestamp,
          method: "POST",
          path: url.pathname,
          body,
        }),
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return { error: `request failed: ${err}` };
  }
  let text = "";
  try {
    text = await readCapped(response);
  } catch (err) {
    return {
      status: response.status,
      error: `reading the response failed: ${err}`,
    };
  }
  if (response.status === 202 && isAcknowledgment(text, row.request_id)) {
    return { accepted: true, status: 202 };
  }
  const detail = text.slice(0, 200);
  return {
    status: response.status,
    error:
      response.status === 202
        ? `HTTP 202 without an acknowledgment of this request${detail ? `: ${detail}` : ""}`
        : `HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
  };
}

async function claimDueRequests(db: Queryable): Promise<PurgeRow[]> {
  const { rows } = await db.query<PurgeRow>(
    `UPDATE oauth_client_purge_requests
        SET next_attempt_at = NOW() + ($1::INTEGER * INTERVAL '1 millisecond')
      WHERE request_id IN (
        SELECT request_id FROM oauth_client_purge_requests
         WHERE accepted_at IS NULL AND next_attempt_at <= NOW()
         ORDER BY next_attempt_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED)
      RETURNING request_id, client_id, account_id, created, attempts, alerted_at`,
    [CLAIM_LEASE_MS, BATCH_SIZE],
  );
  return rows;
}

/** Deliver the due purge requests on this bay once. */
export async function deliverDuePurgeRequests({
  db = getPool(),
  fetch = globalThis.fetch,
  now = Date.now,
  alert = adminAlert,
}: {
  db?: Queryable;
  fetch?: Fetch;
  now?: () => number;
  alert?: typeof adminAlert;
} = {}): Promise<{ accepted: number; failed: number }> {
  const rows = await claimDueRequests(db);
  let accepted = 0;
  let failed = 0;
  for (const row of rows) {
    let result: { accepted?: true; status?: number; error?: string };
    try {
      const client = await getOAuthClient(row.client_id);
      result =
        client == null
          ? { error: "the client is not enabled" }
          : await sendPurgeRequest({ client, row, fetch, now });
    } catch (err) {
      // One row's failure (e.g. reading the settings) must not stop the
      // others; it is recorded and retried like any failed attempt.
      result = { error: `${err}` };
    }
    const attempts = row.attempts + 1;
    if (result.accepted) {
      accepted += 1;
      await db.query(
        `UPDATE oauth_client_purge_requests
            SET accepted_at = NOW(), next_attempt_at = NULL, attempts = $2,
                last_attempt_at = NOW(), last_error = NULL
          WHERE request_id = $1::UUID`,
        [row.request_id, attempts],
      );
      logger.info("purge request accepted", {
        request_id: row.request_id,
        client_id: row.client_id,
      });
      continue;
    }
    failed += 1;
    const error = `${result.error ?? "unknown error"}`.slice(0, 500);
    await db.query(
      `UPDATE oauth_client_purge_requests
          SET attempts = $2, last_attempt_at = NOW(), last_error = $3,
              next_attempt_at = NOW() + ($4::INTEGER * INTERVAL '1 millisecond')
        WHERE request_id = $1::UUID`,
      [row.request_id, attempts, error, purgeBackoffMs(attempts)],
    );
    logger.warn("purge request failed", {
      request_id: row.request_id,
      client_id: row.client_id,
      attempts,
      error,
    });
    const overdue = now() - new Date(row.created).valueOf() >= OVERDUE_MS;
    if (result.status === 401 || (overdue && row.alerted_at == null)) {
      await alert({
        subject: `Purge request to ${row.client_id} not accepted`,
        body: [
          `CoCalc has not been able to ask ${row.client_id} to delete the data of deleted account ${row.account_id}.`,
          `Request id: ${row.request_id}. Attempts: ${attempts}. Last error: ${error}.`,
          result.status === 401
            ? "The client rejected the signature: check that both sides have the same purge key."
            : "CoCalc keeps retrying with backoff.",
        ].join("\n\n"),
        dedupBySubject: true,
      });
      if (overdue) {
        await db.query(
          `UPDATE oauth_client_purge_requests SET alerted_at = NOW()
            WHERE request_id = $1::UUID`,
          [row.request_id],
        );
      }
    }
  }
  return { accepted, failed };
}

let stop: (() => void) | undefined;

export function startOAuthClientPurgeMaintenance({
  intervalMs = 60_000,
}: { intervalMs?: number } = {}): () => void {
  if (stop) return stop;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    try {
      const { accepted, failed } = await deliverDuePurgeRequests();
      if (accepted || failed) {
        logger.debug("delivered purge requests", { accepted, failed });
      }
    } catch (err) {
      logger.warn("purge request delivery failed", { err: `${err}` });
    } finally {
      if (!stopped) {
        timer = setTimeout(() => void run(), intervalMs);
        timer.unref();
      }
    }
  };
  stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    stop = undefined;
  };
  void run();
  return stop;
}
