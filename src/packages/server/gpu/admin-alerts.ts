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
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import type { GpuAdminAlert } from "@cocalc/conat/hub/api/gpu";
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
                                     THEN NULL ELSE gpu_admin_alerts.emailed_to END,
                   -- and revokes any hub's claim on the lower one
                   email_claim = CASE WHEN ${RANK("EXCLUDED.severity")} > ${RANK("gpu_admin_alerts.severity")}
                                      THEN NULL ELSE gpu_admin_alerts.email_claim END,
                   email_claimed_until = CASE WHEN ${RANK("EXCLUDED.severity")} > ${RANK("gpu_admin_alerts.severity")}
                                              THEN NULL ELSE gpu_admin_alerts.email_claimed_until END,
                   email_next_at = CASE WHEN ${RANK("EXCLUDED.severity")} > ${RANK("gpu_admin_alerts.severity")}
                                        THEN NULL ELSE gpu_admin_alerts.email_next_at END`,
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

// at most this many alerts per projection
const EMAIL_BATCH = 20;
// how long a hub holds an alert's email; renewed before every send, and
// each send is cut off well inside it
const EMAIL_CLAIM_MS = 5 * 60_000;

export interface AdminAlertEmail {
  id: string;
  kind: string;
  severity: string;
  opened: Date;
  details: Record<string, unknown> | null;
}

class ClaimLost extends Error {}

// The email projection: every open alert not yet emailed goes to every
// admin, retried with backoff (attempts x 5 min after the failed attempt,
// at most an hour; an escalation is due at once) until it has gone to all
// of them.
// - Alerts are claimed one at a time, just before they are sent (a durable
//   claim, across hubs: one sends, the others skip it until it expires).
// - Before each send the claim is renewed and the alert re-read, so what
//   goes out is its current version, and each send is bounded inside the
//   claim. An escalation revokes the claim: the old sender's next write
//   matches nothing and it stops; the escalated alert is sent afresh.
// - Delivery is recorded per recipient (emailed_to): a retry never mails an
//   admin who already got it.
// - emailed_at is set once every current admin has it.
export async function projectAdminAlertEmails({
  recipients,
  send,
  claimMs = EMAIL_CLAIM_MS,
}: {
  recipients: () => Promise<{ account_id: string; email_address: string }[]>;
  send: (alert: AdminAlertEmail, to: string) => Promise<void>;
  claimMs?: number;
}): Promise<{ sent: number; failed: number }> {
  let admins: { account_id: string; email_address: string }[] | undefined;
  let sent = 0;
  let failed = 0;
  const owned = async (sql: string, args: unknown[]) => {
    const { rows } = await getPool().query(sql, args);
    if (rows.length === 0) throw new ClaimLost();
    return rows[0];
  };
  for (let n = 0; n < EMAIL_BATCH; n++) {
    const claim = randomUUID();
    const { rows } = await getPool().query(
      `UPDATE gpu_admin_alerts
          SET email_claim = $1,
              email_claimed_until = now() + make_interval(secs => $2)
        WHERE id = (
          SELECT id FROM gpu_admin_alerts
           WHERE emailed_at IS NULL AND resolved_at IS NULL
             AND (email_next_at IS NULL OR email_next_at <= now())
             AND (email_claimed_until IS NULL OR email_claimed_until < now())
           ORDER BY opened LIMIT 1
           FOR UPDATE SKIP LOCKED)
        RETURNING id`,
      [claim, claimMs / 1000],
    );
    if (rows.length === 0) break;
    const id = rows[0].id;
    admins ??= await recipients();
    let ok = true;
    try {
      for (const a of admins) {
        // renew, and send what the alert is now
        const alert = await owned(
          `UPDATE gpu_admin_alerts
              SET email_claimed_until = now() + make_interval(secs => $3)
            WHERE id = $1 AND email_claim = $2 AND resolved_at IS NULL
            RETURNING id, kind, severity, opened, details, emailed_to`,
          [id, claim, claimMs / 1000],
        );
        if ((alert.emailed_to ?? []).includes(a.account_id)) continue;
        try {
          await within(send(alert, a.email_address), claimMs / 2);
        } catch (err) {
          ok = false;
          failed += 1;
          log.warn("emailing a GPU admin alert failed", alert.kind, `${err}`);
          continue;
        }
        sent += 1;
        await owned(
          `UPDATE gpu_admin_alerts
              SET emailed_to = array_append(COALESCE(emailed_to, '{}'), $3)
            WHERE id = $1 AND email_claim = $2
            RETURNING id`,
          [id, claim, a.account_id],
        );
      }
      await owned(
        ok
          ? `UPDATE gpu_admin_alerts SET emailed_at = now(), email_claim = NULL,
                    email_claimed_until = NULL
              WHERE id = $1 AND email_claim = $2 RETURNING id`
          : `UPDATE gpu_admin_alerts SET email_attempts = email_attempts + 1,
                    email_next_at = now() + make_interval(mins => LEAST(5 * (email_attempts + 1), 60)),
                    email_claim = NULL, email_claimed_until = NULL
              WHERE id = $1 AND email_claim = $2 RETURNING id`,
        [id, claim],
      );
    } catch (err) {
      if (!(err instanceof ClaimLost)) throw err;
      // escalated, resolved or taken over: its new owner (or the next
      // projection) sends it
      log.warn("lost the claim on a GPU admin alert's email", id);
    }
  }
  return { sent, failed };
}

async function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error("email send timed out")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
  const bay = getConfiguredBayId();
  const subject = `CoCalc GPU admin alert (${alert.severity}): ${alert.kind}`;
  const text = `${subject}\nBay: ${bay}\nOpened: ${new Date(alert.opened).toISOString()}\nDetails: ${JSON.stringify(alert.details ?? {})}\n\nSee: cocalc admin gpu alerts --bay ${bay}`;
  const html = `<pre>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`;
  await sendEmail({ to, subject, text, html });
}

const INTER_BAY_TIMEOUT_MS = 20_000;

// This bay's GPU admin alerts (open ones, or recent): callers check the
// admin (the hub API, or the bay that asked over inter-bay).
export async function readAdminAlertsLocal(opts: {
  include_resolved?: boolean;
}): Promise<GpuAdminAlert[]> {
  const { rows } = await getPool().query(
    `SELECT * FROM gpu_admin_alerts
      WHERE ($1::boolean OR resolved_at IS NULL)
      ORDER BY (resolved_at IS NULL) DESC, opened DESC LIMIT 200`,
    [opts.include_resolved === true],
  );
  const bay_id = getConfiguredBayId();
  const iso = (d: any) => (d == null ? null : new Date(d).toISOString());
  return rows.map((r: any) => ({
    bay_id,
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

// CoCalc admins only: every bay's GPU admin alerts, or only bay_id's (each
// bay keeps its own; an email names its bay).
export async function listAdminAlertsLocal(
  opts: { account_id?: string; include_resolved?: boolean; bay_id?: string },
  deps: {
    isAdmin?: (account_id: string) => Promise<boolean>;
    bays?: () => Promise<string[]>;
    readBay?: (
      bay_id: string,
      opts: { include_resolved?: boolean },
    ) => Promise<GpuAdminAlert[]>;
  } = {},
): Promise<{
  alerts: GpuAdminAlert[];
  errors: { bay_id: string; error: string }[];
}> {
  const account_id = opts.account_id;
  const admin = account_id
    ? await (
        deps.isAdmin ??
        (async (a: string) =>
          (await import("@cocalc/server/accounts/is-admin")).default(a))
      )(account_id)
    : false;
  if (!admin) throw Error("Only an admin can read GPU admin alerts.");
  const configured = await (deps.bays ?? configuredBays)();
  const wanted = `${opts.bay_id ?? ""}`.trim();
  if (wanted && !configured.includes(wanted)) {
    throw Error(`unknown or unavailable bay '${wanted}'`);
  }
  const read = deps.readBay ?? readBay;
  const query = { include_resolved: opts.include_resolved === true };
  const alerts: GpuAdminAlert[] = [];
  const errors: { bay_id: string; error: string }[] = [];
  await Promise.all(
    (wanted ? [wanted] : configured).map(async (bay_id) => {
      try {
        alerts.push(...(await read(bay_id, query)));
      } catch (err) {
        errors.push({ bay_id, error: `${err}`.slice(0, 500) });
      }
    }),
  );
  alerts.sort(
    (a, b) =>
      Number(a.resolved_at != null) - Number(b.resolved_at != null) ||
      b.opened.localeCompare(a.opened),
  );
  errors.sort((a, b) => a.bay_id.localeCompare(b.bay_id));
  return { alerts, errors };
}

async function configuredBays(): Promise<string[]> {
  const { listConfiguredBays } = await import("@cocalc/server/bay-directory");
  return [
    ...new Set((await listConfiguredBays()).map(({ bay_id }) => bay_id)),
  ].sort();
}

async function readBay(
  bay_id: string,
  opts: { include_resolved?: boolean },
): Promise<GpuAdminAlert[]> {
  if (bay_id === getConfiguredBayId()) return await readAdminAlertsLocal(opts);
  const { getInterBayBridge } = await import("@cocalc/server/inter-bay/bridge");
  return await getInterBayBridge()
    .bayOps(bay_id, { timeout_ms: INTER_BAY_TIMEOUT_MS })
    .getGpuAdminAlerts(opts);
}
