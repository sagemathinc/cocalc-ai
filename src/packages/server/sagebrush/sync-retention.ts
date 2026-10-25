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

Before each email CoCalc resolves the membership again itself (a renewal may
not have reached Sagebrush yet), then reads Sagebrush's answer. The emails of
one ending of sync form a cycle, named by the notice that ended it; every
update of a step names its cycle, stage and claiming pass, so work for an older
cycle, or by a superseded pass, changes nothing. Each email is sent at most
once (see "Delivery" below). Failures are recorded and alerted as codes and
HTTP statuses only.

Both calls are signed like the purge requests, with the site setting
sagebrush_limits_secret (Sagebrush's LIMITS_KEY), and go to the origin of the
Sagebrush purge URL. A blank key turns all of this off.
*/

import { createHash, randomUUID } from "node:crypto";

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

/** Why a notice, a read or a retention step failed. Only the code and an HTTP
 * status are kept, in logs, last_error and admin alerts: never a response body
 * or an exception's text, which can hold an email address or a credential. */
export type SyncFailureCode =
  // the request didn't complete (network, timeout, a redirect)
  | "request_failed"
  | "response_unreadable"
  // an HTTP status other than the expected ones
  | "http_error"
  | "malformed_response"
  | "account_state_unavailable"
  // the account's membership couldn't be resolved
  | "entitlement_unknown"
  // the mail transport refused the email
  | "send_failed"
  | "db_error"
  | "internal_error";

export class SyncFailure extends Error {
  constructor(
    readonly code: SyncFailureCode,
    readonly status?: number,
  ) {
    super(status == null ? code : `${code} ${status}`);
    this.name = "SyncFailure";
  }
}

// An error as a SyncFailure: its own code if it is one, else `code` (what was
// being done). Never the error's text.
function asFailure(err: unknown, code: SyncFailureCode): SyncFailure {
  return err instanceof SyncFailure ? err : new SyncFailure(code);
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
}): Promise<{ status: number; text: string } | { failure: SyncFailure }> {
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
  } catch {
    return { failure: new SyncFailure("request_failed") };
  }
  try {
    return { status: response.status, text: await readCapped(response) };
  } catch {
    return {
      failure: new SyncFailure("response_unreadable", response.status),
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
}): Promise<{ accepted?: true; status?: number; failure?: SyncFailure }> {
  const body = JSON.stringify(notice);
  const r = await signedRequest({
    config,
    method: "POST",
    path: "/api/admin/limits",
    body,
    fetch,
    now,
  });
  if ("failure" in r) return { status: r.failure.status, failure: r.failure };
  if (r.status !== 200) {
    return {
      status: r.status,
      failure: new SyncFailure("http_error", r.status),
    };
  }
  let applied: unknown;
  try {
    applied = JSON.parse(r.text)?.applied;
  } catch {}
  if (typeof applied === "boolean") return { accepted: true, status: 200 };
  return { status: 200, failure: new SyncFailure("malformed_response", 200) };
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
 * or its data was deleted). Throws a SyncFailure on anything else. */
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
  if ("failure" in r) throw r.failure;
  if (r.status === 404) return { synced: false };
  if (r.status !== 200) throw new SyncFailure("http_error", r.status);
  let v: any;
  try {
    v = JSON.parse(r.text);
  } catch {
    throw new SyncFailure("malformed_response", 200);
  }
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
    throw new SyncFailure("malformed_response", 200);
  }
  return { synced: true, state: v.state, readonly_since, purge_after };
}

/** The id of the delivery record of one email of one retention cycle: derived
 * from both, so there is exactly one per email (an RFC 9562 version 8 UUID). */
export function deliveryId(
  cycle_id: string,
  stage: "ended" | "before",
): string {
  const h = createHash("sha256")
    .update(`sagebrush-sync-retention\n${cycle_id}\n${stage}`)
    .digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
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
    let phase: SyncFailureCode = "account_state_unavailable";
    try {
      const t = now();
      // Only the account's home bay acts for it. A deleted or banned account
      // is purged from Sagebrush by the purge outbox, not here.
      const state = await accountState({ account_id });
      phase = "entitlement_unknown";
      const limits =
        state.state === "live" ? await getLimits(account_id) : undefined;
      phase = "db_error";
      if (limits == null) {
        await db.query(
          `INSERT INTO sagebrush_sync_states(account_id, checked_at)
           VALUES($1::UUID, to_timestamp($2::BIGINT / 1000.0))
           ON CONFLICT (account_id) DO UPDATE SET checked_at = EXCLUDED.checked_at`,
          [account_id, t],
        );
        continue;
      }
      if (await recordSyncState({ db, account_id, limits, t })) changes += 1;
    } catch (err) {
      logger.warn("checking an account's sync state failed", {
        code: asFailure(err, phase).code,
      });
    }
  }
  return changes;
}

// Record an account's sync state as CoCalc resolved it at time t. A change from
// what was last seen queues a new notice (replacing any still pending) and ends
// the current retention cycle; the emails of a sync that ended start once its
// notice is accepted. The first answer for an account only records it.
async function recordSyncState({
  db,
  account_id,
  limits,
  t,
}: {
  db: Queryable;
  account_id: string;
  limits: SagebrushLimits;
  t: number;
}): Promise<boolean> {
  const enabled = limits.sync.enabled === true;
  await db.query(
    `INSERT INTO sagebrush_sync_states(account_id, sync_enabled, checked_at)
     VALUES($1::UUID, $2, to_timestamp($3::BIGINT / 1000.0))
     ON CONFLICT (account_id) DO UPDATE
       SET checked_at = EXCLUDED.checked_at,
           sync_enabled = COALESCE(sagebrush_sync_states.sync_enabled, EXCLUDED.sync_enabled)`,
    [account_id, enabled, t],
  );
  const request_id = randomUUID();
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
            notice_alerted_at = NULL,
            last_error = NULL,
            email_stage = CASE
              WHEN email_stage IN ('ended', 'before') THEN 'cancelled'
              ELSE email_stage END,
            email_next_at = NULL,
            email_attempts = 0,
            email_claim = NULL,
            email_due_at = NULL,
            email_alerted_at = NULL
      WHERE account_id = $1::UUID AND sync_enabled IS DISTINCT FROM $2
      RETURNING account_id`,
    [account_id, enabled, t, request_id, JSON.stringify(limits)],
  );
  if (rows.length > 0) {
    logger.info("sync membership changed", { request_id, enabled });
    return true;
  }
  return false;
}

// Alert the admins about a failure: at once on a 401 (the keys probably
// disagree), and once per notice or retention step when it is a day overdue.
async function alertIfDue({
  alert,
  account_id,
  what,
  failure,
  since,
  alerted_at,
  markAlerted,
  now,
}: {
  alert: typeof adminAlert;
  account_id: string;
  what: string;
  failure: SyncFailure;
  since: Date | null;
  alerted_at: Date | null;
  markAlerted: () => Promise<unknown>;
  now: number;
}) {
  const overdue = since != null && now - new Date(since).valueOf() >= DAY_MS;
  if (failure.status !== 401 && !(overdue && alerted_at == null)) return;
  try {
    await alert({
      subject: `Sagebrush sync ${what} not done`,
      body: [
        `CoCalc has not been able to complete the Sagebrush sync ${what} for account ${account_id}. Last failure: ${failure.message}.`,
        failure.status === 401
          ? "Sagebrush rejected the signature: check that the Sagebrush Limits Key matches the Worker's LIMITS_KEY."
          : "CoCalc keeps retrying with backoff. The user's retention emails wait until this succeeds.",
      ].join("\n\n"),
      dedupBySubject: true,
    });
    if (overdue) await markAlerted();
  } catch (err) {
    logger.warn("alerting the admins failed", {
      code: asFailure(err, "internal_error").code,
    });
  }
}

type NoticeRow = {
  account_id: string;
  sync_enabled: boolean;
  changed_at: Date;
  notice_request_id: string;
  notice_issued: string | number;
  notice_limits: SagebrushLimits;
  notice_attempts: number;
  notice_alerted_at: Date | null;
};

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
                notice_issued, notice_limits, notice_attempts, notice_alerted_at`,
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
      accepted: undefined,
      status: undefined,
      failure: asFailure(err, "internal_error"),
    }));
    const attempts = row.notice_attempts + 1;
    try {
      if (result.accepted) {
        accepted += 1;
        // Only for this notice (a newer change replaced the request id). The
        // notice that ends sync starts a retention cycle, named by it.
        await db.query(
          `UPDATE sagebrush_sync_states
              SET notice_accepted_at = NOW(), notice_next_at = NULL,
                  notice_attempts = $3, notice_alerted_at = NULL, last_error = NULL,
                  email_stage = CASE WHEN sync_enabled = FALSE THEN 'ended' ELSE email_stage END,
                  email_cycle = CASE WHEN sync_enabled = FALSE THEN notice_request_id ELSE email_cycle END,
                  email_next_at = CASE WHEN sync_enabled = FALSE
                    THEN to_timestamp($4::BIGINT / 1000.0) ELSE email_next_at END,
                  email_due_at = CASE WHEN sync_enabled = FALSE
                    THEN to_timestamp($4::BIGINT / 1000.0) ELSE email_due_at END,
                  email_attempts = CASE WHEN sync_enabled = FALSE THEN 0 ELSE email_attempts END,
                  email_claim = CASE WHEN sync_enabled = FALSE THEN NULL ELSE email_claim END,
                  email_alerted_at = CASE WHEN sync_enabled = FALSE THEN NULL ELSE email_alerted_at END
            WHERE account_id = $1::UUID AND notice_request_id = $2::UUID
              AND notice_accepted_at IS NULL`,
          [row.account_id, row.notice_request_id, attempts, now()],
        );
        continue;
      }
      failed += 1;
      const failure = result.failure ?? new SyncFailure("internal_error");
      await db.query(
        `UPDATE sagebrush_sync_states
            SET notice_attempts = $3, last_error = $4,
                notice_next_at = to_timestamp($5::BIGINT / 1000.0)
          WHERE account_id = $1::UUID AND notice_request_id = $2::UUID`,
        [
          row.account_id,
          row.notice_request_id,
          attempts,
          failure.message,
          now() + purgeBackoffMs(attempts),
        ],
      );
      logger.warn("sync notice failed", {
        request_id: row.notice_request_id,
        attempts,
        code: failure.code,
        status: failure.status,
      });
      await alertIfDue({
        alert,
        account_id: row.account_id,
        what: "notice",
        failure,
        since: row.changed_at,
        alerted_at: row.notice_alerted_at,
        markAlerted: () =>
          db.query(
            `UPDATE sagebrush_sync_states SET notice_alerted_at = NOW()
              WHERE account_id = $1::UUID AND notice_request_id = $2::UUID`,
            [row.account_id, row.notice_request_id],
          ),
        now: now(),
      });
    } catch (err) {
      logger.warn("recording a sync notice result failed", {
        request_id: row.notice_request_id,
        code: asFailure(err, "db_error").code,
      });
    }
  }
  return { accepted, failed };
}

type Stage = "ended" | "before";

type StepRow = {
  account_id: string;
  email_cycle: string;
  email_claim: string;
  email_stage: Stage;
  email_attempts: number;
  email_due_at: Date | null;
  email_alerted_at: Date | null;
};

// Every update of a retention step names the step exactly: its account, its
// cycle, its stage and the pass that claimed it ($1..$4). An update by a pass
// that was superseded (the membership changed, a new cycle began, or another
// pass reclaimed the step after its lease) matches nothing.
const STEP = `account_id = $1::UUID AND email_cycle = $2::UUID AND email_stage = $3 AND email_claim = $4::UUID`;
const stepKey = (row: StepRow) => [
  row.account_id,
  row.email_cycle,
  row.email_stage,
  row.email_claim,
];

/* Delivery. The mail transport (SMTP or SendGrid, via sendEmail) has no
idempotency key and confirms nothing after it returns, so exactly-once delivery
isn't possible. Each email of each cycle gets one delivery record instead
(sagebrush_sync_emails, id deliveryId(cycle, stage)), and the email is sent at
most once:
- Before calling the transport, the pass admits the attempt: in one statement,
  with the step's row locked and checked to still be this cycle, stage and
  claim, the record goes from pending (or failed) to sending.
- When the transport returns, the record becomes sent and the step advances,
  in one statement.
- When the transport throws, the record becomes failed, and the step is
  retried with backoff.
- A record left in sending (the process died, or recording the outcome
  failed, after the transport was called) becomes unknown when the step is
  next claimed: the email may have been delivered, so it is not sent again.
  The step advances, and the admins are told. */
type Admission = "admitted" | "stale" | "sent" | "unknown";

async function admitDelivery(
  db: Queryable,
  row: StepRow,
  delivery_id: string,
): Promise<Admission> {
  const params = [...stepKey(row), delivery_id];
  await db.query(
    `INSERT INTO sagebrush_sync_emails(delivery_id, account_id, cycle_id, stage, state, attempts, created)
     SELECT $5::UUID, account_id, email_cycle, email_stage, 'pending', 0, NOW()
       FROM sagebrush_sync_states WHERE ${STEP}
     ON CONFLICT (delivery_id) DO NOTHING`,
    params,
  );
  const admitted = await db.query(
    `WITH current_step AS (
       SELECT account_id FROM sagebrush_sync_states WHERE ${STEP} FOR UPDATE)
     UPDATE sagebrush_sync_emails e
        SET state = 'sending', claim_id = $4::UUID, attempts = e.attempts + 1,
            admitted_at = NOW()
       FROM current_step
      WHERE e.delivery_id = $5::UUID AND e.state IN ('pending', 'failed')
     RETURNING e.delivery_id`,
    params,
  );
  if (admitted.rows.length > 0) return "admitted";
  const {
    rows: [found],
  } = await db.query<{ delivery: string | null; current: boolean }>(
    `SELECT (SELECT state FROM sagebrush_sync_emails WHERE delivery_id = $5::UUID) AS delivery,
            EXISTS (SELECT 1 FROM sagebrush_sync_states WHERE ${STEP}) AS current`,
    params,
  );
  if (!found?.current) return "stale";
  if (found.delivery === "sent") return "sent";
  if (found.delivery === "sending" || found.delivery === "unknown") {
    await db.query(
      `UPDATE sagebrush_sync_emails SET state = 'unknown'
        WHERE delivery_id = $1::UUID AND state = 'sending'`,
      [delivery_id],
    );
    return "unknown";
  }
  return "stale";
}

// Advance the step past its email: to 'before' at `next`, or to 'done'. With
// `delivered`, the delivery record is marked sent in the same statement.
async function advanceStep({
  db,
  row,
  delivery_id,
  purge_after,
  next,
  delivered,
}: {
  db: Queryable;
  row: StepRow;
  delivery_id: string;
  purge_after: number;
  next: number;
  delivered: boolean;
}): Promise<void> {
  const sentAt = delivered
    ? "(SELECT sent_at FROM delivered)"
    : "(SELECT sent_at FROM sagebrush_sync_emails WHERE delivery_id = $5::UUID)";
  const set =
    row.email_stage === "ended"
      ? `ended_email_sent_at = ${sentAt}, email_stage = 'before',
         email_next_at = to_timestamp($7::BIGINT / 1000.0),
         email_due_at = to_timestamp($7::BIGINT / 1000.0)`
      : `before_email_sent_at = ${sentAt}, email_stage = 'done',
         email_next_at = NULL, email_due_at = NULL`;
  await db.query(
    `${
      delivered
        ? `WITH delivered AS (
             UPDATE sagebrush_sync_emails SET state = 'sent', sent_at = NOW()
              WHERE delivery_id = $5::UUID AND claim_id = $4::UUID AND state = 'sending'
             RETURNING sent_at) `
        : ""
    }UPDATE sagebrush_sync_states
        SET ${set}, email_attempts = 0, email_claim = NULL, email_alerted_at = NULL,
            purge_after = to_timestamp($6::BIGINT / 1000.0), last_error = NULL
      WHERE ${STEP}`,
    row.email_stage === "ended"
      ? [...stepKey(row), delivery_id, purge_after, next]
      : [...stepKey(row), delivery_id, purge_after],
  );
}

/** Run the due retention steps on this bay once: check that sync is still
 * not in the account's membership, read the deletion date, and send the email
 * that is due, or end the cycle if no deletion is pending any more. */
export async function runDueRetentionSteps({
  db = getPool(),
  config,
  fetch = globalThis.fetch,
  now = Date.now,
  alert = adminAlert,
  accountState = getOAuthAccountStateLocal,
  getLimits = getSagebrushLimits,
  send = sendEmail,
}: {
  db?: Queryable;
  config: SyncNoticeConfig;
  fetch?: Fetch;
  now?: () => number;
  alert?: typeof adminAlert;
  accountState?: (opts: { account_id: string }) => Promise<OAuthAccountState>;
  getLimits?: (account_id: string) => Promise<SagebrushLimits | undefined>;
  send?: typeof sendEmail;
}): Promise<{
  sent: number;
  cancelled: number;
  failed: number;
  stale: number;
  unknown: number;
}> {
  const { rows } = await db.query<StepRow>(
    `UPDATE sagebrush_sync_states
        SET email_next_at = to_timestamp($1::BIGINT / 1000.0),
            email_claim = gen_random_uuid()
      WHERE account_id IN (
        SELECT account_id FROM sagebrush_sync_states
         WHERE email_stage IN ('ended', 'before')
           AND email_cycle IS NOT NULL
           AND email_next_at <= to_timestamp($2::BIGINT / 1000.0)
         ORDER BY email_next_at
         LIMIT $3
         FOR UPDATE SKIP LOCKED)
      RETURNING account_id, email_cycle, email_claim, email_stage,
                email_attempts, email_due_at, email_alerted_at`,
    [now() + LEASE_MS, now(), STEP_BATCH],
  );
  const counts = { sent: 0, cancelled: 0, failed: 0, stale: 0, unknown: 0 };
  if (rows.length === 0) return counts;
  const settings = (await getServerSettings()) as Record<string, unknown>;
  const site_name = `${settings.site_name ?? ""}`.trim() || "CoCalc";
  const sagebrush = OAUTH_CLIENTS[CLIENT_ID].homepage;
  for (const row of rows) {
    const { account_id } = row;
    const which = row.email_stage === "ended" ? "first" : "second";
    // End the cycle: counted as cancelled, or as stale if this pass was
    // superseded meanwhile.
    const endCycle = async () => {
      const { rows } = await db.query(
        `UPDATE sagebrush_sync_states
            SET email_stage = 'cancelled', email_next_at = NULL, email_claim = NULL,
                last_error = NULL
          WHERE ${STEP}
          RETURNING account_id`,
        stepKey(row),
      );
      counts[rows.length > 0 ? "cancelled" : "stale"] += 1;
    };
    let phase: SyncFailureCode = "account_state_unavailable";
    try {
      const account = await accountState({ account_id });
      if (account.state !== "live") {
        // Deleted, banned or moved: the purge outbox or the new home bay acts.
        phase = "db_error";
        await endCycle();
        continue;
      }
      // CoCalc's own answer first: a renewal Sagebrush hasn't heard of yet
      // must not get an email saying sync ended.
      phase = "entitlement_unknown";
      const limits = await getLimits(account_id);
      if (limits == null) throw new SyncFailure("entitlement_unknown");
      if (limits.sync.enabled === true) {
        phase = "db_error";
        // Renewed: record it, which queues the notice and ends the cycle.
        await recordSyncState({ db, account_id, limits, t: now() });
        await db.query(
          `UPDATE sagebrush_sync_states
              SET email_stage = 'cancelled', email_next_at = NULL, email_claim = NULL
            WHERE ${STEP}`,
          stepKey(row),
        );
        counts.cancelled += 1;
        continue;
      }
      phase = "request_failed";
      const r = await readSyncRetention({ config, account_id, fetch, now });
      phase = "db_error";
      if (!deletionPending(r, now())) {
        // Renewed on Sagebrush's side, never synced, or already deleted.
        await endCycle();
        continue;
      }
      const purge_after = r.purge_after;
      if (
        row.email_stage === "before" &&
        purge_after - now() > BEFORE_DELETION_MS + DAY_MS
      ) {
        // Not due yet (the date is later than when this was scheduled).
        const { rows: rescheduled } = await db.query(
          `UPDATE sagebrush_sync_states
              SET purge_after = to_timestamp($5::BIGINT / 1000.0),
                  email_next_at = to_timestamp($6::BIGINT / 1000.0),
                  email_due_at = to_timestamp($6::BIGINT / 1000.0),
                  email_claim = NULL
            WHERE ${STEP}
            RETURNING account_id`,
          [...stepKey(row), purge_after, purge_after - BEFORE_DELETION_MS],
        );
        if (rescheduled.length === 0) counts.stale += 1;
        continue;
      }
      const next = Math.max(now(), purge_after - BEFORE_DELETION_MS);
      const delivery_id = deliveryId(row.email_cycle, row.email_stage);
      const admission = await admitDelivery(db, row, delivery_id);
      if (admission === "stale") {
        counts.stale += 1;
        continue;
      }
      if (admission !== "admitted") {
        // Handed to the transport before: never again.
        await advanceStep({
          db,
          row,
          delivery_id,
          purge_after,
          next,
          delivered: false,
        });
        if (admission === "unknown") {
          counts.unknown += 1;
          logger.warn("a sync retention email's outcome is unknown", {
            delivery_id,
            stage: row.email_stage,
          });
          await alert({
            subject: "Sagebrush retention email outcome unknown",
            body: `An attempt to send the ${which} Sagebrush sync retention email to account ${account_id} ended without a recorded outcome (delivery ${delivery_id}). It may or may not have been delivered; CoCalc does not send it again.`,
            dedupBySubject: true,
          }).catch(() => {});
        }
        continue;
      }
      const email = retentionEmail({
        stage: row.email_stage,
        purge_after,
        site_name,
        sagebrush,
      });
      phase = "send_failed";
      try {
        await send(
          {
            to: account.email_address,
            subject: email.subject,
            text: email.text,
            html: email.html,
            categories: ["sagebrush-sync-retention"],
          },
          account_id,
        );
      } catch {
        // Refused: it may be tried again. (If even this fails, the record
        // stays in sending, and the email is never sent again.)
        await db
          .query(
            `UPDATE sagebrush_sync_emails SET state = 'failed'
              WHERE delivery_id = $1::UUID AND claim_id = $2::UUID AND state = 'sending'`,
            [delivery_id, row.email_claim],
          )
          .catch(() => {});
        throw new SyncFailure("send_failed");
      }
      counts.sent += 1;
      phase = "db_error";
      await advanceStep({
        db,
        row,
        delivery_id,
        purge_after,
        next,
        delivered: true,
      });
    } catch (err) {
      counts.failed += 1;
      const failure = asFailure(err, phase);
      const attempts = row.email_attempts + 1;
      logger.warn("sync retention step failed", {
        cycle: row.email_cycle,
        stage: row.email_stage,
        attempts,
        code: failure.code,
        status: failure.status,
      });
      try {
        const { rows: current } = await db.query(
          `UPDATE sagebrush_sync_states
              SET email_attempts = $5, last_error = $6,
                  email_next_at = to_timestamp($7::BIGINT / 1000.0)
            WHERE ${STEP}
            RETURNING account_id`,
          [
            ...stepKey(row),
            attempts,
            failure.message,
            now() + purgeBackoffMs(attempts),
          ],
        );
        if (current.length === 0) continue; // superseded meanwhile
        await alertIfDue({
          alert,
          account_id,
          what: `${which} retention email`,
          failure,
          since: row.email_due_at,
          alerted_at: row.email_alerted_at,
          markAlerted: () =>
            db.query(
              `UPDATE sagebrush_sync_states SET email_alerted_at = NOW() WHERE ${STEP}`,
              stepKey(row),
            ),
          now: now(),
        });
      } catch (err2) {
        logger.warn("recording a sync retention failure failed", {
          cycle: row.email_cycle,
          code: asFailure(err2, "db_error").code,
        });
      }
    }
  }
  return counts;
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
      logger.warn("sagebrush sync retention pass failed", {
        code: asFailure(err, "internal_error").code,
      });
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
