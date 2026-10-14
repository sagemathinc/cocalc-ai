/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Connected computers at the account's home bay: list, revoke, rename,
// notes, extend, narrow the effective policy, and epoch bumps when the
// computer's agent network narrows.
// Plan: src/.agents/computers-plan-2026-10-11.md.
//
// Every change that withdraws authority bumps the computer's epoch, which
// daemons enforce as a floor; every change of the effective policy bumps the
// policy epoch. Both happen under FOR UPDATE, so a ticket issued under
// FOR SHARE can't straddle them. Each also bumps the computer's state
// (state.ts), so the signed snapshot reaches every open session, and a
// revoked computer is told it has ended (delivery.ts).

import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";
import { isValidUUID } from "@cocalc/util/misc";
import {
  parseComputerPolicy,
  policyWideningReasons,
} from "@cocalc/util/computers/policy";
import type { ComputerSummary } from "@cocalc/util/computers/api";
import { computerName } from "./requests";
import { SESSION_LIVENESS_MS } from "./sessions";
import { assertComputersAuthority, lockAgentControls } from "./authority";
import { bumpComputerState, endComputers } from "./state";
import { kickComputerStateDelivery } from "./delivery";

export type { ComputerSummary };

export const MAX_NOTES_BYTES = 4096;
export const NOTES_HISTORY = 20;

export class ComputerError extends Error {}

/**
 * Computer rows with whether one is connected now (a live session) and when
 * it was last heard from: sessions carry the heartbeat, the computer row only
 * the last login.
 */
const COMPUTERS = `
  SELECT c.*, s.live, s.seen FROM account_computers c
  LEFT JOIN LATERAL (
    SELECT max(last_seen) AS seen,
           bool_or(closed_at IS NULL AND lease_until > now()
                   AND last_seen > now() - make_interval(secs => ${SESSION_LIVENESS_MS / 1000}))
             AS live
      FROM account_computer_sessions WHERE computer_id = c.computer_id) s ON true`;

function summary(row: any): ComputerSummary {
  const t = (v: any) => (v == null ? null : new Date(v).valueOf());
  return {
    computer_id: row.computer_id,
    name: row.name,
    hostname: row.hostname,
    os: row.os,
    arch: row.arch,
    machine_user: row.machine_user,
    mode: row.mode,
    agent_network_id: row.agent_network_id,
    effective_policy: row.effective_policy,
    policy_epoch: Number(row.policy_epoch),
    epoch: Number(row.epoch),
    deadline: t(row.deadline),
    max_deadline: t(row.max_deadline),
    notes: row.notes,
    notes_revision: Number(row.notes_revision),
    notes_locked: !!row.notes_locked,
    connected_at: t(row.connected_at),
    last_seen: t(
      row.seen != null && (row.last_seen == null || row.seen > row.last_seen)
        ? row.seen
        : row.last_seen,
    ),
    connected:
      row.live === true &&
      row.revoked_at == null &&
      (row.deadline == null || new Date(row.deadline).valueOf() > Date.now()) &&
      !(Number(row.certificate?.payload?.not_after) <= Date.now()),
    revoked_at: t(row.revoked_at),
    certificate_not_after: Number.isFinite(
      Number(row.certificate?.payload?.not_after),
    )
      ? Number(row.certificate.payload.not_after)
      : null,
    origin: row.origin,
  };
}

export async function listComputers(
  account_id: string,
): Promise<ComputerSummary[]> {
  requireUuid(account_id, "account_id");
  const { rows } = await getPool().query(
    `${COMPUTERS}
      WHERE c.account_id=$1 AND c.tombstoned_at IS NULL ORDER BY c.name`,
    [account_id],
  );
  return rows.map(summary);
}

export async function getComputer(
  account_id: string,
  computer_id: string,
): Promise<ComputerSummary> {
  requireUuid(account_id, "account_id");
  requireUuid(computer_id, "computer_id");
  const { rows } = await getPool().query(
    `${COMPUTERS}
      WHERE c.account_id=$1 AND c.computer_id=$2 AND c.tombstoned_at IS NULL`,
    [account_id, computer_id],
  );
  if (rows[0] == null) throw new ComputerError("no such computer");
  return summary(rows[0]);
}

const MEMBER_FILTER = `
  EXISTS (SELECT 1 FROM agent_networks n
            JOIN agent_network_members m ON m.agent_network_id = n.agent_network_id
           WHERE n.agent_network_id = c.agent_network_id AND n.account_id = c.account_id
             AND n.state = 'active' AND m.member_kind = 'registered'
             AND m.removed_at IS NULL AND m.registered_agent_id = $2 AND m.project_id = $3)`;

/** The computers an agent may use: those serving a network it is in. */
export async function listComputersForAgent(
  account_id: string,
  agent_id: string,
  project_id: string,
): Promise<ComputerSummary[]> {
  for (const [v, w] of [
    [account_id, "account_id"],
    [agent_id, "agent_id"],
    [project_id, "project_id"],
  ]) {
    requireUuid(v, w);
  }
  const { rows } = await getPool().query(
    `${COMPUTERS}
      WHERE c.account_id=$1 AND c.tombstoned_at IS NULL AND ${MEMBER_FILTER}
      ORDER BY c.name`,
    [account_id, agent_id, project_id],
  );
  return rows.map(summary);
}

export async function getComputerForAgent(
  account_id: string,
  agent_id: string,
  project_id: string,
  ref: string,
): Promise<ComputerSummary> {
  const found = (
    await listComputersForAgent(account_id, agent_id, project_id)
  ).find((c) => c.computer_id === ref.toLowerCase() || c.name === ref);
  if (found == null)
    throw new ComputerError(`no computer '${ref}' for this agent`);
  return found;
}

/** A computer by alias or id. */
export async function getComputerByRef(
  account_id: string,
  ref: string,
): Promise<ComputerSummary> {
  requireUuid(account_id, "account_id");
  const byId = isValidUUID(ref);
  const { rows } = await getPool().query(
    `${COMPUTERS}
      WHERE c.account_id=$1 AND c.${byId ? "computer_id" : "name"}=$2
        AND c.tombstoned_at IS NULL`,
    [account_id, byId ? ref.toLowerCase() : ref],
  );
  if (rows[0] == null) throw new ComputerError(`no computer '${ref}'`);
  return summary(rows[0]);
}

/** An agent acting on a computer: it must be an active member of its network. */
export interface ActingAgent {
  agent_id: string;
  project_id: string;
}

/**
 * Run fn on the computer's row under FOR UPDATE, in one transaction, behind
 * the account-rehome fence. For an agent, the transaction also locks agent
 * messaging controls and the network (the same order as ticket issuance and
 * every narrowing path) and rechecks active membership, so removing the agent
 * or pausing can't race the change.
 */
async function withComputerForUpdate<T>(
  account_id: string,
  computer_id: string,
  fn: (client: PoolClient, row: any) => Promise<T>,
  agent?: ActingAgent,
): Promise<T> {
  requireUuid(account_id, "account_id");
  requireUuid(computer_id, "computer_id");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await assertComputersAuthority(client, account_id, "change a computer");
    if (agent != null) {
      requireUuid(agent.agent_id, "agent_id");
      requireUuid(agent.project_id, "project_id");
      const network = (
        await client.query(
          `SELECT agent_network_id FROM account_computers
            WHERE account_id=$1 AND computer_id=$2 AND tombstoned_at IS NULL`,
          [account_id, computer_id],
        )
      ).rows[0]?.agent_network_id;
      if (network == null) throw new ComputerError("no such computer");
      const { paused } = await lockAgentControls(client, account_id);
      if (paused) {
        throw new ComputerError("agent messaging is paused for this account");
      }
      const member = await client.query(
        `SELECT 1 FROM agent_networks n
           JOIN agent_network_members m ON m.agent_network_id = n.agent_network_id
          WHERE n.agent_network_id=$1 AND n.account_id=$2 AND n.state='active'
            AND m.member_kind='registered' AND m.removed_at IS NULL
            AND m.registered_agent_id=$3 AND m.project_id=$4
          FOR SHARE OF n`,
        [network, account_id, agent.agent_id, agent.project_id],
      );
      if (member.rows.length === 0) {
        throw new ComputerError("no such computer for this agent");
      }
    }
    const { rows } = await client.query(
      `SELECT * FROM account_computers
        WHERE account_id=$1 AND computer_id=$2 AND tombstoned_at IS NULL
        FOR UPDATE`,
      [account_id, computer_id],
    );
    if (rows[0] == null) throw new ComputerError("no such computer");
    const result = await fn(client, rows[0]);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Disconnect, for good: no new tickets, the bumped epoch makes daemons
 * refuse old ones, and the computer's state says "ended", which stops every
 * job on it (now, or when it next asks to log in).
 */
export async function revokeComputer({
  account_id,
  computer_id,
}: {
  account_id: string;
  computer_id: string;
  now?: number;
}): Promise<{ epoch: number }> {
  const result = await withComputerForUpdate(
    account_id,
    computer_id,
    async (client, row) => {
      if (row.revoked_at != null && row.ended_reason != null) {
        return { epoch: Number(row.epoch) };
      }
      await endComputers(client, [computer_id], "revoked");
      const { rows } = await client.query(
        "SELECT epoch FROM account_computers WHERE computer_id=$1",
        [computer_id],
      );
      return { epoch: Number(rows[0].epoch) };
    },
  );
  void kickComputerStateDelivery();
  return result;
}

export async function renameComputer({
  account_id,
  computer_id,
  name,
  now = Date.now(),
}: {
  account_id: string;
  computer_id: string;
  name: string;
  now?: number;
}): Promise<void> {
  const alias = computerName(name);
  await withComputerForUpdate(account_id, computer_id, async (client) => {
    const taken = await client.query(
      `SELECT 1 FROM account_computers
        WHERE account_id=$1 AND name=$2 AND computer_id<>$3 AND tombstoned_at IS NULL`,
      [account_id, alias, computer_id],
    );
    if (taken.rows.length > 0) {
      throw new ComputerError(`a computer named ${alias} already exists`);
    }
    await client.query(
      `UPDATE account_computers SET name=$2, updated_at=$3 WHERE computer_id=$1`,
      [computer_id, alias, new Date(now)],
    );
  });
}

export type NotesAuthor =
  | { kind: "owner"; account_id: string }
  | { kind: "agent"; agent_id: string; project_id: string };

/**
 * Edit the notes. Agents can't edit locked notes; every edit is attributed
 * and the last 20 versions are kept. Compare-and-swap on the revision.
 */
export async function setComputerNotes({
  account_id,
  computer_id,
  author,
  notes,
  expected_revision,
  locked,
  now = Date.now(),
}: {
  account_id: string;
  computer_id: string;
  author: NotesAuthor;
  notes: string;
  expected_revision: number;
  locked?: boolean;
  now?: number;
}): Promise<{ notes_revision: number }> {
  if (
    typeof notes !== "string" ||
    Buffer.byteLength(notes, "utf8") > MAX_NOTES_BYTES
  ) {
    throw new ComputerError(`notes are at most ${MAX_NOTES_BYTES} bytes`);
  }
  if (locked != null && author.kind !== "owner") {
    throw new ComputerError("only the owner can lock or unlock notes");
  }
  return await withComputerForUpdate(
    account_id,
    computer_id,
    async (client, row) => {
      if (row.notes_locked && author.kind !== "owner") {
        throw new ComputerError("the owner locked these notes");
      }
      if (Number(row.notes_revision) !== expected_revision) {
        throw new ComputerError("the notes changed; read them again");
      }
      // The history is the list of versions, newest first, each with its author.
      const revision = Number(row.notes_revision) + 1;
      const history = [
        { revision, notes, author, at: new Date(now).toISOString() },
        ...(Array.isArray(row.notes_history) ? row.notes_history : []),
      ].slice(0, NOTES_HISTORY);
      const { rows } = await client.query(
        `UPDATE account_computers
          SET notes=$2, notes_revision=notes_revision+1, notes_history=$3,
              notes_locked=COALESCE($4, notes_locked), updated_at=$5
        WHERE computer_id=$1 RETURNING notes_revision`,
        [
          computer_id,
          notes,
          JSON.stringify(history),
          locked ?? null,
          new Date(now),
        ],
      );
      return { notes_revision: Number(rows[0].notes_revision) };
    },
    author.kind === "agent"
      ? { agent_id: author.agent_id, project_id: author.project_id }
      : undefined,
  );
}

/** Move the deadline later, within max_deadline (fresh auth at the RPC layer). */
export async function extendComputer({
  account_id,
  computer_id,
  seconds,
  now = Date.now(),
}: {
  account_id: string;
  computer_id: string;
  seconds: number;
  now?: number;
}): Promise<{ deadline: number }> {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new ComputerError("seconds must be a positive integer");
  }
  return await withComputerForUpdate(
    account_id,
    computer_id,
    async (client, row) => {
      if (row.revoked_at != null)
        throw new ComputerError("this computer is disconnected");
      if (row.deadline == null)
        throw new ComputerError("this computer has no time limit");
      const current = new Date(row.deadline).valueOf();
      if (current <= now) throw new ComputerError("this session already ended");
      const max = new Date(row.max_deadline).valueOf();
      const deadline = Math.min(max, current + seconds * 1000);
      await client.query(
        `UPDATE account_computers SET deadline=$2, updated_at=$3 WHERE computer_id=$1`,
        [computer_id, new Date(deadline), new Date(now)],
      );
      return { deadline };
    },
  );
}

/**
 * Narrow the effective policy: never widen. It must be at most the current
 * effective policy and at most the ceiling, field by field (the daemon
 * checks the same itself). Widening back needs a new pairing. The new
 * policy reaches daemons in the signed state snapshot; queued work
 * authorized under the old policy epoch is cancelled there.
 */
export async function setEffectivePolicy({
  account_id,
  computer_id,
  policy,
  now = Date.now(),
}: {
  account_id: string;
  computer_id: string;
  policy: unknown;
  now?: number;
}): Promise<{ policy_epoch: number }> {
  const effective = parseComputerPolicy(policy);
  const result = await withComputerForUpdate(
    account_id,
    computer_id,
    async (client, row) => {
      const ceiling = parseComputerPolicy(row.policy_ceiling);
      const current = parseComputerPolicy(row.effective_policy);
      const reasons = [
        ...policyWideningReasons(effective, current),
        ...policyWideningReasons(effective, ceiling),
      ];
      if (reasons.length > 0) {
        throw new ComputerError(
          `that would widen the approved policy: ${reasons.join("; ")}`,
        );
      }
      const { rows } = await client.query(
        `UPDATE account_computers
          SET effective_policy=$2, policy_epoch=policy_epoch+1, updated_at=$3
        WHERE computer_id=$1 RETURNING policy_epoch`,
        [computer_id, JSON.stringify(effective), new Date(now)],
      );
      await bumpComputerState(client, [computer_id]);
      return { policy_epoch: Number(rows[0].policy_epoch) };
    },
  );
  void kickComputerStateDelivery();
  return result;
}

/** Anything with a query method: a pool client inside a transaction. */
export interface Queryable {
  query(sql: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

/**
 * The agent network narrowed (a member removed, paused or closed): bump the
 * epoch and state of every computer serving it, in the caller's
 * transaction, so tickets issued before no longer start and queued work is
 * cancelled when the daemon applies the new floor (delivery picks it up
 * after the commit). Returns the computers to notify.
 */
export async function bumpComputersForNetwork(
  client: Queryable,
  account_id: string,
  agent_network_id: string,
): Promise<string[]> {
  const { rows } = await client.query(
    `UPDATE account_computers SET epoch=epoch+1, updated_at=now()
      WHERE account_id=$1 AND agent_network_id=$2
        AND revoked_at IS NULL AND tombstoned_at IS NULL
      RETURNING computer_id`,
    [account_id, agent_network_id],
  );
  const ids = rows.map((r) => r.computer_id);
  await bumpComputerState(client, ids);
  return ids;
}

/**
 * Does any computer (not revoked) or open pairing request serve this
 * network? Then adding a member or resuming the network gives agents access
 * to that computer, so it needs fresh auth (plan decision 22). Call with the
 * network row locked FOR UPDATE: approval and request creation lock it too.
 */
export async function networkHasComputerAccess(
  client: Queryable,
  account_id: string,
  agent_network_id: string,
): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM account_computers
      WHERE account_id=$1 AND agent_network_id=$2
        AND revoked_at IS NULL AND tombstoned_at IS NULL
     UNION ALL
     SELECT 1 FROM account_computer_requests
      WHERE account_id=$1 AND agent_network_id=$2
        AND state IN ('pending','paired') AND expires_at > now()
     LIMIT 1`,
    [account_id, agent_network_id],
  );
  return rows.length > 0;
}

/** Agent messaging was paused or every network closed: all of them. */
export async function bumpComputersForAccount(
  client: Queryable,
  account_id: string,
): Promise<string[]> {
  const { rows } = await client.query(
    `UPDATE account_computers SET epoch=epoch+1, updated_at=now()
      WHERE account_id=$1 AND revoked_at IS NULL AND tombstoned_at IS NULL
      RETURNING computer_id`,
    [account_id],
  );
  const ids = rows.map((r) => r.computer_id);
  await bumpComputerState(client, ids);
  return ids;
}

/**
 * The account is being deleted: end every computer of it, in the deletion's
 * own fenced transaction (before deleted=true), so each daemon stops its
 * jobs now or at its next login attempt.
 */
export async function endComputersForAccountDeletion(
  client: Queryable,
  account_id: string,
): Promise<void> {
  const { rows } = await client.query(
    `SELECT computer_id FROM account_computers
      WHERE account_id=$1 AND ended_reason IS NULL
      ORDER BY computer_id FOR UPDATE`,
    [account_id],
  );
  await endComputers(
    client,
    rows.map((r) => r.computer_id),
    "deleted",
  );
}

function requireUuid(value: unknown, where: string): string {
  if (typeof value !== "string" || !isValidUUID(value)) {
    throw new ComputerError(`${where} must be a UUID`);
  }
  return value;
}
