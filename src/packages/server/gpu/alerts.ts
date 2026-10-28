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
  GpuAlert,
  GpuAlertKind,
  GpuAlertSeverity,
} from "@cocalc/util/gpu/types";

export type { GpuAlertKind, GpuAlertSeverity };

type Db = Pick<PoolClient, "query">;

// Kinds the owner ends by acknowledging (the condition can't be checked
// any more, or it is an instruction).
const ACKNOWLEDGED_KINDS = new Set<GpuAlertKind>([
  "unmanaged_pod",
  "compromise_check_pods",
  // 5d-2a: facts about money already spent, for the owner to look at
  "spend_drift",
  "billing_missing",
  "over_budget",
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

// Open the alert, or record that its condition was seen again. A sighting
// older than the observation that resolved the same alert (a newer pass
// proved it gone) opens nothing. True if it is open now with this sighting.
export async function raiseAlert(
  a: GpuAlertInput,
  db: Db = getPool(),
): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO gpu_alerts (id, key_owner_account_id, credential_id, kind, severity,
       dedupe_key, details, opened, last_seen)
     SELECT $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text, $7::jsonb, now(),
            $8::timestamptz
      WHERE NOT EXISTS (
        SELECT 1 FROM gpu_alerts r
         WHERE r.credential_id = $3::uuid AND r.kind = $4::text AND r.dedupe_key = $6::text
           AND r.resolved_at IS NOT NULL AND r.resolved_observed_at >= $8::timestamptz)
     ON CONFLICT (credential_id, kind, dedupe_key) WHERE resolved_at IS NULL
     DO UPDATE SET last_seen = GREATEST(gpu_alerts.last_seen, EXCLUDED.last_seen),
                   details = COALESCE(gpu_alerts.details, '{}'::jsonb)
                             || COALESCE(EXCLUDED.details, '{}'::jsonb)`,
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
  return (rowCount ?? 0) > 0;
}

// Run `fn` only while the key's fence is live (active or draining), holding
// it (FOR UPDATE: overlapping passes take turns, and pausing needs the row
// anyway) until `fn` commits. A reconcile pass may finish after the
// key was removed, replaced or reported compromised: closing the fence takes
// the same row, so either this commits first (and the close then converts
// or resolves what it wrote) or the close does (and this writes nothing).
// Undefined if the fence isn't live.
export async function underLiveFence<T>(
  credential_id: string,
  fn: (db: PoolClient) => Promise<T>,
): Promise<T | undefined> {
  const db = await getPool().connect();
  try {
    await db.query("BEGIN");
    const { rows } = await db.query(
      `SELECT 1 FROM gpu_key_fences
        WHERE credential_id = $1 AND state IN ('active', 'draining') FOR UPDATE`,
      [credential_id],
    );
    if (rows.length === 0) {
      await db.query("ROLLBACK");
      return undefined;
    }
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    db.release();
  }
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
    `UPDATE gpu_alerts SET resolved_at = now(), resolved_by = $4, resolved_observed_at = $5
      WHERE credential_id = $1 AND kind = $2 AND resolved_at IS NULL
        AND ($3::text IS NULL OR dedupe_key = $3)
        AND last_seen < $5`,
    [credential_id, kind, dedupe_key ?? null, by.slice(0, 40), observed_at],
  );
  return rowCount ?? 0;
}

// The key was removed or replaced: what can't be checked any more stays
// open as an acknowledgeable warning (never "resolved"); a rejected key is
// moot, for good (no later sighting reopens it).
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
    `UPDATE gpu_alerts SET resolved_at = now(), resolved_by = $2,
            resolved_observed_at = 'infinity'
      WHERE credential_id = $1 AND kind = 'key_rejected' AND resolved_at IS NULL`,
    [credential_id, by.slice(0, 40)],
  );
}

// What each kind tells the owner (details carry the specifics).
const MESSAGES: Record<GpuAlertKind, string> = {
  unknown_pod:
    "A pod CoCalc didn't start is on the RunPod account of your key. If you don't recognize it, terminate it at RunPod and consider reporting the key compromised (cocalc gpu report-compromised). New launches with this key are paused until you resume them (cocalc gpu resume).",
  unmanaged_pod:
    "A pod CoCalc launched was left running when the key was removed anyway: CoCalc can't see or stop it, and your GPU limits no longer cover it. Terminate it at RunPod, then acknowledge this alert.",
  key_rejected:
    "RunPod rejects this key, so CoCalc can't check or stop pods on its account. Connect a working key, or remove this one. New launches are paused until you resume them.",
  quarantined_reservation:
    "CoCalc doesn't know whether RunPod created this pod, so its share of your budget stays held. If you've checked at RunPod that it doesn't exist (or terminated it), release the hold with cocalc gpu release-quarantined.",
  compromise_awaiting_revocation:
    "You reported this key compromised. CoCalc keeps terminating every pod on its RunPod account until you delete the key on RunPod's Credentials page.",
  spend_drift:
    "RunPod billed a pod well above CoCalc's estimate for it. Your GPU budget now counts what RunPod billed. If you don't expect this, check the pod at RunPod. When the difference is large, new launches pause until you resume them (cocalc gpu resume).",
  billing_missing:
    "RunPod's billing never fully covered a pod CoCalc ran with this key, so CoCalc kept its own estimate as the pod's spend (normally a little above what RunPod bills). You can compare it with RunPod's billing page.",
  over_budget:
    "RunPod's billing pushed spending past what this GPU budget authorizes. New launches it covers are refused until you raise the budget or a new period starts.",
  compromise_check_pods:
    "CoCalc removed the compromised key and stopped watching its RunPod account. Check RunPod's Pods page once and terminate any pod you don't recognize, then acknowledge this alert.",
};

export type GpuAlertView = GpuAlert;

function view(r: any): GpuAlertView {
  const iso = (d: any) => (d == null ? null : new Date(d).toISOString());
  return {
    id: r.id,
    credential_id: r.credential_id,
    kind: r.kind,
    severity: r.severity,
    message:
      r.kind === "unknown_pod" && r.details?.unverifiable === true
        ? "A pod CoCalc didn't start was on the RunPod account of a key that has since been removed or replaced, so CoCalc can't check it anymore. Look at RunPod's Pods page, terminate it if it's still there, then acknowledge this alert."
        : (MESSAGES[r.kind as GpuAlertKind] ?? ""),
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
