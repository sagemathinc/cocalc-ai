/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The federated connector turn, on the account's home bay (G4 design v3,
contract v7 section A):

- beginFederatedTurn: a project host asks, at the start of an agent turn and
  every renewal, for the turn's gcloud credential. The answer is exactly
  { entries, revoked }. The host's authority is checked first (trusted
  source, active run, live turn); a failure is an error, never an empty
  answer. The binding of a turn to a lease, grant and approval comes only
  from the hub's own records, never from the host.
- endFederatedTurn: the host ends the turn's lease (reason expired).
- verifyFederatedLiveTurn: the broker's recheck before every mint.
- reconcileFederatedLeases: ends the leases of runs that are no longer
  active (crashed hosts); age only picks which leases to check.

Each turn has one durable lease record (federated_connector_turn_leases): an
ended record is the turn's revocation tombstone, returned on every later
call. Errors are fixed codes, without ids or provider text.
*/

import { createHash, randomUUID } from "node:crypto";
import getPool, { type PoolClient } from "@cocalc/database/pool";
import {
  canonicalJson,
  parseGcloudTurnToken,
  type GcloudLeaseEndReason,
  type GcloudLeaseEnded,
  type GcloudTurnToken,
} from "@cocalc/util/ai/federated-connectors";
import { isValidUUID } from "@cocalc/util/misc";
import type { FederationProjectSnapshot } from "./approvals";
import type { MintRequest, MintResult } from "./broker";

export const FEDERATED_TURN_REFUSED = "federated_turn_refused";
export const FEDERATED_CONNECTORS_DISABLED = "federated_connectors_disabled";
export const FEDERATED_CONNECTOR_UNAVAILABLE =
  "federated_connector_unavailable";

/** A fixed-code error: the message is the code, nothing else. */
export class FederatedTurnError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const LEASES = "federated_connector_turn_leases";
const ASSIGNMENTS = "federated_connector_agent_grants";

export interface FederatedTurnRef {
  chat_path: string;
  message_date: string;
  message_id: string;
  thread_id: string;
}

export interface FederatedTurnRequest {
  account_id: string;
  /** From the authenticated host principal only. */
  host_id: string;
  agent_id: string;
  source_project_id: string;
  run_id: string;
  turn_ref: FederatedTurnRef;
}

export interface FederatedTurnAnswer {
  entries: GcloudTurnToken[];
  revoked: GcloudLeaseEnded[];
}

export interface FederatedTurnDeps {
  assertTrustedSource(opts: {
    account_id: string;
    host_id: string;
    source_project_id: string;
  }): Promise<void>;
  verifyActiveAgentRun(opts: {
    account_id: string;
    agent_id: string;
    project_id: string;
    run_id: string;
  }): Promise<unknown>;
  assertLiveTurn(opts: {
    account_id: string;
    host_id: string;
    source_project_id: string;
    agent_id: string;
    turn: FederatedTurnRef;
  }): Promise<void>;
  /** The site gate lists gcloud and the broker is configured. */
  gateOpen(): Promise<boolean>;
  /** The owning bay's project snapshot (bounded; throws on any failure). */
  snapshot(opts: {
    project_id: string;
    account_id: string;
  }): Promise<FederationProjectSnapshot>;
  getToken(request: MintRequest): Promise<MintResult>;
  site_id: string;
}

const REQUEST_KEYS = [
  "account_id",
  "host_id",
  "agent_id",
  "source_project_id",
  "run_id",
  "turn_ref",
];
const TURN_REF_KEYS = ["chat_path", "message_date", "message_id", "thread_id"];

function exactKeys(value: unknown, keys: string[]): value is object {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => own.includes(k));
}

/**
 * The request, exactly: unknown keys (a lease id, grant, revision, sensor
 * run, ...) are refused, never ignored.
 */
export function parseFederatedTurnRequest(
  value: unknown,
): FederatedTurnRequest {
  if (!exactKeys(value, REQUEST_KEYS)) {
    throw new FederatedTurnError(FEDERATED_TURN_REFUSED);
  }
  const req = value as Record<string, any>;
  for (const key of [
    "account_id",
    "host_id",
    "agent_id",
    "source_project_id",
    "run_id",
  ]) {
    if (typeof req[key] !== "string" || !isValidUUID(req[key])) {
      throw new FederatedTurnError(FEDERATED_TURN_REFUSED);
    }
  }
  if (!exactKeys(req.turn_ref, TURN_REF_KEYS)) {
    throw new FederatedTurnError(FEDERATED_TURN_REFUSED);
  }
  for (const key of TURN_REF_KEYS) {
    const v = req.turn_ref[key];
    if (typeof v !== "string" || !v.trim() || v.length > 4096) {
      throw new FederatedTurnError(FEDERATED_TURN_REFUSED);
    }
  }
  return req as FederatedTurnRequest;
}

/** The turn's lease key: sha256 of canonical JSON of the whole turn. */
export function federatedTurnKey(req: FederatedTurnRequest): string {
  return createHash("sha256")
    .update(
      canonicalJson([
        req.account_id,
        req.agent_id,
        req.source_project_id,
        req.run_id,
        req.turn_ref,
      ]),
    )
    .digest("hex");
}

async function checkAuthority(
  req: FederatedTurnRequest,
  deps: FederatedTurnDeps,
  liveTurn = true,
): Promise<void> {
  try {
    await deps.assertTrustedSource({
      account_id: req.account_id,
      host_id: req.host_id,
      source_project_id: req.source_project_id,
    });
    await deps.verifyActiveAgentRun({
      account_id: req.account_id,
      agent_id: req.agent_id,
      project_id: req.source_project_id,
      run_id: req.run_id,
    });
    if (liveTurn) {
      await deps.assertLiveTurn({
        account_id: req.account_id,
        host_id: req.host_id,
        source_project_id: req.source_project_id,
        agent_id: req.agent_id,
        turn: req.turn_ref,
      });
    }
  } catch {
    throw new FederatedTurnError(FEDERATED_TURN_REFUSED);
  }
}

/**
 * The approval the turn may rely on: null for a single-user project, the
 * approval id for an approved shared one, or undefined (denied) when the
 * account is no longer a full collaborator or the project is shared without
 * a valid approval.
 */
function effectiveApproval(
  snapshot: FederationProjectSnapshot,
): string | null | undefined {
  // The account must still be a full collaborator, on the owning bay's own
  // record (it may have been removed or demoted since the authority check).
  if (
    snapshot.account_role !== "owner" &&
    snapshot.account_role !== "collaborator"
  ) {
    return undefined;
  }
  const shared = snapshot.other_members > 0 || snapshot.pending_invites > 0;
  if (!shared) return null;
  return snapshot.approval_id ?? undefined;
}

interface LeaseRow {
  lease_id: string;
  host_id: string;
  assignment_id: string;
  assignment_revision: number;
  grant_id: string;
  grant_revision: number;
  approval_id: string | null;
  ended_at: Date | null;
  end_reason: GcloudLeaseEndReason | null;
}

interface AssignmentRow {
  assignment_id: string;
  grant_id: string;
  enabled: boolean;
  revision: number;
}

const tombstone = (lease: {
  lease_id: string;
  end_reason: GcloudLeaseEndReason | null;
}): FederatedTurnAnswer => ({
  entries: [],
  revoked: [{ lease_id: lease.lease_id, reason: lease.end_reason ?? "deny" }],
});
const EMPTY = (): FederatedTurnAnswer => ({ entries: [], revoked: [] });

async function endLease(
  db: Pick<PoolClient, "query">,
  lease_id: string,
  reason: GcloudLeaseEndReason,
): Promise<{ lease_id: string; end_reason: GcloudLeaseEndReason }> {
  // Ends it only if open; an already ended lease keeps its first reason.
  await db.query(
    `UPDATE ${LEASES} SET ended_at=clock_timestamp(), end_reason=$2
      WHERE lease_id=$1 AND ended_at IS NULL`,
    [lease_id, reason],
  );
  const { rows } = await db.query<{ end_reason: GcloudLeaseEndReason }>(
    `SELECT end_reason FROM ${LEASES} WHERE lease_id=$1`,
    [lease_id],
  );
  return { lease_id, end_reason: rows[0]?.end_reason ?? reason };
}

async function loadLease(
  client: PoolClient,
  req: FederatedTurnRequest,
  turn_key: string,
): Promise<LeaseRow | undefined> {
  const { rows } = await client.query<LeaseRow>(
    `SELECT lease_id, host_id, assignment_id, assignment_revision, grant_id,
            grant_revision, approval_id, ended_at, end_reason
       FROM ${LEASES}
      WHERE account_id=$1 AND agent_id=$2 AND source_project_id=$3
        AND run_id=$4 AND turn_key=$5
      FOR UPDATE`,
    [req.account_id, req.agent_id, req.source_project_id, req.run_id, turn_key],
  );
  return rows[0];
}

type Decision =
  | { kind: "answer"; answer: FederatedTurnAnswer }
  | { kind: "mint"; lease: LeaseRow };

/**
 * Steps 2-7 of the per-call algorithm, in one transaction holding the
 * turn's lock: load, check the binding, create the lease at most once.
 */
async function decide(
  req: FederatedTurnRequest,
  turn_key: string,
  approval: string | null | undefined,
): Promise<Decision> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 7173))",
      [turn_key],
    );
    const decision = await decideLocked(client, req, turn_key, approval);
    await client.query("COMMIT");
    return decision;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function decideLocked(
  client: PoolClient,
  req: FederatedTurnRequest,
  turn_key: string,
  approval: string | null | undefined,
): Promise<Decision> {
  const lease = await loadLease(client, req, turn_key);
  if (lease?.ended_at != null) {
    return { kind: "answer", answer: tombstone(lease) };
  }
  if (lease != null && lease.host_id !== req.host_id) {
    // Another host's turn: refuse, and leave the legitimate lease alone.
    throw new FederatedTurnError(FEDERATED_TURN_REFUSED);
  }
  const { rows } = await client.query<AssignmentRow>(
    `SELECT assignment_id, grant_id, enabled, revision FROM ${ASSIGNMENTS}
      WHERE account_id=$1 AND agent_id=$2 AND source_project_id=$3
      FOR SHARE`,
    [req.account_id, req.agent_id, req.source_project_id],
  );
  const assignment = rows[0];
  if (lease == null) {
    if (assignment == null || !assignment.enabled || approval === undefined) {
      return { kind: "answer", answer: EMPTY() };
    }
    const { rows: grants } = await client.query<{ revision: number }>(
      `SELECT revision FROM federated_connector_grants
        WHERE grant_id=$1 AND account_id=$2 AND state='enabled'
        FOR SHARE`,
      [assignment.grant_id, req.account_id],
    );
    if (!grants[0]) return { kind: "answer", answer: EMPTY() };
    const { rows: created } = await client.query<LeaseRow>(
      `INSERT INTO ${LEASES}
         (lease_id, account_id, agent_id, source_project_id, run_id, turn_key,
          turn_ref, host_id, assignment_id, assignment_revision, grant_id,
          grant_revision, approval_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING lease_id, host_id, assignment_id, assignment_revision,
                 grant_id, grant_revision, approval_id, ended_at, end_reason`,
      [
        randomUUID(),
        req.account_id,
        req.agent_id,
        req.source_project_id,
        req.run_id,
        turn_key,
        req.turn_ref,
        req.host_id,
        assignment.assignment_id,
        assignment.revision,
        assignment.grant_id,
        grants[0].revision,
        approval,
      ],
    );
    return { kind: "mint", lease: created[0] };
  }
  if (
    assignment == null ||
    !assignment.enabled ||
    assignment.assignment_id !== lease.assignment_id ||
    assignment.revision !== lease.assignment_revision ||
    assignment.grant_id !== lease.grant_id
  ) {
    return {
      kind: "answer",
      answer: tombstone(await endLease(client, lease.lease_id, "revision")),
    };
  }
  if (approval === undefined || approval !== lease.approval_id) {
    return {
      kind: "answer",
      answer: tombstone(await endLease(client, lease.lease_id, "deny")),
    };
  }
  return { kind: "mint", lease };
}

function entryFor(
  result: Extract<MintResult, { status: "issued" }>,
  lease: LeaseRow,
): GcloudTurnToken | undefined {
  return parseGcloudTurnToken({
    connector: "gcloud",
    token: result.token,
    expires_at: result.expires_at,
    description: `gcloud as ${result.sa_label} in ${result.project}`,
    gcloud: {
      provider_expires_at: result.expires_at,
      lease_max_expires_at: null,
      status: "active",
      project: result.project,
      sa_label: result.sa_label,
      lease_id: lease.lease_id,
      connection_id: result.connection_id,
      grant_revision: lease.grant_revision,
    },
  });
}

export async function beginFederatedTurn(
  input: unknown,
  deps: FederatedTurnDeps,
): Promise<FederatedTurnAnswer> {
  const req = parseFederatedTurnRequest(input);
  await checkAuthority(req, deps);
  let open: boolean;
  try {
    open = await deps.gateOpen();
  } catch {
    throw new FederatedTurnError(FEDERATED_CONNECTOR_UNAVAILABLE);
  }
  if (!open) throw new FederatedTurnError(FEDERATED_CONNECTORS_DISABLED);
  let approval: string | null | undefined;
  try {
    approval = effectiveApproval(
      await deps.snapshot({
        project_id: req.source_project_id,
        account_id: req.account_id,
      }),
    );
  } catch {
    throw new FederatedTurnError(FEDERATED_CONNECTOR_UNAVAILABLE);
  }
  const turn_key = federatedTurnKey(req);
  let decision: Decision;
  try {
    decision = await decide(req, turn_key, approval);
  } catch (err) {
    if (err instanceof FederatedTurnError) throw err;
    // A concurrent first call (another bay's lock) won the insert: its
    // lease is this turn's lease.
    if (`${(err as any)?.code}` === "23505") {
      try {
        decision = await decide(req, turn_key, approval);
      } catch (err2) {
        if (err2 instanceof FederatedTurnError) throw err2;
        throw new FederatedTurnError(FEDERATED_CONNECTOR_UNAVAILABLE);
      }
    } else {
      throw new FederatedTurnError(FEDERATED_CONNECTOR_UNAVAILABLE);
    }
  }
  if (decision.kind === "answer") return decision.answer;

  // Outside the lock and after commit: the broker call.
  const lease = decision.lease;
  let result: MintResult;
  try {
    result = await deps.getToken({
      site_id: deps.site_id,
      account_id: req.account_id,
      agent_id: req.agent_id,
      project_id: req.source_project_id,
      host_id: req.host_id,
      run_id: req.run_id,
      grant_id: lease.grant_id,
      lease_id: lease.lease_id,
      grant_revision: lease.grant_revision,
    });
  } catch {
    throw new FederatedTurnError(FEDERATED_CONNECTOR_UNAVAILABLE);
  }
  if (result.status === "issued") {
    const entry = entryFor(result, lease);
    if (entry == null) {
      throw new FederatedTurnError(FEDERATED_CONNECTOR_UNAVAILABLE);
    }
    return { entries: [entry], revoked: [] };
  }
  if (result.status === "denied") {
    try {
      return tombstone(
        await endLease(
          getPool(),
          lease.lease_id,
          result.reason === "revision" ? "revision" : "deny",
        ),
      );
    } catch {
      throw new FederatedTurnError(FEDERATED_CONNECTOR_UNAVAILABLE);
    }
  }
  // Transient: the lease stays open, so a later renewal may succeed.
  throw new FederatedTurnError(FEDERATED_CONNECTOR_UNAVAILABLE);
}

/**
 * Ends the turn's lease (reason expired) at the end of the turn. Idempotent;
 * another host can't end it.
 */
export async function endFederatedTurn(
  input: unknown,
  deps: Pick<FederatedTurnDeps, "assertTrustedSource">,
): Promise<Record<string, never>> {
  const req = parseFederatedTurnRequest(input);
  try {
    await deps.assertTrustedSource({
      account_id: req.account_id,
      host_id: req.host_id,
      source_project_id: req.source_project_id,
    });
  } catch {
    throw new FederatedTurnError(FEDERATED_TURN_REFUSED);
  }
  const turn_key = federatedTurnKey(req);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 7173))",
      [turn_key],
    );
    const lease = await loadLease(client, req, turn_key);
    if (lease != null && lease.host_id !== req.host_id) {
      throw new FederatedTurnError(FEDERATED_TURN_REFUSED);
    }
    if (lease != null && lease.ended_at == null) {
      await endLease(client, lease.lease_id, "expired");
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (err instanceof FederatedTurnError) throw err;
    throw new FederatedTurnError(FEDERATED_CONNECTOR_UNAVAILABLE);
  } finally {
    client.release();
  }
  return {};
}

/**
 * The broker's check before every mint, cache hits included: the request is
 * exactly an open lease, the host's authority and the turn still hold, the
 * gate is open, the assignment is the one the lease was bound to, and the
 * owning bay's snapshot still allows the lease's approval. Throws otherwise
 * (the broker refuses with turn_not_live); never ends the lease itself.
 */
export async function verifyFederatedLiveTurn(
  request: MintRequest,
  deps: Omit<FederatedTurnDeps, "getToken" | "site_id">,
): Promise<void> {
  const fail = (): never => {
    throw Error("turn_not_live");
  };
  if (!isValidUUID(request?.lease_id)) fail();
  const { rows } = await getPool().query<
    LeaseRow & {
      account_id: string;
      agent_id: string;
      source_project_id: string;
      run_id: string;
      turn_ref: FederatedTurnRef;
    }
  >(`SELECT * FROM ${LEASES} WHERE lease_id=$1`, [request.lease_id]);
  const lease = rows[0];
  if (
    lease == null ||
    lease.ended_at != null ||
    lease.account_id !== request.account_id ||
    lease.agent_id !== request.agent_id ||
    lease.source_project_id !== request.project_id ||
    lease.host_id !== request.host_id ||
    lease.run_id !== request.run_id ||
    lease.grant_id !== request.grant_id ||
    lease.grant_revision !== request.grant_revision
  ) {
    fail();
  }
  const req: FederatedTurnRequest = {
    account_id: lease.account_id,
    host_id: lease.host_id,
    agent_id: lease.agent_id,
    source_project_id: lease.source_project_id,
    run_id: lease.run_id,
    turn_ref: lease.turn_ref,
  };
  try {
    await checkAuthority(req, deps as FederatedTurnDeps);
    if (!(await deps.gateOpen())) fail();
    const { rows: assignments } = await getPool().query<AssignmentRow>(
      `SELECT assignment_id, grant_id, enabled, revision FROM ${ASSIGNMENTS}
        WHERE account_id=$1 AND agent_id=$2 AND source_project_id=$3`,
      [lease.account_id, lease.agent_id, lease.source_project_id],
    );
    const a = assignments[0];
    if (
      a == null ||
      !a.enabled ||
      a.assignment_id !== lease.assignment_id ||
      a.revision !== lease.assignment_revision ||
      a.grant_id !== lease.grant_id
    ) {
      fail();
    }
    const approval = effectiveApproval(
      await deps.snapshot({
        project_id: lease.source_project_id,
        account_id: lease.account_id,
      }),
    );
    if (approval === undefined || approval !== lease.approval_id) fail();
  } catch {
    fail();
  }
}

/** Whether a lease's run is still active, from the authoritative record. */
export type FederatedRunActivity = "active" | "ended" | "unknown";

/**
 * Where the next reconciliation pass continues (keyset order). created_at is
 * the database's own text form, so the key keeps microseconds (a JS Date
 * would round to milliseconds and could stall the cursor).
 */
export interface FederatedLeaseCursor {
  created_at: string;
  lease_id: string;
}

/**
 * Ends (reason expired) open leases whose run the authority reports ended.
 * Age only picks candidates; an unknown answer (unreachable, timeout, any
 * error) leaves the lease open for the next pass. Candidates are taken in
 * (created_at, lease_id) order after `after`; `next` is where the following
 * pass continues, or undefined to start over from the oldest.
 */
export async function reconcileFederatedLeases({
  runActivity,
  olderThanMs = 60 * 60 * 1000,
  limit = 500,
  after,
}: {
  runActivity(lease: {
    account_id: string;
    agent_id: string;
    project_id: string;
    run_id: string;
  }): Promise<FederatedRunActivity>;
  olderThanMs?: number;
  limit?: number;
  after?: FederatedLeaseCursor;
}): Promise<{
  checked: number;
  ended: number;
  next?: FederatedLeaseCursor;
}> {
  const { rows } = await getPool().query<{
    lease_id: string;
    account_id: string;
    agent_id: string;
    source_project_id: string;
    run_id: string;
    created_key: string;
  }>(
    `SELECT lease_id, account_id, agent_id, source_project_id, run_id,
            created_at::text AS created_key
       FROM ${LEASES}
      WHERE ended_at IS NULL
        AND created_at < NOW() - ($1::double precision * INTERVAL '1 millisecond')
        AND ($3::text IS NULL
             OR (created_at, lease_id) > ($3::timestamptz, $4::uuid))
      ORDER BY created_at, lease_id
      LIMIT $2`,
    [olderThanMs, limit, after?.created_at ?? null, after?.lease_id ?? null],
  );
  let ended = 0;
  for (const lease of rows) {
    let activity: FederatedRunActivity;
    try {
      activity = await runActivity({
        account_id: lease.account_id,
        agent_id: lease.agent_id,
        project_id: lease.source_project_id,
        run_id: lease.run_id,
      });
    } catch {
      activity = "unknown";
    }
    if (activity === "ended") {
      await endLease(getPool(), lease.lease_id, "expired");
      ended += 1;
    }
  }
  const last = rows.at(-1);
  return {
    checked: rows.length,
    ended,
    next:
      rows.length < limit || last == null
        ? undefined
        : { created_at: last.created_key, lease_id: last.lease_id },
  };
}

/**
 * Health (count only): open leases older than this many days. Non-zero means
 * reconciliation isn't ending them (an authority that never answers), and
 * they would never reach the retention purge.
 */
export async function countStaleOpenFederatedLeases(
  olderThanDays = 7,
): Promise<number> {
  const { rows } = await getPool().query<{ count: string }>(
    `SELECT count(*) FROM ${LEASES}
      WHERE ended_at IS NULL
        AND created_at < NOW() - ($1::double precision * INTERVAL '1 day')`,
    [olderThanDays],
  );
  return Number(rows[0]?.count ?? 0);
}
