/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
What CoCalc admins must know about GPU keys (5d-2): a durable row first, one
open per (kind, dedupe key), written in the transaction of whatever decided
it (or right after one that had to roll back). Email to admins is only a
projection of the rows: retried until it goes out, and a failed email never
loses an alert. Never key material.
*/

import { randomUUID } from "node:crypto";
import getPool, { type PoolClient } from "@cocalc/database/pool";
import { getLogger } from "@cocalc/backend/logger";
import type {
  GPU_ADMIN_ALERT_KINDS,
  GPU_ALERT_SEVERITIES,
} from "@cocalc/util/db-schema/gpu-budgets";

const log = getLogger("server:gpu:admin-alerts");

export type GpuAdminAlertKind = (typeof GPU_ADMIN_ALERT_KINDS)[number];
type Severity = (typeof GPU_ALERT_SEVERITIES)[number];
type Db = Pick<PoolClient, "query">;

const RANK = (col: string) =>
  `array_position(ARRAY['info','warning','critical']::text[], ${col}::text)`;

export async function raiseAdminAlert(
  a: {
    kind: GpuAdminAlertKind;
    severity: Severity;
    dedupe_key: string;
    key_owner_account_id?: string | null;
    credential_id?: string | null;
    details?: Record<string, unknown>;
  },
  db: Db = getPool(),
): Promise<void> {
  await db.query(
    `INSERT INTO gpu_admin_alerts (id, kind, severity, dedupe_key, key_owner_account_id,
       credential_id, details, opened, last_seen)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())
     ON CONFLICT (kind, dedupe_key) WHERE resolved_at IS NULL
     DO UPDATE SET last_seen = now(),
                   details = COALESCE(gpu_admin_alerts.details, '{}'::jsonb)
                             || COALESCE(EXCLUDED.details, '{}'::jsonb),
                   -- severity only goes up; an escalation is emailed again
                   severity = CASE WHEN ${RANK("EXCLUDED.severity")} > ${RANK("gpu_admin_alerts.severity")}
                                   THEN EXCLUDED.severity ELSE gpu_admin_alerts.severity END,
                   emailed_at = CASE WHEN ${RANK("EXCLUDED.severity")} > ${RANK("gpu_admin_alerts.severity")}
                                     THEN NULL ELSE gpu_admin_alerts.emailed_at END,
                   email_attempts = CASE WHEN ${RANK("EXCLUDED.severity")} > ${RANK("gpu_admin_alerts.severity")}
                                         THEN 0 ELSE gpu_admin_alerts.email_attempts END,
                   emailed_to = CASE WHEN ${RANK("EXCLUDED.severity")} > ${RANK("gpu_admin_alerts.severity")}
                                     THEN NULL ELSE gpu_admin_alerts.emailed_to END`,
    [
      randomUUID(),
      a.kind,
      a.severity,
      a.dedupe_key.slice(0, 128),
      a.key_owner_account_id ?? null,
      a.credential_id ?? null,
      a.details ?? null,
    ],
  );
}

const EMAIL_BATCH = 20;
// how long a hub holds an alert's email while it sends it
const EMAIL_CLAIM_MS = 5 * 60_000;

export interface AdminAlertEmail {
  id: string;
  kind: string;
  severity: string;
  opened: Date;
  details: Record<string, unknown> | null;
}

// The email projection: every open alert not yet emailed goes to every
// admin, retried with backoff (attempts x 5 min, at most an hour) until it
// has gone to all of them.
// - Each alert is claimed first (a durable claim, across hubs: one sends,
//   the others skip it until the claim expires).
// - Delivery is recorded per recipient (emailed_to): a retry never mails an
//   admin who already got it.
// - emailed_at is set once every current admin has it.
export async function projectAdminAlertEmails({
  recipients,
  send,
}: {
  recipients: () => Promise<{ account_id: string; email_address: string }[]>;
  send: (alert: AdminAlertEmail, to: string) => Promise<void>;
}): Promise<{ sent: number; failed: number }> {
  const claim = randomUUID();
  const { rows } = await getPool().query(
    `UPDATE gpu_admin_alerts
        SET email_claim = $1,
            email_claimed_until = now() + make_interval(secs => $2)
      WHERE id IN (
        SELECT id FROM gpu_admin_alerts
         WHERE emailed_at IS NULL AND resolved_at IS NULL
           AND last_seen + make_interval(mins => LEAST(5 * email_attempts, 60)) <= now()
           AND (email_claimed_until IS NULL OR email_claimed_until < now())
         ORDER BY opened LIMIT $3
         FOR UPDATE SKIP LOCKED)
      RETURNING id, kind, severity, opened, details, emailed_to`,
    [claim, EMAIL_CLAIM_MS / 1000, EMAIL_BATCH],
  );
  if (rows.length === 0) return { sent: 0, failed: 0 };
  const admins = await recipients();
  let sent = 0;
  let failed = 0;
  for (const alert of rows) {
    const done = new Set<string>(alert.emailed_to ?? []);
    let ok = true;
    for (const a of admins) {
      if (done.has(a.account_id)) continue;
      try {
        await send(alert, a.email_address);
        await getPool().query(
          `UPDATE gpu_admin_alerts
              SET emailed_to = array_append(COALESCE(emailed_to, '{}'), $3)
            WHERE id = $1 AND email_claim = $2`,
          [alert.id, claim, a.account_id],
        );
        sent += 1;
      } catch (err) {
        ok = false;
        failed += 1;
        log.warn("emailing a GPU admin alert failed", alert.kind, `${err}`);
      }
    }
    await getPool().query(
      ok
        ? `UPDATE gpu_admin_alerts SET emailed_at = now(), email_claim = NULL,
                  email_claimed_until = NULL
            WHERE id = $1 AND email_claim = $2`
        : `UPDATE gpu_admin_alerts SET email_attempts = email_attempts + 1,
                  email_claim = NULL, email_claimed_until = NULL
            WHERE id = $1 AND email_claim = $2`,
      [alert.id, claim],
    );
  }
  return { sent, failed };
}

// The admins, with an email address (uncached).
export async function adminRecipients(): Promise<
  { account_id: string; email_address: string }[]
> {
  const { default: admins } = await import("@cocalc/server/accounts/admins");
  const ids = await admins();
  if (ids.length === 0) return [];
  const { rows } = await getPool().query(
    "SELECT account_id, email_address FROM accounts WHERE account_id = ANY($1) AND email_address IS NOT NULL ORDER BY account_id",
    [ids],
  );
  return rows;
}

// One admin's email: plain text, no key material (details are ids and
// amounts).
export async function emailAdminAboutAlert(
  alert: AdminAlertEmail,
  to: string,
): Promise<void> {
  const { default: sendEmail } =
    await import("@cocalc/server/email/send-email");
  const subject = `CoCalc GPU admin alert (${alert.severity}): ${alert.kind}`;
  const text = `${subject}\nOpened: ${new Date(alert.opened).toISOString()}\nDetails: ${JSON.stringify(alert.details ?? {})}\n\nSee: cocalc admin gpu alerts`;
  const html = `<pre>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`;
  await sendEmail({ to, subject, text, html });
}

export interface GpuAdminAlertView {
  id: string;
  kind: string;
  severity: string;
  dedupe_key: string;
  key_owner_account_id: string | null;
  credential_id: string | null;
  details: Record<string, unknown> | null;
  opened: string;
  last_seen: string;
  resolved_at: string | null;
  emailed_at: string | null;
}

// CoCalc admins only: this bay's GPU admin alerts (open ones, or recent).
export async function listAdminAlertsLocal(
  opts: { account_id?: string; include_resolved?: boolean },
  deps: { isAdmin?: (account_id: string) => Promise<boolean> } = {},
): Promise<GpuAdminAlertView[]> {
  const account_id = opts.account_id;
  const admin = account_id
    ? await (
        deps.isAdmin ??
        (async (a: string) =>
          (await import("@cocalc/server/accounts/is-admin")).default(a))
      )(account_id)
    : false;
  if (!admin) throw Error("Only an admin can read GPU admin alerts.");
  const { rows } = await getPool().query(
    `SELECT * FROM gpu_admin_alerts
      WHERE ($1::boolean OR resolved_at IS NULL)
      ORDER BY (resolved_at IS NULL) DESC, opened DESC LIMIT 200`,
    [opts.include_resolved === true],
  );
  const iso = (d: any) => (d == null ? null : new Date(d).toISOString());
  return rows.map((r: any) => ({
    id: r.id,
    kind: r.kind,
    severity: r.severity,
    dedupe_key: r.dedupe_key,
    key_owner_account_id: r.key_owner_account_id ?? null,
    credential_id: r.credential_id ?? null,
    details: r.details ?? null,
    opened: iso(r.opened)!,
    last_seen: iso(r.last_seen)!,
    resolved_at: iso(r.resolved_at),
    emailed_at: iso(r.emailed_at),
  }));
}
