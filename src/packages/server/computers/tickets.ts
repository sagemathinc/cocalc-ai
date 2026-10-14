/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Issue a ticket: permission for one operation on one computer. Runs at the
// account's home bay. Plan: src/.agents/computers-plan-2026-10-11.md
// ("Control path", "The ticket", "Operation ledger and retries").
//
// In ONE transaction, holding FOR SHARE on the account's agent messaging
// controls, the agent network and the computer (revoke, pause, narrowing and
// membership removal lock them for update and bump epochs), the hub checks
// everything, records the operation, and only then
// releases the signed ticket. A retry with the same operation_id and request
// gets a new ticket for the same operation, never a second operation; a
// different request under the same operation_id is refused.

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { isValidUUID } from "@cocalc/util/misc";
import {
  maxRuntimeMs,
  commandText,
  parseOperationRequest,
  type OperationRequest,
} from "@cocalc/util/computers/operations";
import {
  DEFAULT_AGENT_CONCURRENCY,
  OPERATION_KINDS,
  parseComputerTicket,
  parseProjectAttestation,
  parseSignedEnvelope,
  SIGNED_KINDS,
  type ComputerTicket,
  type OperationKind,
  type ProjectAttestation,
  type SignedEnvelope,
} from "@cocalc/util/computers/protocol";
import {
  requestHash,
  signEnvelope,
  signingPublicKeyFromDer,
  verifyEnvelope,
} from "@cocalc/backend/computers/crypto";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterId } from "@cocalc/server/cluster-config";
import {
  getBaySigningKey,
  keyMap,
  listSigningKeyDirectory,
} from "./signing-keys";
import { computersSite } from "./site";
import { assertComputersAuthority, lockAgentControls } from "./authority";
import { resolveProjectBay } from "@cocalc/server/inter-bay/directory";
import { ActiveProjectsError, admitActiveProject, SKEW_MS } from "./recheck";

/** Tickets start within this long of issue (and never after the attestation). */
export const TICKET_START_WINDOW_MS = 60 * 1000;
/** Rate limits: tickets per agent run, and per computer, per minute. */
export const MAX_TICKETS_PER_RUN_PER_MINUTE = 120;
export const MAX_TICKETS_PER_COMPUTER_PER_MINUTE = 600;

// "unknown" is an outcome too: the operation may have run, so it is never
// ticketed again ("we never guess").
const TERMINAL_STATES = new Set(["done", "failed", "refused", "unknown"]);
const TICKET_LOG_RETENTION_MS = 60 * 60 * 1000;
/** How far ahead of the hub's clock an attestation may be dated. */
const ATTESTATION_SKEW_MS = 5_000;

export class TicketError extends Error {}

export interface TicketRequest {
  /** From the authenticated agent run, never from the request body. */
  account_id: string;
  agent_id: string;
  run_id: string;
  source_project_id: string;
  run_expires_at: number;
  thread_id?: string | null;
  /** The computer's alias or id. */
  computer: string;
  operation: OperationKind;
  request: unknown;
  operation_id: string;
  /** base64url DER of the requester's per-request Ed25519 key. */
  pop_key: string;
  /** The project bay's signed eligibility attestation. */
  attestation: unknown;
  now?: number;
}

export type TicketResult =
  | { ticket: SignedEnvelope<ComputerTicket>; operation: OperationRequest }
  /** The operation already finished; its recorded outcome, no new ticket. */
  | { finished: { state: string; exit_code: number | null } };

export async function issueComputerTicket(
  input: TicketRequest,
): Promise<TicketResult> {
  const now = input.now ?? Date.now();
  for (const key of [
    "account_id",
    "agent_id",
    "run_id",
    "source_project_id",
    "operation_id",
  ] as const) {
    if (!isValidUUID(input[key]))
      throw new TicketError(`${key} must be a UUID`);
  }
  if (
    !(OPERATION_KINDS as readonly string[]).includes(input.operation) ||
    input.operation === "notes"
  ) {
    throw new TicketError(`unknown operation '${input.operation}'`);
  }
  if (!(input.run_expires_at > now))
    throw new TicketError("the agent run has expired");
  try {
    signingPublicKeyFromDer(input.pop_key);
  } catch {
    throw new TicketError("pop_key must be an Ed25519 public key");
  }
  const operation = parseOperationRequest(input.operation, input.request);
  const request_hash = requestHash(operation);
  const attestation = await checkAttestation(input, now);

  // Keys first: nothing that queries outside the transaction runs inside it.
  const signer = await getBaySigningKey();
  const site = await computersSite();

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Lock order matches every narrowing path: the account-rehome fence,
    // then agent messaging controls, the network, and the computer. So a
    // narrowing either sees this operation recorded, or this issue sees the
    // narrowing.
    await assertComputersAuthority(client, input.account_id, "issue a ticket");
    const byId = isValidUUID(input.computer);
    const found = (
      await client.query(
        `SELECT computer_id, agent_network_id FROM account_computers
          WHERE account_id=$1 AND ${byId ? "computer_id" : "name"}=$2
            AND tombstoned_at IS NULL`,
        [
          input.account_id,
          byId ? input.computer.toLowerCase() : input.computer,
        ],
      )
    ).rows[0];
    if (found == null) throw new TicketError(`no computer '${input.computer}'`);

    // The row is created if missing, so a first-ever pause can't slip past.
    const { paused } = await lockAgentControls(client, input.account_id);
    if (paused) {
      throw new TicketError("agent messaging is paused for this account");
    }

    // The agent must be a registered member of the computer's network, in
    // this very project, and the network must be active.
    const member = await client.query(
      `SELECT 1 FROM agent_networks n
         JOIN agent_network_members m ON m.agent_network_id = n.agent_network_id
        WHERE n.agent_network_id=$1 AND n.account_id=$2 AND n.state='active'
          AND m.member_kind='registered' AND m.removed_at IS NULL
          AND m.registered_agent_id=$3 AND m.project_id=$4
        FOR SHARE OF n`,
      [
        found.agent_network_id,
        input.account_id,
        input.agent_id,
        input.source_project_id,
      ],
    );

    const computer = (
      await client.query(
        `SELECT * FROM account_computers
          WHERE computer_id=$1 AND tombstoned_at IS NULL FOR SHARE`,
        [found.computer_id],
      )
    ).rows[0];
    if (
      computer == null ||
      computer.agent_network_id !== found.agent_network_id
    )
      throw new TicketError(`no computer '${input.computer}'`);
    if (computer.revoked_at != null) {
      throw new TicketError(`${computer.name} is disconnected`);
    }
    if (
      computer.deadline != null &&
      new Date(computer.deadline).valueOf() <= now
    ) {
      throw new TicketError(`the session on ${computer.name} has ended`);
    }
    if (member.rows.length === 0) {
      throw new TicketError(
        `this agent is not in the agent network that ${computer.name} serves`,
      );
    }

    await assertTargetIsTheAgents(
      client,
      computer.computer_id,
      input,
      operation,
    );

    // Hard rate limits: every ticket counts (a retry too), serialized per
    // run and per computer.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `computer-tickets-run:${input.run_id}`,
    ]);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `computer-tickets-computer:${computer.computer_id}`,
    ]);
    const windowStart = new Date(now - 60_000);
    const limits = await client.query(
      `SELECT
         (SELECT count(*)::int FROM account_computer_ticket_log
           WHERE run_id=$1 AND issued_at > $3) AS per_run,
         (SELECT count(*)::int FROM account_computer_ticket_log
           WHERE computer_id=$2 AND issued_at > $3) AS per_computer`,
      [input.run_id, computer.computer_id, windowStart],
    );
    if (limits.rows[0].per_run >= MAX_TICKETS_PER_RUN_PER_MINUTE) {
      throw new TicketError(
        "too many operations from this agent run; slow down",
      );
    }
    if (limits.rows[0].per_computer >= MAX_TICKETS_PER_COMPUTER_PER_MINUTE) {
      throw new TicketError(
        `too many operations on ${computer.name}; slow down`,
      );
    }

    const ticket_id = randomUUID();
    const existing = await client.query(
      `SELECT * FROM account_computer_operations
        WHERE computer_id=$1 AND operation_id=$2 FOR UPDATE`,
      [computer.computer_id, input.operation_id],
    );
    const prior = existing.rows[0];
    if (prior != null) {
      // A retry is the same operation from the same requester: same agent,
      // run, project, thread, operation, request and PoP key. Anything else
      // is refused with one message, so it reveals nothing.
      if (
        prior.account_id !== input.account_id ||
        prior.agent_id !== input.agent_id ||
        prior.run_id !== input.run_id ||
        prior.source_project_id !== input.source_project_id ||
        (prior.thread_id ?? null) !== (input.thread_id ?? null) ||
        prior.operation !== operation.operation ||
        prior.request_hash !== request_hash ||
        prior.pop_key !== input.pop_key
      ) {
        throw new TicketError(
          "that operation_id was used for a different request",
        );
      }
      if (TERMINAL_STATES.has(prior.state)) {
        await client.query("COMMIT");
        return {
          finished: {
            state: prior.state,
            exit_code: prior.exit_code == null ? null : Number(prior.exit_code),
          },
        };
      }
      await client.query(
        `UPDATE account_computer_operations SET ticket_id=$3, issued_at=$4
          WHERE computer_id=$1 AND operation_id=$2`,
        [computer.computer_id, input.operation_id, ticket_id, new Date(now)],
      );
    } else {
      await client.query(
        `INSERT INTO account_computer_operations
           (computer_id, operation_id, account_id, agent_id, run_id,
            source_project_id, thread_id, operation, request_hash, command,
            description, ticket_id, pop_key, state, issued_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'issued',$14)`,
        [
          computer.computer_id,
          input.operation_id,
          input.account_id,
          input.agent_id,
          input.run_id,
          input.source_project_id,
          input.thread_id ?? null,
          operation.operation,
          request_hash,
          auditCommand(operation),
          operation.operation === "run" ? operation.request.description : null,
          ticket_id,
          input.pop_key,
          new Date(now),
        ],
      );
    }
    const start_by = Math.min(
      now + TICKET_START_WINDOW_MS,
      attestation.envelope.payload.not_after,
      input.run_expires_at,
    );
    // The project may have work there until start_by plus the operation's
    // longest life plus skew (a job: open-ended until reports exist). It is
    // re-checked at its bay meanwhile; at most 500 such projects at once.
    try {
      await admitActiveProject(client, {
        computer_id: computer.computer_id,
        account_id: input.account_id,
        project_id: input.source_project_id,
        possibly_active_until:
          operation.operation === "run"
            ? null
            : start_by + maxRuntimeMs(operation) + SKEW_MS,
        start_by,
        attesting_bay_id: attestation.envelope.payload.project_bay_id,
        now,
      });
    } catch (err) {
      if (err instanceof ActiveProjectsError) {
        throw new TicketError(err.message);
      }
      throw err;
    }
    await client.query(
      `INSERT INTO account_computer_ticket_log
         (ticket_id, account_id, computer_id, run_id, issued_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        ticket_id,
        input.account_id,
        computer.computer_id,
        input.run_id,
        new Date(now),
      ],
    );
    await client.query(
      `DELETE FROM account_computer_ticket_log
        WHERE computer_id=$1 AND issued_at < $2`,
      [computer.computer_id, new Date(now - TICKET_LOG_RETENTION_MS)],
    );

    const payload = parseComputerTicket({
      type: "cocalc-computer-ticket",
      version: 1,
      ticket_id,
      operation_id: input.operation_id,
      operation: operation.operation,
      request_hash,
      site,
      cluster_id: getConfiguredClusterId(),
      issuer_bay_id: computer.home_bay_id,
      home_epoch: Number(computer.home_epoch),
      computer_id: computer.computer_id,
      computer_key: computer.signing_key,
      account_id: input.account_id,
      agent_id: input.agent_id,
      agent_network_id: computer.agent_network_id,
      source_project_id: input.source_project_id,
      attestation: attestation.envelope,
      computer_epoch: Number(computer.epoch),
      policy_epoch: Number(computer.policy_epoch),
      ceiling_hash: computer.ceiling_hash,
      run_id: input.run_id,
      run_expires_at: input.run_expires_at,
      pop_key: input.pop_key,
      issued_at: now,
      start_by,
      max_runtime_ms: maxRuntimeMs(operation),
      limits: {
        max_bytes:
          operation.operation === "put" || operation.operation === "get"
            ? operation.request.bytes
            : null,
        concurrency: DEFAULT_AGENT_CONCURRENCY,
      },
    });
    // The audit row is committed before the ticket leaves the hub.
    await client.query("COMMIT");
    return {
      ticket: signEnvelope(SIGNED_KINDS.ticket, payload, signer),
      operation,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The access matrix at the home bay (the daemon checks again): only the agent
 * that started a job reads its log or kills it (a job's id is its run
 * operation's id), and `ops` shows only the agent's own operations from this
 * project.
 */
async function assertTargetIsTheAgents(
  client: {
    query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }>;
  },
  computer_id: string,
  input: TicketRequest,
  operation: OperationRequest,
): Promise<void> {
  let target: string | null = null;
  let kind: string | null = null;
  if (operation.operation === "logs" || operation.operation === "kill") {
    target = operation.request.job_id;
    kind = "run";
  } else if (operation.operation === "ops") {
    target = operation.request.operation_id;
  }
  if (target == null) return;
  const { rows } = await client.query(
    `SELECT agent_id, source_project_id, operation FROM account_computer_operations
      WHERE computer_id=$1 AND operation_id=$2`,
    [computer_id, target],
  );
  const row = rows[0];
  if (
    row == null ||
    row.agent_id !== input.agent_id ||
    (kind != null && row.operation !== kind) ||
    (kind == null && row.source_project_id !== input.source_project_id)
  ) {
    throw new TicketError(
      kind === "run" ? "no such job of yours" : "no such operation of yours",
    );
  }
}

async function checkAttestation(
  input: TicketRequest,
  now: number,
): Promise<{ envelope: SignedEnvelope<ProjectAttestation> }> {
  const envelope = parseSignedEnvelope(
    input.attestation,
    parseProjectAttestation,
    "attestation",
  );
  // A fresh directory (no stale fallback): issuance fails closed while the
  // seed is unreachable, so a revoked key is never honored late here.
  const directory = await listSigningKeyDirectory({ allowStale: false });
  const keys = keyMap(directory);
  if (
    !verifyEnvelope(SIGNED_KINDS.attestation, envelope, (kid) => keys.get(kid))
  ) {
    throw new TicketError(
      "the project attestation is not signed by a trusted bay",
    );
  }
  const a = envelope.payload;
  // The key must belong to the bay the attestation names.
  const entry = directory.find((k) => k.kid === envelope.kid);
  if (entry?.bay_id !== a.project_bay_id) {
    throw new TicketError(
      "the project attestation is signed by another bay's key",
    );
  }
  if (
    a.site !== (await computersSite()) ||
    a.cluster_id !== getConfiguredClusterId()
  ) {
    throw new TicketError("the project attestation is for another site");
  }
  if (
    a.project_id !== input.source_project_id ||
    a.account_id !== input.account_id
  ) {
    throw new TicketError(
      "the project attestation is for another project or account",
    );
  }
  if (a.home_bay_id !== getConfiguredBayId()) {
    throw new TicketError("the project attestation is for another home bay");
  }
  if (!a.eligible) {
    throw new TicketError(
      "computers can only be used from a project whose only collaborator is you",
    );
  }
  if (a.not_after <= now)
    throw new TicketError("the project attestation expired");
  if (a.issued_at > now + ATTESTATION_SKEW_MS) {
    throw new TicketError("the project attestation is dated in the future");
  }
  // The attesting bay must be the project's owner right now: after a
  // project moves, its old bay's word no longer counts.
  const owner = await resolveProjectBay(a.project_id);
  if (owner?.bay_id !== a.project_bay_id) {
    throw new TicketError(
      "the project attestation is not from the project's current bay",
    );
  }
  return { envelope };
}

/** What the audit keeps of an operation's request (command lines, paths). */
function auditCommand(op: OperationRequest): string | null {
  switch (op.operation) {
    case "exec":
    case "run":
      return commandText(op.request);
    case "put":
    case "get":
      return op.request.path;
    case "logs":
    case "kill":
      return op.request.job_id;
    default:
      return null;
  }
}
