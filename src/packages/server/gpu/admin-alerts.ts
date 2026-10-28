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
                             || COALESCE(EXCLUDED.details, '{}'::jsonb)`,
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
const EMAIL_MAX_ATTEMPTS = 20;

// The email projection: every open alert not yet emailed goes to the admins,
// retried with backoff (attempts × 5 min) until it goes out. `send` gets one
// message per alert; a failure leaves the row for the next run.
export async function projectAdminAlertEmails(
  send: (alert: {
    id: string;
    kind: string;
    severity: string;
    opened: Date;
    details: Record<string, unknown> | null;
  }) => Promise<void>,
): Promise<{ sent: number; failed: number }> {
  const { rows } = await getPool().query(
    `SELECT id, kind, severity, opened, details FROM gpu_admin_alerts
      WHERE emailed_at IS NULL AND resolved_at IS NULL AND email_attempts < $1
        AND last_seen + make_interval(mins => 5 * email_attempts) <= now()
      ORDER BY opened LIMIT $2`,
    [EMAIL_MAX_ATTEMPTS, EMAIL_BATCH],
  );
  let sent = 0;
  let failed = 0;
  for (const alert of rows) {
    try {
      await send(alert);
      await getPool().query(
        "UPDATE gpu_admin_alerts SET emailed_at = now() WHERE id = $1",
        [alert.id],
      );
      sent += 1;
    } catch (err) {
      failed += 1;
      log.warn("emailing a GPU admin alert failed", alert.kind, `${err}`);
      await getPool().query(
        "UPDATE gpu_admin_alerts SET email_attempts = email_attempts + 1 WHERE id = $1",
        [alert.id],
      );
    }
  }
  return { sent, failed };
}

// The default sender: one email per admin, plain text, no key material
// (details are ids and amounts).
export async function emailAdminsAboutAlert(alert: {
  kind: string;
  severity: string;
  opened: Date;
  details: Record<string, unknown> | null;
}): Promise<void> {
  const [{ default: admins }, { default: sendEmail }] = await Promise.all([
    import("@cocalc/server/accounts/admins"),
    import("@cocalc/server/email/send-email"),
  ]);
  const ids = await admins();
  if (ids.length === 0) return;
  const { rows } = await getPool().query(
    "SELECT email_address FROM accounts WHERE account_id = ANY($1) AND email_address IS NOT NULL",
    [ids],
  );
  const subject = `CoCalc GPU admin alert (${alert.severity}): ${alert.kind}`;
  const text = `${subject}\nOpened: ${new Date(alert.opened).toISOString()}\nDetails: ${JSON.stringify(alert.details ?? {})}\n\nSee: cocalc admin gpu alerts`;
  const html = `<pre>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`;
  for (const { email_address } of rows) {
    await sendEmail({ to: email_address, subject, text, html });
  }
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
