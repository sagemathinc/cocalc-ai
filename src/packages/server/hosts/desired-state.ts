/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Whether a project host should run (metadata.desired_state) is an intent
// with a generation (project_hosts.desired_state_generation). Every
// intentional change bumps the generation in the same statement; a database
// trigger reverts any other change, so a writer saving back an old metadata
// object cannot flip it. Start, stop and restart work records the generation
// it was queued under (payload.intent_generation) and skips itself once a
// newer intent exists.

import getPool, { type PoolClient } from "@cocalc/database/pool";

export type HostDesiredState = "running" | "stopped";

type Queryable = Pick<PoolClient, "query">;

// SET fragment for statements that change desired_state on purpose.
export const BUMP_DESIRED_STATE_GENERATION =
  "desired_state_generation = COALESCE(desired_state_generation, 0) + 1";

export function hostIntentGeneration(row: any): number {
  const value = Number(row?.desired_state_generation ?? 0);
  return Number.isFinite(value) ? value : 0;
}

// Whether queued lifecycle work was overtaken by a newer intent. Work without
// a recorded generation (queued by older code, or not intent-driven) is not.
export function intentSuperseded(row: any, payload: any): boolean {
  const queued = payload?.intent_generation;
  if (queued == null || queued === "") return false;
  const generation = Number(queued);
  if (!Number.isFinite(generation)) return false;
  return hostIntentGeneration(row) > generation;
}

// Record an intent (a start or stop request, billing enforcement, a
// relocation). Returns the new generation, or undefined if the host is gone.
export async function setHostDesiredState({
  db = getPool(),
  host_id,
  state,
}: {
  db?: Queryable;
  host_id: string;
  state: HostDesiredState;
}): Promise<number | undefined> {
  const { rows } = await db.query(
    `UPDATE project_hosts
        SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{desired_state}', to_jsonb($2::text)),
            ${BUMP_DESIRED_STATE_GENERATION},
            updated = NOW()
      WHERE id=$1 AND deleted IS NULL
      RETURNING desired_state_generation`,
    [host_id, state],
  );
  return rows[0] ? hostIntentGeneration(rows[0]) : undefined;
}

// Automatic recovery (Spot retries and restores, verification fallbacks,
// shutdown notices) wants a host running again. It must never override a
// stop, however stale its own view of the host: in one transaction holding
// the host row it refuses while the host is wanted stopped, marks it wanted
// running (a new generation only if that changes the intent), applies its
// other writes, and queues its start under that generation. A stop either
// commits first (and recovery is refused) or waits and bumps the generation
// after the start was queued (and the start then skips itself).
export async function recoverHostToRunning({
  host_id,
  write,
  enqueue,
}: {
  host_id: string;
  write?: (client: PoolClient) => Promise<unknown>;
  enqueue: (client: PoolClient, intent_generation: number) => Promise<unknown>;
}): Promise<boolean> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT metadata->>'desired_state' AS desired_state, desired_state_generation
         FROM project_hosts WHERE id=$1 AND deleted IS NULL
        FOR UPDATE`,
      [host_id],
    );
    if (!rows[0] || `${rows[0].desired_state ?? ""}` === "stopped") {
      await client.query("ROLLBACK");
      return false;
    }
    let generation = hostIntentGeneration(rows[0]);
    if (`${rows[0].desired_state ?? ""}` !== "running") {
      generation =
        (await setHostDesiredState({
          db: client,
          host_id,
          state: "running",
        })) ?? generation;
    }
    await write?.(client);
    await enqueue(client, generation);
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
