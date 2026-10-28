/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
What the owner must know about their key's RunPod account (step 5d).

One open alert per (key, kind, dedupe key). Every write carries the
observation it comes from (`observed_at`, when the pass's listing started):
a sighting moves `last_seen` forward only, and a resolution applies only if
it observed later than the last sighting, so passes that overlap (another
hub, a request-time pass) can't resolve what a newer one just saw.

How each kind ends is fixed per kind (STEP5D v2.5), and never because a
listing didn't show something:
- unknown_pod: a guarded getPod 404; if its key is removed or replaced it
  becomes an acknowledgeable warning instead (it can't be checked);
- unmanaged_pod, compromise_check_pods: the owner's acknowledgement;
- key_rejected: a complete list pass, or the key's removal or replacement;
- quarantined_reservation: the reservation's own transition;
- compromise_awaiting_revocation: the compromise close.
*/

import { randomUUID } from "node:crypto";
import getPool, { type PoolClient } from "@cocalc/database/pool";
import { isValidUUID } from "@cocalc/util/misc";
import type {
  GPU_ALERT_KINDS,
  GPU_ALERT_SEVERITIES,
} from "@cocalc/util/db-schema/gpu-budgets";

export type GpuAlertKind = (typeof GPU_ALERT_KINDS)[number];
export type GpuAlertSeverity = (typeof GPU_ALERT_SEVERITIES)[number];

type Db = Pick<PoolClient, "query">;

// Kinds the owner ends by acknowledging (the condition can't be checked
// any more, or it is an instruction).
const ACKNOWLEDGED_KINDS = new Set<GpuAlertKind>([
  "unmanaged_pod",
  "compromise_check_pods",
]);

export interface GpuAlertInput {
  key_owner_account_id: string;
  credential_id: string;
  kind: GpuAlertKind;
  severity: GpuAlertSeverity;
  dedupe_key: string;
  details?: Record<string, unknown>;
  observed_at: Date;
}

// Open the alert, or record that its condition was seen again.
export async function raiseAlert(
  a: GpuAlertInput,
  db: Db = getPool(),
): Promise<void> {
  await db.query(
    `INSERT INTO gpu_alerts (id, key_owner_account_id, credential_id, kind, severity,
       dedupe_key, details, opened, last_seen)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8)
     ON CONFLICT (credential_id, kind, dedupe_key) WHERE resolved_at IS NULL
     DO UPDATE SET last_seen = GREATEST(gpu_alerts.last_seen, EXCLUDED.last_seen),
                   details = COALESCE(EXCLUDED.details, gpu_alerts.details)`,
    [
      randomUUID(),
      a.key_owner_account_id,
      a.credential_id,
      a.kind,
      a.severity,
      a.dedupe_key.slice(0, 128),
      a.details ?? null,
      a.observed_at,
    ],
  );
}

// Resolve one open alert, if nothing saw its condition after `observed_at`.
// dedupe_key undefined: every open alert of that kind for the key.
export async function resolveAlert(
  {
    credential_id,
    kind,
    dedupe_key,
    observed_at,
    by,
  }: {
    credential_id: string;
    kind: GpuAlertKind;
    dedupe_key?: string;
    observed_at: Date;
    by: string;
  },
  db: Db = getPool(),
): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE gpu_alerts SET resolved_at = now(), resolved_by = $4
      WHERE credential_id = $1 AND kind = $2 AND resolved_at IS NULL
        AND ($3::text IS NULL OR dedupe_key = $3)
        AND last_seen < $5`,
    [credential_id, kind, dedupe_key ?? null, by.slice(0, 40), observed_at],
  );
  return rowCount ?? 0;
}

// The key was removed or replaced: what can't be checked any more stays
// open as an acknowledgeable warning (never "resolved"); a rejected key is
// moot.
export async function onKeyGone(
  { credential_id, by }: { credential_id: string; by: string },
  db: Db = getPool(),
): Promise<void> {
  await db.query(
    `UPDATE gpu_alerts SET severity = 'warning',
            details = COALESCE(details, '{}'::jsonb) || '{"unverifiable": true}'::jsonb
      WHERE credential_id = $1 AND kind = 'unknown_pod' AND resolved_at IS NULL`,
    [credential_id],
  );
  await db.query(
    `UPDATE gpu_alerts SET resolved_at = now(), resolved_by = $2
      WHERE credential_id = $1 AND kind = 'key_rejected' AND resolved_at IS NULL`,
    [credential_id, by.slice(0, 40)],
  );
}

export interface GpuAlertView {
  id: string;
  credential_id: string;
  kind: GpuAlertKind;
  severity: GpuAlertSeverity;
  details: Record<string, unknown> | null;
  opened: string;
  last_seen: string;
  resolved_at: string | null;
  resolved_by: string | null;
  acknowledged_at: string | null;
  // the owner can end it by acknowledging
  acknowledgeable: boolean;
}

function view(r: any): GpuAlertView {
  const iso = (d: any) => (d == null ? null : new Date(d).toISOString());
  return {
    id: r.id,
    credential_id: r.credential_id,
    kind: r.kind,
    severity: r.severity,
    details: r.details ?? null,
    opened: iso(r.opened)!,
    last_seen: iso(r.last_seen)!,
    resolved_at: iso(r.resolved_at),
    resolved_by: r.resolved_by ?? null,
    acknowledged_at: iso(r.acknowledged_at),
    acknowledgeable:
      r.resolved_at == null &&
      (ACKNOWLEDGED_KINDS.has(r.kind) ||
        (r.kind === "unknown_pod" && r.details?.unverifiable === true)),
  };
}

// On the key owner's home bay.
export async function listAlertsLocal({
  account_id,
  include_resolved,
}: {
  account_id: string;
  include_resolved?: boolean;
}): Promise<GpuAlertView[]> {
  const { rows } = await getPool().query(
    `SELECT * FROM gpu_alerts WHERE key_owner_account_id = $1
        AND ($2::boolean OR resolved_at IS NULL)
      ORDER BY (resolved_at IS NULL) DESC, opened DESC LIMIT 200`,
    [account_id, include_resolved === true],
  );
  return rows.map(view);
}

// The owner ends an alert that only they can end.
export async function acknowledgeAlertLocal({
  account_id,
  id,
}: {
  account_id: string;
  id: unknown;
}): Promise<GpuAlertView> {
  if (typeof id !== "string" || !isValidUUID(id)) {
    throw Error("Give a valid alert id.");
  }
  const { rows } = await getPool().query(
    "SELECT * FROM gpu_alerts WHERE id = $1 AND key_owner_account_id = $2",
    [id, account_id],
  );
  const current = rows[0];
  if (!current) throw Error("No such GPU alert.");
  if (!view(current).acknowledgeable) {
    throw Error(
      current.resolved_at != null
        ? "This alert is already resolved."
        : "This alert ends on its own once CoCalc confirms the condition is gone; it can't be acknowledged.",
    );
  }
  const { rows: updated } = await getPool().query(
    `UPDATE gpu_alerts SET acknowledged_at = now(), resolved_at = now(), resolved_by = 'acknowledged'
      WHERE id = $1 AND resolved_at IS NULL RETURNING *`,
    [id],
  );
  return view(updated[0] ?? current);
}
