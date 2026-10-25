/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Sagebrush sync notices and retention emails. See docs/sagebrush.md, section 4.

When an account's membership stops including Sagebrush sync, Sagebrush keeps
its synced data read-only and deletes it `retention_days` later (never less
than 14 days after Sagebrush learns of it). Sagebrush sends no email: the Terms
promise that CoCalc emails the user when the membership ends and again before
deletion. So, on the account's home bay:

1. Each account that approved a Sagebrush sign-in is checked, a batch per
   pass: is sync in its membership now? The last answer is kept in
   sagebrush_sync_states. A change queues a signed plan notice to Sagebrush
   (POST /api/admin/limits), retried with the same request id until accepted.
2. After the notice that ends sync is accepted, CoCalc reads the deletion date
   back (GET /api/admin/sync-retention/<account_id>) and sends the first email.
3. About 14 days before that date it reads it again and sends the second,
   unless sync was renewed, the data is gone, or the account never synced.

Both calls are signed like the purge requests, with the site setting
sagebrush_limits_secret (Sagebrush's LIMITS_KEY), and go to the origin of the
Sagebrush purge URL. A blank key turns all of this off.
*/

import { randomUUID } from "node:crypto";

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import {
  getOAuthAccountStateLocal,
  type OAuthAccountState,
} from "@cocalc/server/auth/oauth/account-state";
import {
  isAllowedClientUrl,
  OAUTH_CLIENTS,
} from "@cocalc/server/auth/oauth/clients";
import {
  purgeBackoffMs,
  readCapped,
  signAdminRequest,
} from "@cocalc/server/auth/oauth/purge";
import sendEmail from "@cocalc/server/email/send-email";
import adminAlert from "@cocalc/server/messages/admin-alert";
import { getSagebrushLimits, type SagebrushLimits } from "./limits";

const logger = getLogger("server:sagebrush:sync-retention");

const CLIENT_ID = "sagebrush";
const REQUEST_TIMEOUT_MS = 15_000;
// How often an account's membership is checked again.
export const RECHECK_MS = 10 * 60_000;
const CHECK_BATCH = 50;
const STEP_BATCH = 20;
// A claimed row is not picked up again by another pass for this long.
const LEASE_MS = 5 * 60_000;
// The second email goes this long before deletion.
export const BEFORE_DELETION_MS = 14 * 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

type Queryable = {
  query: <T = any>(
    sql: string,
    params?: any[],
  ) => Promise<{ rows: T[]; rowCount?: number | null }>;
};
type Fetch = typeof globalThis.fetch;

export interface SyncNoticeConfig {
  // Sagebrush's origin, from the purge URL: https://sagebrush.space
  origin: string;
  // Sagebrush's LIMITS_KEY.
  secret: string;
}

/** Where and how to send sync notices, or undefined while the limits key (or
 * a valid purge URL) is not set: then nothing here runs. */
export async function getSyncNoticeConfig(): Promise<
  SyncNoticeConfig | undefined
> {
  const settings = (await getServerSettings()) as Record<string, unknown>;
  const secret = `${settings.sagebrush_limits_secret ?? ""}`.trim();
  if (!secret) return;
  const definition = OAUTH_CLIENTS[CLIENT_ID];
  const configured = settings[definition.settings.purge_url];
  const url =
    configured == null ? definition.defaultPurgeUrl : `${configured}`.trim();
  if (!url || !isAllowedClientUrl(url)) return;
  return { origin: new URL(url).origin, secret };
}

async function signedRequest({
  config,
  method,
  path,
  body,
  fetch,
  now,
}: {
  config: SyncNoticeConfig;
  method: "GET" | "POST";
  path: string;
  body: string;
  fetch: Fetch;
  now: () => number;
}): Promise<{ status?: number; text?: string; error?: string }> {
  const url = new URL(path, config.origin);
  const timestamp = Math.floor(now() / 1000);
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        "X-Sagebrush-Timestamp": `${timestamp}`,
        "X-Sagebrush-Signature": signAdminRequest({
          secret: config.secret,
          timestamp,
          method,
          path: url.pathname,
          body,
        }),
      },
      ...(method === "POST" ? { body } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return { error: `request failed: ${err}` };
  }
  try {
    return { status: response.status, text: await readCapped(response) };
  } catch (err) {
    return {
      status: response.status,
      error: `reading the response failed: ${err}`,
    };
  }
}

/** Send one plan notice. Accepted only on a 200 whose JSON body says whether
 * it was applied (Sagebrush applies a notice only if it is newer than what it
 * holds, and ignores it for an account that never synced). */
export async function sendSyncNotice({
  config,
  notice,
  fetch = globalThis.fetch,
  now = Date.now,
}: {
  config: SyncNoticeConfig;
  notice: {
    request_id: string;
    account_id: string;
    issued: number;
    limits: SagebrushLimits;
  };
  fetch?: Fetch;
  now?: () => number;
}): Promise<{ accepted?: true; status?: number; error?: string }> {
  const body = JSON.stringify(notice);
  const r = await signedRequest({
    config,
    method: "POST",
    path: "/api/admin/limits",
    body,
    fetch,
    now,
  });
  if (r.error) return { status: r.status, error: r.error };
  if (r.status === 200) {
    try {
      if (typeof JSON.parse(r.text ?? "")?.applied === "boolean") {
        return { accepted: true, status: 200 };
      }
    } catch {}
  }
  const detail = `${r.text ?? ""}`.slice(0, 200);
  return {
    status: r.status,
    error: `HTTP ${r.status}${detail ? `: ${detail}` : ""}`,
  };
}

export type SyncRetention =
  | { synced: false }
  | {
      synced: true;
      state: string;
      readonly_since: number | null;
      purge_after: number | null;
    };

/** Read when an account's synced data will be deleted. { synced: false }
 * means Sagebrush holds no synced data of the account now (it never synced,
 * or its data was deleted). Throws on anything else. */
export async function readSyncRetention({
  config,
  account_id,
  fetch = globalThis.fetch,
  now = Date.now,
}: {
  config: SyncNoticeConfig;
  account_id: string;
  fetch?: Fetch;
  now?: () => number;
}): Promise<SyncRetention> {
  const r = await signedRequest({
    config,
    method: "GET",
    path: `/api/admin/sync-retention/${account_id}`,
    body: "",
    fetch,
    now,
  });
  if (r.error) throw Error(r.error);
  if (r.status === 404) return { synced: false };
  if (r.status !== 200) {
    throw Error(`HTTP ${r.status}: ${`${r.text ?? ""}`.slice(0, 200)}`);
  }
  const v = JSON.parse(r.text ?? "");
  const ms = (x: unknown) =>
    x == null ? null : Number.isSafeInteger(x) ? (x as number) : NaN;
  const readonly_since = ms(v?.readonly_since);
  const purge_after = ms(v?.purge_after);
  if (
    v?.account_id !== account_id ||
    typeof v?.state !== "string" ||
    Number.isNaN(readonly_since) ||
    Number.isNaN(purge_after)
  ) {
    throw Error(`malformed answer: ${`${r.text ?? ""}`.slice(0, 200)}`);
  }
  return { synced: true, state: v.state, readonly_since, purge_after };
}

/** Whether a retention answer still calls for an email: the data is
 * read-only after sync ended, with a deletion date ahead. */
export function deletionPending(
  r: SyncRetention,
  now: number,
): r is Extract<SyncRetention, { synced: true }> & { purge_after: number } {
  return (
    r.synced &&
    r.state === "readonly" &&
    r.readonly_since != null &&
    r.purge_after != null &&
    r.purge_after > now
  );
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** The two emails. `stage` is "ended" (sync just ended) or "before" (about
 * 14 days before deletion). */
export function retentionEmail({
  stage,
  purge_after,
  site_name,
  sagebrush,
}: {
  stage: "ended" | "before";
  purge_after: number;
  site_name: string;
  sagebrush: string;
}): { subject: string; text: string; html: string } {
  const date = `${formatDate(purge_after)} (UTC)`;
  const subject =
    stage === "ended"
      ? "Sagebrush sync has ended: your synced data is read-only"
      : `Your Sagebrush synced data will be deleted on ${formatDate(purge_after)}`;
  const lines =
    stage === "ended"
      ? [
          `Your ${site_name} membership no longer includes Sagebrush sync.`,
          `Your synced Sagebrush data is now read-only. You can still view and download it at ${sagebrush}.`,
          `It will be deleted on ${date} unless your membership includes sync again before then.`,
          `To keep it, renew a membership that includes sync, or download what you need. We will email you again about two weeks before it is deleted.`,
        ]
      : [
          `Your synced Sagebrush data is read-only because your ${site_name} membership no longer includes sync.`,
          `It will be deleted on ${date}.`,
          `To keep it, renew a membership that includes sync before then, or download what you need at ${sagebrush}.`,
        ];
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return {
    subject,
    text: lines.join("\n\n"),
    html: lines.map((line) => `<p>${escape(line)}</p>`).join("\n"),
  };
}

/** Check a batch of accounts that approved a Sagebrush sign-in on this bay,
 * those not checked for RECHECK_MS, and record their sync state. A change
 * from what was last seen queues a plan notice; the first check of an account
 * only records it. Returns the number of changes. */
export async function checkSyncStates({
  db = getPool(),
  getLimits = getSagebrushLimits,
  accountState = getOAuthAccountStateLocal,
  now = Date.now,
  batch = CHECK_BATCH,
}: {
  db?: Queryable;
  getLimits?: (account_id: string) => Promise<SagebrushLimits | undefined>;
  accountState?: (opts: { account_id: string }) => Promise<OAuthAccountState>;
  now?: () => number;
  batch?: number;
} = {}): Promise<number> {
  const { rows } = await db.query<{ account_id: string }>(
    `SELECT a.account_id
       FROM oauth_client_approvals a
       LEFT JOIN sagebrush_sync_states s ON s.account_id = a.account_id
      WHERE a.client_id = $1
        AND (s.checked_at IS NULL
             OR s.checked_at < to_timestamp($2::BIGINT / 1000.0))
      ORDER BY s.checked_at NULLS FIRST
      LIMIT $3`,
    [CLIENT_ID, now() - RECHECK_MS, batch],
  );
  let changes = 0;
  for (const { account_id } of rows) {
    try {
      changes += (await checkOne({
        db,
        account_id,
        getLimits,
        accountState,
        now,
      }))
        ? 1
        : 0;
    } catch (err) {
      logger.warn("checking an account's sync state failed", {
        account_id,
        err: `${err}`,
      });
    }
  }
  return changes;
}

async function checkOne({
  db,
  account_id,
  getLimits,
  accountState,
  now,
}: {
  db: Queryable;
  account_id: string;
  getLimits: (account_id: string) => Promise<SagebrushLimits | undefined>;
  accountState: (opts: { account_id: string }) => Promise<OAuthAccountState>;
  now: () => number;
}): Promise<boolean> {
  const t = now();
  // Only the account's home bay acts for it. A deleted or banned account is
  // purged from Sagebrush by the purge outbox, not here.
  const state = await accountState({ account_id });
  const limits =
    state.state === "live" ? await getLimits(account_id) : undefined;
  if (limits == null) {
    await db.query(
      `INSERT INTO sagebrush_sync_states(account_id, checked_at)
       VALUES($1::UUID, to_timestamp($2::BIGINT / 1000.0))
       ON CONFLICT (account_id) DO UPDATE SET checked_at = EXCLUDED.checked_at`,
      [account_id, t],
    );
    return false;
  }
  const enabled = limits.sync.enabled === true;
  // The first answer for an account only records it.
  await db.query(
    `INSERT INTO sagebrush_sync_states(account_id, sync_enabled, checked_at)
     VALUES($1::UUID, $2, to_timestamp($3::BIGINT / 1000.0))
     ON CONFLICT (account_id) DO UPDATE
       SET checked_at = EXCLUDED.checked_at,
           sync_enabled = COALESCE(sagebrush_sync_states.sync_enabled, EXCLUDED.sync_enabled)`,
    [account_id, enabled, t],
  );
  // A change: a new notice (replacing any still pending), and the emails of
  // a sync that ended are started once its notice is accepted, or cancelled
  // when sync is back.
  const { rows } = await db.query(
    `UPDATE sagebrush_sync_states
        SET sync_enabled = $2,
            changed_at = to_timestamp($3::BIGINT / 1000.0),
            notice_request_id = $4::UUID,
            notice_issued = $3::BIGINT,
            notice_limits = $5::JSONB,
            notice_attempts = 0,
            notice_next_at = to_timestamp($3::BIGINT / 1000.0),
            notice_accepted_at = NULL,
            last_error = NULL,
            alerted_at = NULL,
            email_stage = CASE
              WHEN email_stage IN ('ended', 'before') THEN 'cancelled'
              ELSE email_stage END,
            email_next_at = NULL,
            email_attempts = 0
      WHERE account_id = $1::UUID AND sync_enabled IS DISTINCT FROM $2
      RETURNING account_id`,
    [account_id, enabled, t, randomUUID(), JSON.stringify(limits)],
  );
  if (rows.length > 0) {
    logger.info("sync membership changed", { account_id, enabled });
    return true;
  }
  return false;
}

type NoticeRow = {
  account_id: string;
  sync_enabled: boolean;
  changed_at: Date;
  notice_request_id: string;
  notice_issued: string | number;
  notice_limits: SagebrushLimits;
  notice_attempts: number;
  alerted_at: Date | null;
};

async function overdueAlert({
  alert,
  row,
  what,
  error,
  status,
  now,
  db,
}: {
  alert: typeof adminAlert;
  row: { account_id: string; changed_at: Date; alerted_at: Date | null };
  what: string;
  error: string;
  status?: number;
  now: number;
  db: Queryable;
}) {
  const overdue = now - new Date(row.changed_at).valueOf() >= DAY_MS;
  if (status !== 401 && !(overdue && row.alerted_at == null)) return;
  await alert({
    subject: `Sagebrush sync ${what} not done`,
    body: [
      `CoCalc has not been able to complete the Sagebrush sync ${what} for account ${row.account_id}. Last error: ${error}.`,
      status === 401
        ? "Sagebrush rejected the signature: check that the Sagebrush Limits Key matches the Worker's LIMITS_KEY."
        : "CoCalc keeps retrying with backoff. The user's retention emails wait until this succeeds.",
    ].join("\n\n"),
    dedupBySubject: true,
  });
  if (overdue) {
    await db.query(
      `UPDATE sagebrush_sync_states SET alerted_at = NOW() WHERE account_id = $1::UUID`,
      [row.account_id],
    );
  }
}

/** Deliver the due plan notices on this bay once. */
export async function deliverDueSyncNotices({
  db = getPool(),
  config,
  fetch = globalThis.fetch,
  now = Date.now,
  alert = adminAlert,
}: {
  db?: Queryable;
  config: SyncNoticeConfig;
  fetch?: Fetch;
  now?: () => number;
  alert?: typeof adminAlert;
}): Promise<{ accepted: number; failed: number }> {
  const { rows } = await db.query<NoticeRow>(
    `UPDATE sagebrush_sync_states
        SET notice_next_at = to_timestamp($1::BIGINT / 1000.0)
      WHERE account_id IN (
        SELECT account_id FROM sagebrush_sync_states
         WHERE notice_next_at <= to_timestamp($2::BIGINT / 1000.0)
         ORDER BY notice_next_at
         LIMIT $3
         FOR UPDATE SKIP LOCKED)
      RETURNING account_id, sync_enabled, changed_at, notice_request_id,
                notice_issued, notice_limits, notice_attempts, alerted_at`,
    [now() + LEASE_MS, now(), STEP_BATCH],
  );
  let accepted = 0;
  let failed = 0;
  for (const row of rows) {
    const result = await sendSyncNotice({
      config,
      notice: {
        request_id: row.notice_request_id,
        account_id: row.account_id,
        issued: Number(row.notice_issued),
        limits: row.notice_limits,
      },
      fetch,
      now,
    }).catch((err) => ({
      error: `${err}`,
      status: undefined,
      accepted: undefined,
    }));
    const attempts = row.notice_attempts + 1;
    if (result.accepted) {
      accepted += 1;
      // (only for this notice: a newer change replaced the request id)
      await db.query(
        `UPDATE sagebrush_sync_states
            SET notice_accepted_at = NOW(), notice_next_at = NULL,
                notice_attempts = $3, last_error = NULL,
                email_stage = CASE WHEN sync_enabled = FALSE THEN 'ended' ELSE email_stage END,
                email_next_at = CASE WHEN sync_enabled = FALSE THEN NOW() ELSE email_next_at END,
                email_attempts = 0
          WHERE account_id = $1::UUID AND notice_request_id = $2::UUID`,
        [row.account_id, row.notice_request_id, attempts],
      );
      continue;
    }
    failed += 1;
    const error = `${result.error ?? "unknown error"}`.slice(0, 500);
    await db.query(
      `UPDATE sagebrush_sync_states
          SET notice_attempts = $3, last_error = $4,
              notice_next_at = to_timestamp($5::BIGINT / 1000.0)
        WHERE account_id = $1::UUID AND notice_request_id = $2::UUID`,
      [
        row.account_id,
        row.notice_request_id,
        attempts,
        error,
        now() + purgeBackoffMs(attempts),
      ],
    );
    logger.warn("sync notice failed", {
      account_id: row.account_id,
      attempts,
      error,
    });
    await overdueAlert({
      alert,
      row,
      what: "notice",
      error,
      status: result.status,
      now: now(),
      db,
    });
  }
  return { accepted, failed };
}

type StepRow = {
  account_id: string;
  email_stage: "ended" | "before";
  email_attempts: number;
  changed_at: Date;
  alerted_at: Date | null;
};

/** Run the due retention steps on this bay once: read the deletion date, and
 * send the email that is due, or cancel the emails if no deletion is pending
 * any more. */
export async function runDueRetentionSteps({
  db = getPool(),
  config,
  fetch = globalThis.fetch,
  now = Date.now,
  alert = adminAlert,
  accountState = getOAuthAccountStateLocal,
  send = sendEmail,
}: {
  db?: Queryable;
  config: SyncNoticeConfig;
  fetch?: Fetch;
  now?: () => number;
  alert?: typeof adminAlert;
  accountState?: (opts: { account_id: string }) => Promise<OAuthAccountState>;
  send?: typeof sendEmail;
}): Promise<{ sent: number; cancelled: number; failed: number }> {
  const { rows } = await db.query<StepRow>(
    `UPDATE sagebrush_sync_states
        SET email_next_at = to_timestamp($1::BIGINT / 1000.0)
      WHERE account_id IN (
        SELECT account_id FROM sagebrush_sync_states
         WHERE email_stage IN ('ended', 'before')
           AND email_next_at <= to_timestamp($2::BIGINT / 1000.0)
         ORDER BY email_next_at
         LIMIT $3
         FOR UPDATE SKIP LOCKED)
      RETURNING account_id, email_stage, email_attempts, changed_at, alerted_at`,
    [now() + LEASE_MS, now(), STEP_BATCH],
  );
  const settings = (await getServerSettings()) as Record<string, unknown>;
  const site_name = `${settings.site_name ?? ""}`.trim() || "CoCalc";
  const sagebrush = OAUTH_CLIENTS[CLIENT_ID].homepage;
  let sent = 0;
  let cancelled = 0;
  let failed = 0;
  for (const row of rows) {
    // (every update below is for this stage only: a change of the membership
    // meanwhile cancelled or restarted it)
    const guard = `account_id = $1::UUID AND email_stage = $2`;
    try {
      const r = await readSyncRetention({
        config,
        account_id: row.account_id,
        fetch,
        now,
      });
      const account = await accountState({ account_id: row.account_id });
      if (!deletionPending(r, now()) || account.state !== "live") {
        // Renewed, never synced, already deleted, or the account is gone.
        cancelled += 1;
        await db.query(
          `UPDATE sagebrush_sync_states
              SET email_stage = 'cancelled', email_next_at = NULL, last_error = NULL
            WHERE ${guard}`,
          [row.account_id, row.email_stage],
        );
        continue;
      }
      const purge_after = r.purge_after;
      if (
        row.email_stage === "before" &&
        purge_after - now() > BEFORE_DELETION_MS + DAY_MS
      ) {
        // Not due yet (the date is later than when this was scheduled).
        await db.query(
          `UPDATE sagebrush_sync_states
              SET purge_after = to_timestamp($3::BIGINT / 1000.0),
                  email_next_at = to_timestamp($4::BIGINT / 1000.0)
            WHERE ${guard}`,
          [
            row.account_id,
            row.email_stage,
            purge_after,
            purge_after - BEFORE_DELETION_MS,
          ],
        );
        continue;
      }
      const email = retentionEmail({
        stage: row.email_stage,
        purge_after,
        site_name,
        sagebrush,
      });
      await send(
        {
          to: account.email_address,
          subject: email.subject,
          text: email.text,
          html: email.html,
          categories: ["sagebrush-sync-retention"],
        },
        row.account_id,
      );
      sent += 1;
      if (row.email_stage === "ended") {
        await db.query(
          `UPDATE sagebrush_sync_states
              SET ended_email_sent_at = NOW(), email_stage = 'before', email_attempts = 0,
                  purge_after = to_timestamp($3::BIGINT / 1000.0),
                  email_next_at = to_timestamp($4::BIGINT / 1000.0), last_error = NULL
            WHERE ${guard}`,
          [
            row.account_id,
            row.email_stage,
            purge_after,
            Math.max(now(), purge_after - BEFORE_DELETION_MS),
          ],
        );
      } else {
        await db.query(
          `UPDATE sagebrush_sync_states
              SET before_email_sent_at = NOW(), email_stage = 'done', email_next_at = NULL,
                  purge_after = to_timestamp($3::BIGINT / 1000.0), last_error = NULL
            WHERE ${guard}`,
          [row.account_id, row.email_stage, purge_after],
        );
      }
    } catch (err) {
      failed += 1;
      const attempts = row.email_attempts + 1;
      const error = `${err}`.slice(0, 500);
      await db.query(
        `UPDATE sagebrush_sync_states
            SET email_attempts = $3, last_error = $4,
                email_next_at = to_timestamp($5::BIGINT / 1000.0)
          WHERE ${guard}`,
        [
          row.account_id,
          row.email_stage,
          attempts,
          error,
          now() + purgeBackoffMs(attempts),
        ],
      );
      logger.warn("sync retention step failed", {
        account_id: row.account_id,
        stage: row.email_stage,
        error,
      });
      await overdueAlert({
        alert,
        row,
        what: `${row.email_stage === "ended" ? "first" : "second"} retention email`,
        error,
        status: /HTTP 401/.test(error) ? 401 : undefined,
        now: now(),
        db,
      });
    }
  }
  return { sent, cancelled, failed };
}

let stop: (() => void) | undefined;

/** On the primary bay worker: check memberships, deliver notices and run the
 * retention steps, every intervalMs, while the limits key is set. */
export function startSagebrushSyncRetentionMaintenance({
  intervalMs = 60_000,
}: { intervalMs?: number } = {}): () => void {
  if (stop) return stop;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    try {
      const config = await getSyncNoticeConfig();
      if (config != null) {
        await checkSyncStates();
        await deliverDueSyncNotices({ config });
        await runDueRetentionSteps({ config });
      }
    } catch (err) {
      logger.warn("sagebrush sync retention pass failed", { err: `${err}` });
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
