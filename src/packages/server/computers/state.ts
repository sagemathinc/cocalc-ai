/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A computer's signed state snapshot at its home bay: floors, the effective
// policy and "ended", which every daemon that may be running work applies.
// Design: src/.agents/computers-revocation-gate-2026-10-14.md (§1-§3).
//
// - Every change of what the snapshot says bumps account_computers.
//   state_version, in the change's own transaction (holding the computer row),
//   and raises the delivery target of every open session of the computer.
// - A login inserts its session not ready, with a target at the current
//   version, under the same row lock: a login can't miss a bump.
// - delivery.ts sends the snapshot and, on the daemon's exact ack, marks the
//   session ready. No operation reaches a session before that.

import getPool from "@cocalc/database/pool";
import { parseComputerPolicy } from "@cocalc/util/computers/policy";
import {
  MAX_STATE_PROJECT_FLOORS,
  parseComputerState,
  SIGNED_KINDS,
  type ComputerEndReason,
  type ComputerState,
  type SignedEnvelope,
} from "@cocalc/util/computers/protocol";
import type { Queryable } from "./authority";
import { signWithBayKey } from "./signing-keys";

/**
 * Bump the state of these computers and raise their open sessions'
 * targets. Call inside the transaction that made the change, after the
 * computer rows are locked (FOR UPDATE, or updated by that transaction).
 */
export async function bumpComputerState(
  db: Queryable,
  computer_ids: string[],
): Promise<void> {
  if (computer_ids.length === 0) return;
  await db.query(
    `UPDATE account_computers SET state_version=state_version+1
      WHERE computer_id = ANY($1::uuid[])`,
    [computer_ids],
  );
  await raiseTargets(db, computer_ids);
}

/**
 * Every open session (whatever its epoch) owes the computer's current
 * state. Raising a target clears its claim, so an attempt for an older
 * version can't finalize.
 */
async function raiseTargets(
  db: Queryable,
  computer_ids: string[],
): Promise<void> {
  await db.query(
    `INSERT INTO account_computer_session_targets AS t
       (session_id, account_id, computer_id, generation, state_version)
     SELECT s.session_id, s.account_id, s.computer_id, s.generation,
            c.state_version
       FROM account_computer_sessions s
       JOIN account_computers c ON c.computer_id = s.computer_id
      WHERE s.computer_id = ANY($1::uuid[]) AND s.closed_at IS NULL
     ON CONFLICT (session_id) DO UPDATE SET
       generation=EXCLUDED.generation, state_version=EXCLUDED.state_version,
       reply_subject=NULL, claimed_by_hub=NULL, attempt_token=NULL,
       lease_until=NULL, attempts=0, last_error=NULL
     WHERE t.state_version < EXCLUDED.state_version
        OR t.generation <> EXCLUDED.generation`,
    [computer_ids],
  );
}

/** A new session's target, in the login transaction (row locked). */
export async function addSessionTarget(
  db: Queryable,
  s: {
    session_id: string;
    account_id: string;
    computer_id: string;
    generation: number;
    state_version: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO account_computer_session_targets
       (session_id, account_id, computer_id, generation, state_version)
     VALUES ($1,$2,$3,$4,$5)`,
    [s.session_id, s.account_id, s.computer_id, s.generation, s.state_version],
  );
}

/**
 * End these computers for good (first reason wins: it is terminal), in the
 * caller's transaction, which holds their rows; bump their state.
 */
export async function endComputers(
  db: Queryable,
  computer_ids: string[],
  reason: ComputerEndReason,
): Promise<void> {
  if (computer_ids.length === 0) return;
  // Ended is also revoked (every existing check refuses it), and the first
  // revocation bumps the epoch, so daemons' floors rise with it.
  await db.query(
    `UPDATE account_computers
        SET ended_reason=COALESCE(ended_reason,$2),
            epoch=CASE WHEN revoked_at IS NULL THEN epoch+1 ELSE epoch END,
            revoked_at=COALESCE(revoked_at,now()), updated_at=now()
      WHERE computer_id = ANY($1::uuid[])`,
    [computer_ids, reason],
  );
  await bumpComputerState(db, computer_ids);
}

/**
 * What a row's snapshot says about ending. Rows revoked or tombstoned
 * before ended_reason existed are ended too.
 */
export function endedOf(row: {
  ended_reason?: string | null;
  revoked_at?: unknown;
  tombstoned_at?: unknown;
}): { reason: ComputerEndReason } | null {
  if (row.ended_reason != null) {
    return { reason: row.ended_reason as ComputerEndReason };
  }
  if (row.tombstoned_at != null) return { reason: "replaced" };
  if (row.revoked_at != null) return { reason: "revoked" };
  return null;
}

export class ComputerStateError extends Error {}

export interface StateSnapshot {
  envelope: SignedEnvelope<ComputerState>;
  state_version: string;
}

/**
 * The computer's current snapshot, read consistently (the row FOR SHARE,
 * so no bump is half-seen) from typed columns, signed with its
 * certificate's issuing key. Undefined if there is no such computer or
 * that key is gone (then the certificate has expired too, and the daemon
 * has ended itself).
 */
export async function computerStateSnapshot(
  computer_id: string,
  now = Date.now(),
): Promise<StateSnapshot | undefined> {
  const client = await getPool().connect();
  let payload: ComputerState;
  let kid: string;
  try {
    await client.query("BEGIN");
    const row = (
      await client.query(
        `SELECT computer_id, state_version, home_epoch, epoch, policy_epoch,
                effective_policy, ended_reason, revoked_at, tombstoned_at,
                certificate
           FROM account_computers WHERE computer_id=$1 FOR SHARE`,
        [computer_id],
      )
    ).rows[0];
    if (row == null) {
      await client.query("COMMIT");
      return undefined;
    }
    // Only floors of projects whose work may remain there: a pair past
    // both its possibly-active time and its last start_by has nothing left
    // to stop (recheck.ts), so the snapshot stays within the admission
    // bound whatever the asynchronous GC is doing.
    const floors = (
      await client.query(
        `SELECT f.project_id, f.privacy_epoch
           FROM account_computer_project_floors f
           JOIN account_computer_active_projects a
             ON a.computer_id=f.computer_id AND a.project_id=f.project_id
          WHERE f.computer_id=$1
            AND NOT (a.possibly_active_until IS NOT NULL
                     AND a.possibly_active_until < now()
                     AND a.last_start_by < now())
          ORDER BY f.project_id LIMIT $2`,
        [computer_id, MAX_STATE_PROJECT_FLOORS + 1],
      )
    ).rows;
    await client.query("COMMIT");
    if (floors.length > MAX_STATE_PROJECT_FLOORS) {
      // The admission bound keeps this from happening; refuse rather than
      // drop a floor.
      throw new ComputerStateError(
        `more than ${MAX_STATE_PROJECT_FLOORS} project floors`,
      );
    }
    kid = `${row.certificate?.kid ?? ""}`;
    payload = parseComputerState({
      type: "cocalc-computer-state",
      version: 1,
      computer_id: row.computer_id,
      state_version: `${row.state_version}`,
      home_epoch: Number(row.home_epoch),
      computer_epoch: Number(row.epoch),
      project_floors: Object.fromEntries(
        floors.map((f) => [f.project_id, Number(f.privacy_epoch)]),
      ),
      policy_epoch: Number(row.policy_epoch),
      policy: parseComputerPolicy(row.effective_policy),
      ended: endedOf(row),
      issued_at: now,
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  const envelope = await signWithBayKey(kid, SIGNED_KINDS.state, payload);
  if (envelope == null) return undefined;
  return { envelope, state_version: payload.state_version };
}
