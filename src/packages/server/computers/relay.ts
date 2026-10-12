/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The hub's relay from an agent to a connected computer (plan part 4b,
// revision 3). The daemon checks everything itself, but the relay is also
// an authorization point: nothing reaches a computer that the home bay
// wouldn't authorize right now.
//
// One transaction, in the lock order of every narrowing path (so a narrowing
// either happens before and refuses this relay, or after and sees its row):
//   account-rehome fence -> agent controls -> network membership -> computer
//   -> the operation's committed row -> the exact live session.
// It checks the ticket is this bay's LATEST ticket for that operation, for
// this agent run, at the computer's current epochs; recomputes the request
// hash; verifies the proof of possession with the key recorded at issuance;
// and inserts the relay row. Only after COMMIT is anything published: the
// row is the linearization point, and it says "dispatched", never
// "delivered", until an answer arrives.
//
// Bounded everywhere: at most one open relay per operation, per-computer,
// per-account and per-process waiter caps, raw byte limits on the reply
// subscription before reassembly, and a terminal answer transition that
// happens at most once and only for the exact relay. After the wait the
// relay is marked "expired" (outcome unknown at the hub); the agent asks
// the computer with `ops` (the daemon's ledger replays its outcome).

import { randomBytes } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { conat } from "@cocalc/backend/conat";
import type { Client } from "@cocalc/conat/core/client";
import type { ReceiveLimits } from "@cocalc/conat/core/receive-budget";
import getLogger from "@cocalc/backend/logger";
import {
  computerOpSubject,
  computerReplySubject,
  type ComputerOpMessage,
  type ComputerReplyMessage,
} from "@cocalc/conat/computers/subjects";
import {
  parseComputerTicket,
  parseSignedEnvelope,
  SIGNED_KINDS,
} from "@cocalc/util/computers/protocol";
import { parseOperationRequest } from "@cocalc/util/computers/operations";
import {
  requestHash,
  verifyEnvelope,
  verifyProofOfPossession,
} from "@cocalc/backend/computers/crypto";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { keyMap, listSigningKeyDirectory } from "./signing-keys";
import { assertComputersAuthority, lockAgentControls } from "./authority";
import { SESSION_LIVENESS_MS } from "./sessions";

const logger = getLogger("server:computers:relay");

/** How long the agent's call waits for the answer. */
export const RELAY_WAIT_MS = 25_000;
/** The largest answer accepted from a computer (raw, before reassembly). */
export const MAX_ANSWER_BYTES = 8 * 1024 * 1024;
export const MAX_OPEN_RELAYS_PER_COMPUTER = 16;
/** A relay row outlives its wait by this much (it is expired after). */
const RELAY_EXPIRY_MARGIN_MS = 5_000;
const RELAY_RETENTION_MS = 24 * 60 * 60 * 1000;
export const MAX_OPEN_RELAYS_PER_ACCOUNT = 32;
export const MAX_WAITERS_PER_PROCESS = 256;
let maxWaiters = MAX_WAITERS_PER_PROCESS;

/** Tests: the per-process waiter cap. */
export function setMaxWaitersForTesting(n: number | undefined): void {
  maxWaiters = n ?? MAX_WAITERS_PER_PROCESS;
}
const TERMINAL_OPERATION_STATES = new Set([
  "done",
  "failed",
  "refused",
  "unknown",
]);

/** Raw limits on the reply subscription, enforced before reassembly. */
export const REPLY_RECEIVE_LIMITS: ReceiveLimits = {
  maxMessageBytes: MAX_ANSWER_BYTES,
  maxInflightBytes: MAX_ANSWER_BYTES,
  maxInflightMessages: 1,
  maxFragmentsPerMessage: 64,
};

/** This hub process: replies are addressed to it alone. */
const HUB_PROCESS = randomBytes(12).toString("base64url");
let waiters = 0;

let client: Client | undefined;
function hubClient(): Client {
  client ??= conat();
  return client;
}

/** Tests: the hub's conat client. */
export function setRelayClientForTesting(c: Client | undefined): void {
  client = c;
}

export class ComputerRelayError extends Error {}

export type RelayResult =
  | { answered: true; reply: unknown }
  | {
      answered: false;
      /** Sent to the computer's session; the outcome is unknown here. */
      state: "dispatched";
      operation_id: string;
    };

interface Authorized {
  correlation: string;
  computer_id: string;
  session_id: string;
  operation_id: string;
}

export async function relayToComputer({
  account_id,
  agent_id,
  run_id,
  source_project_id,
  ticket,
  proof,
  request,
  waitMs = RELAY_WAIT_MS,
  now = Date.now(),
  beforeCommit,
}: {
  account_id: string;
  agent_id: string;
  run_id: string;
  source_project_id: string;
  ticket: unknown;
  proof: unknown;
  request: unknown;
  waitMs?: number;
  now?: number;
  /** Tests: runs inside the transaction, after every lock is held. */
  beforeCommit?: () => Promise<void>;
}): Promise<RelayResult> {
  // Reserved before the first await, released whatever happens.
  if (waiters >= maxWaiters) {
    throw new ComputerRelayError("the hub is busy; try again");
  }
  waiters += 1;
  try {
    const authorized = await authorizeRelay({
      account_id,
      agent_id,
      run_id,
      source_project_id,
      ticket,
      proof,
      request,
      waitMs,
      now,
      beforeCommit,
    });
    return await dispatch(authorized, { ticket, proof, request }, waitMs);
  } finally {
    waiters -= 1;
  }
}

async function authorizeRelay(opts: {
  account_id: string;
  agent_id: string;
  run_id: string;
  source_project_id: string;
  ticket: unknown;
  proof: unknown;
  request: unknown;
  waitMs: number;
  now: number;
  beforeCommit?: () => Promise<void>;
}): Promise<Authorized> {
  const { account_id, agent_id, run_id, source_project_id, now } = opts;
  // Outside the transaction: parsing, this bay's keys, the request hash.
  const envelope = parseSignedEnvelope(
    opts.ticket,
    parseComputerTicket,
    "ticket",
  );
  const t = envelope.payload;
  const bay_id = getConfiguredBayId();
  const ours = (await listSigningKeyDirectory({ allowStale: false })).filter(
    (k) => k.bay_id === bay_id,
  );
  if (
    t.issuer_bay_id !== bay_id ||
    !verifyEnvelope(SIGNED_KINDS.ticket, envelope, (kid) =>
      keyMap(ours).get(kid),
    )
  ) {
    throw new ComputerRelayError("this ticket was not issued here");
  }
  if (
    t.account_id !== account_id ||
    t.agent_id !== agent_id ||
    t.run_id !== run_id ||
    t.source_project_id !== source_project_id
  ) {
    throw new ComputerRelayError("this ticket is for another agent");
  }
  let hash: string;
  try {
    hash = requestHash(parseOperationRequest(t.operation, opts.request));
  } catch {
    throw new ComputerRelayError("the request does not match the ticket");
  }
  if (hash !== t.request_hash) {
    throw new ComputerRelayError("the request does not match the ticket");
  }
  if (typeof opts.proof !== "string" || opts.proof.length > 256) {
    throw new ComputerRelayError("invalid proof of possession");
  }

  const db = await getPool().connect();
  try {
    await db.query("BEGIN");
    await assertComputersAuthority(db, account_id, "relay to a computer");
    const { paused } = await lockAgentControls(db, account_id);
    if (paused) {
      throw new ComputerRelayError(
        "agent messaging is paused for this account",
      );
    }
    const network = (
      await db.query(
        `SELECT agent_network_id FROM account_computers
          WHERE computer_id=$1 AND account_id=$2 AND tombstoned_at IS NULL`,
        [t.computer_id, account_id],
      )
    ).rows[0]?.agent_network_id;
    if (network == null || network !== t.agent_network_id) {
      throw new ComputerRelayError("no such computer");
    }
    const member = await db.query(
      `SELECT 1 FROM agent_networks n
         JOIN agent_network_members m ON m.agent_network_id = n.agent_network_id
        WHERE n.agent_network_id=$1 AND n.account_id=$2 AND n.state='active'
          AND m.member_kind='registered' AND m.removed_at IS NULL
          AND m.registered_agent_id=$3 AND m.project_id=$4
        FOR SHARE OF n`,
      [network, account_id, agent_id, source_project_id],
    );
    const computer = (
      await db.query(
        `SELECT * FROM account_computers
          WHERE computer_id=$1 AND tombstoned_at IS NULL FOR SHARE`,
        [t.computer_id],
      )
    ).rows[0];
    if (computer == null || computer.agent_network_id !== network) {
      throw new ComputerRelayError("no such computer");
    }
    if (member.rows.length === 0) {
      throw new ComputerRelayError(
        "this agent is not in the agent network this computer serves",
      );
    }
    if (computer.revoked_at != null) {
      throw new ComputerRelayError("this computer is disconnected");
    }
    if (
      computer.deadline != null &&
      new Date(computer.deadline).valueOf() <= now
    ) {
      throw new ComputerRelayError("this computer's session has ended");
    }
    // Everything the ticket was issued against is still current.
    if (
      Number(computer.epoch) !== t.computer_epoch ||
      Number(computer.policy_epoch) !== t.policy_epoch ||
      Number(computer.home_epoch) !== t.home_epoch ||
      computer.ceiling_hash !== t.ceiling_hash ||
      computer.signing_key !== t.computer_key
    ) {
      throw new ComputerRelayError(
        "this ticket is stale (the computer changed); get a new one",
      );
    }
    // Advisory locks before the operation row, as ticket issuance does, so
    // a ticket retry and a relay of the same operation can't deadlock.
    // They also serialize the caps below per account and computer.
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `computer-relay-account:${account_id}`,
    ]);
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `computer-relay:${t.computer_id}`,
    ]);
    const op = (
      await db.query(
        `SELECT * FROM account_computer_operations
          WHERE computer_id=$1 AND operation_id=$2 FOR UPDATE`,
        [t.computer_id, t.operation_id],
      )
    ).rows[0];
    if (
      op == null ||
      op.account_id !== account_id ||
      op.agent_id !== agent_id ||
      op.run_id !== run_id ||
      op.source_project_id !== source_project_id ||
      op.operation !== t.operation ||
      op.request_hash !== t.request_hash ||
      op.pop_key !== t.pop_key
    ) {
      throw new ComputerRelayError("no such operation of yours");
    }
    if (op.ticket_id !== t.ticket_id) {
      throw new ComputerRelayError(
        "a newer ticket was issued for this operation; use it",
      );
    }
    if (TERMINAL_OPERATION_STATES.has(op.state)) {
      throw new ComputerRelayError(`this operation is already ${op.state}`);
    }
    if (
      !verifyProofOfPossession(
        op.pop_key,
        t.ticket_id,
        t.request_hash,
        opts.proof,
      )
    ) {
      throw new ComputerRelayError("invalid proof of possession");
    }
    // The exact live session: open, at this epoch, seen recently, and with
    // a lease that covers the whole wait. Times are taken now, after every
    // lock wait, not when the call began.
    const lockedNow = Math.max(now, Date.now());
    const session = (
      await db.query(
        `SELECT session_id FROM account_computer_sessions
          WHERE computer_id=$1 AND closed_at IS NULL AND epoch=$2
            AND lease_until > $3 AND last_seen > $4
          ORDER BY last_seen DESC, connected_at DESC LIMIT 1 FOR SHARE`,
        [
          t.computer_id,
          Number(computer.epoch),
          new Date(lockedNow + opts.waitMs),
          new Date(lockedNow - SESSION_LIVENESS_MS),
        ],
      )
    ).rows[0];
    if (session == null) {
      throw new ComputerRelayError("this computer is not connected");
    }
    await db.query(
      `UPDATE account_computer_relays SET state='expired'
        WHERE account_id=$1 AND state='dispatched' AND expires_at <= $2`,
      [account_id, new Date(lockedNow)],
    );
    // Retention, bounded and inline: this computer's finished relay rows
    // older than a day.
    await db.query(
      `DELETE FROM account_computer_relays
        WHERE computer_id=$1 AND state <> 'dispatched' AND expires_at < $2`,
      [t.computer_id, new Date(lockedNow - RELAY_RETENTION_MS)],
    );
    const open = (
      await db.query(
        `SELECT
           count(*) FILTER (WHERE computer_id=$2)::int AS per_computer,
           count(*)::int AS per_account,
           count(*) FILTER (WHERE computer_id=$2 AND operation_id=$3)::int AS per_operation
         FROM account_computer_relays
        WHERE account_id=$1 AND state='dispatched'`,
        [account_id, t.computer_id, t.operation_id],
      )
    ).rows[0];
    if (open.per_operation > 0) {
      throw new ComputerRelayError(
        "this operation is already being relayed; check it with `ops`",
      );
    }
    if (open.per_computer >= MAX_OPEN_RELAYS_PER_COMPUTER) {
      throw new ComputerRelayError(
        "too many operations in flight on this computer",
      );
    }
    if (open.per_account >= MAX_OPEN_RELAYS_PER_ACCOUNT) {
      throw new ComputerRelayError(
        "too many operations in flight on this account",
      );
    }
    const correlation = randomBytes(16).toString("base64url");
    await db.query(
      `INSERT INTO account_computer_relays
         (correlation, computer_id, account_id, session_id, ticket_id,
          operation_id, request_hash, epoch, hub_process, state, created_at,
          expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'dispatched',$10,$11)`,
      [
        correlation,
        t.computer_id,
        account_id,
        session.session_id,
        t.ticket_id,
        t.operation_id,
        t.request_hash,
        Number(computer.epoch),
        HUB_PROCESS,
        new Date(lockedNow),
        new Date(lockedNow + opts.waitMs + RELAY_EXPIRY_MARGIN_MS),
      ],
    );
    await opts.beforeCommit?.();
    // Stamped again right before COMMIT: the row stays open for the whole
    // wait that starts after it, however long the locks above took, and the
    // session's lease must still cover that wait.
    const commitNow = Date.now();
    await db.query(
      `UPDATE account_computer_relays SET created_at=$2, expires_at=$3
        WHERE correlation=$1`,
      [
        correlation,
        new Date(commitNow),
        new Date(commitNow + opts.waitMs + RELAY_EXPIRY_MARGIN_MS),
      ],
    );
    const still = await db.query(
      `SELECT 1 FROM account_computer_sessions
        WHERE session_id=$1 AND closed_at IS NULL AND lease_until > $2`,
      [session.session_id, new Date(commitNow + opts.waitMs)],
    );
    if (still.rows.length === 0) {
      throw new ComputerRelayError("this computer is not connected");
    }
    await db.query("COMMIT");
    return {
      correlation,
      computer_id: t.computer_id,
      session_id: session.session_id,
      operation_id: t.operation_id,
    };
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

async function dispatch(
  a: Authorized,
  message: ComputerOpMessage["message"],
  waitMs: number,
): Promise<RelayResult> {
  const reply_subject = computerReplySubject(
    a.computer_id,
    a.session_id,
    HUB_PROCESS,
    a.correlation,
  );
  let answer: unknown;
  try {
    const cn = hubClient();
    const sub = await cn.subscribe(reply_subject, {
      receiveLimits: REPLY_RECEIVE_LIMITS,
    });
    try {
      const op: ComputerOpMessage = {
        v: 1,
        correlation: a.correlation,
        reply_subject,
        hub_now: Date.now(),
        message,
      };
      const { count } = await cn.publish(
        computerOpSubject(a.computer_id, a.session_id),
        op,
      );
      if (count === 0) {
        logger.debug("relay published with no subscriber", {
          computer_id: a.computer_id,
          session_id: a.session_id,
        });
      }
      answer = await firstAnswer(sub, a, waitMs);
    } finally {
      sub.close();
    }
  } catch (err) {
    // Committed, so it may have been delivered: the outcome is unknown, the
    // same as when no answer comes.
    logger.warn("relay transport failed after commit", err);
    answer = undefined;
  }
  const record = answer === undefined ? null : summary(answer);
  // At most once, and only for this exact relay.
  const { rowCount } = await getPool()
    .query(
      `UPDATE account_computer_relays SET state=$2, answer=$3
        WHERE correlation=$1 AND state='dispatched'`,
      [
        a.correlation,
        answer === undefined ? "expired" : "answered",
        record == null ? null : JSON.stringify(record),
      ],
    )
    .catch((err) => {
      logger.warn("recording a relay outcome failed", err);
      return { rowCount: 0 };
    });
  if (answer === undefined || !rowCount) {
    return {
      answered: false,
      state: "dispatched",
      operation_id: a.operation_id,
    };
  }
  return { answered: true, reply: answer };
}

async function firstAnswer(
  sub: AsyncIterable<any> & { close: () => void },
  a: Authorized,
  waitMs: number,
): Promise<unknown | undefined> {
  const timer = setTimeout(() => sub.close(), waitMs);
  try {
    for await (const mesg of sub) {
      let data: ComputerReplyMessage | undefined;
      try {
        data = mesg.data;
      } catch {
        continue;
      }
      if (data?.v !== 1 || data.correlation !== a.correlation) continue;
      const reply: any = data.reply;
      // An admitted answer names this very operation.
      if (reply?.ok === true && reply.operation_id !== a.operation_id) continue;
      return reply;
    }
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** The most the relay row keeps of an answer (serialized). */
export const MAX_SUMMARY_BYTES = 4096;
const STATE = /^[a-z_]{1,20}$/;

/**
 * What the relay row keeps of an answer: fixed-type, bounded fields only
 * (never command output, never anything nested from the computer).
 */
export function summary(reply: any): {
  ok: boolean | null;
  state: string | null;
  replayed: boolean | null;
  refused: string[] | null;
} {
  const r = reply != null && typeof reply === "object" ? reply : {};
  const out = {
    ok: typeof r.ok === "boolean" ? r.ok : null,
    state: typeof r.state === "string" && STATE.test(r.state) ? r.state : null,
    replayed: typeof r.replayed === "boolean" ? r.replayed : null,
    refused: Array.isArray(r.refused)
      ? r.refused
          .slice(0, 10)
          .map((x) => (typeof x === "string" ? x.slice(0, 200) : "?"))
      : null,
  };
  if (Buffer.byteLength(JSON.stringify(out)) > MAX_SUMMARY_BYTES) {
    return { ...out, refused: null };
  }
  return out;
}
