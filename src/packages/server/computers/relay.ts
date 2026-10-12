/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The hub's relay from an agent to a connected computer (plan part 4b,
// revision 3). The agent already holds a ticket from this bay and a proof
// of possession; the relay adds no authority (the daemon checks everything
// itself), it only carries the message to the computer's current session
// and the answer back.
//
// - The relay row is committed BEFORE the publish: it is the linearization
//   point. It says "dispatched", never "delivered", until an answer comes.
// - The answer comes on a subject in the hub's own namespace, bound to the
//   computer, the session, this hub process and a fresh correlation. Only
//   that session may publish there (conat auth), and the answer must name
//   the same correlation.
// - Waiting is bounded; after that the agent is told the operation was
//   dispatched and may still be running. Retrying with the same operation
//   id never runs it twice (the daemon's ledger replays its outcome).

import { randomBytes } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { conat } from "@cocalc/backend/conat";
import type { Client } from "@cocalc/conat/core/client";
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
import { verifyEnvelope } from "@cocalc/backend/computers/crypto";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { keyMap, listSigningKeyDirectory } from "./signing-keys";
import { currentSession } from "./sessions";

const logger = getLogger("server:computers:relay");

/** How long the agent's call waits for the answer. */
export const RELAY_WAIT_MS = 25_000;
/** How long an unanswered relay row lives. */
export const RELAY_LIFETIME_MS = 60 * 60 * 1000;
/** The largest answer accepted from a computer. */
export const MAX_ANSWER_BYTES = 8 * 1024 * 1024;

/** This hub process: replies are addressed to it alone. */
const HUB_PROCESS = randomBytes(12).toString("base64url");

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
      /** Sent to the computer's session; it may be running. Retry later. */
      state: "dispatched";
      operation_id: string;
    };

export async function relayToComputer({
  account_id,
  agent_id,
  run_id,
  ticket,
  proof,
  request,
  waitMs = RELAY_WAIT_MS,
}: {
  account_id: string;
  agent_id: string;
  run_id: string;
  ticket: unknown;
  proof: unknown;
  request: unknown;
  waitMs?: number;
}): Promise<RelayResult> {
  // Only tickets this bay issued, to this very agent run.
  const envelope = parseSignedEnvelope(ticket, parseComputerTicket, "ticket");
  const t = envelope.payload;
  const bay_id = getConfiguredBayId();
  const directory = await listSigningKeyDirectory({ allowStale: false });
  const ours = directory.filter((k) => k.bay_id === bay_id);
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
    t.run_id !== run_id
  ) {
    throw new ComputerRelayError("this ticket is for another agent");
  }
  if (typeof proof !== "string" || proof.length > 256) {
    throw new ComputerRelayError("invalid proof of possession");
  }
  const session = await currentSession(t.computer_id);
  if (session == null || session.account_id !== account_id) {
    throw new ComputerRelayError("this computer is not connected");
  }

  const correlation = randomBytes(16).toString("base64url");
  const reply_subject = computerReplySubject(
    t.computer_id,
    session.session_id,
    HUB_PROCESS,
    correlation,
  );
  const now = Date.now();
  // The linearization point: committed before anything is published.
  await getPool().query(
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
      session.epoch,
      HUB_PROCESS,
      new Date(now),
      new Date(now + RELAY_LIFETIME_MS),
    ],
  );

  const cn = hubClient();
  const sub = await cn.subscribe(reply_subject);
  try {
    const op: ComputerOpMessage = {
      v: 1,
      correlation,
      reply_subject,
      hub_now: Date.now(),
      message: { ticket, proof, request },
    };
    await cn.publish(computerOpSubject(t.computer_id, session.session_id), op);
    const answer = await firstAnswer(sub, correlation, waitMs);
    if (answer === undefined) {
      return {
        answered: false,
        state: "dispatched",
        operation_id: t.operation_id,
      };
    }
    await getPool()
      .query(
        `UPDATE account_computer_relays SET state='answered', answer=$2
          WHERE correlation=$1`,
        [correlation, JSON.stringify(summary(answer))],
      )
      .catch((err) => logger.warn("recording a relay answer failed", err));
    return { answered: true, reply: answer };
  } finally {
    sub.close();
  }
}

async function firstAnswer(
  sub: AsyncIterable<any> & { close: () => void },
  correlation: string,
  waitMs: number,
): Promise<unknown | undefined> {
  const timer = setTimeout(() => sub.close(), waitMs);
  try {
    for await (const mesg of sub) {
      if ((mesg.raw?.length ?? 0) > MAX_ANSWER_BYTES) continue;
      const data = mesg.data as ComputerReplyMessage | undefined;
      if (data?.v === 1 && data.correlation === correlation) {
        return data.reply;
      }
    }
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** What the relay row keeps of an answer: no command output. */
function summary(reply: any): unknown {
  if (reply == null || typeof reply !== "object") return null;
  return {
    ok: reply.ok ?? null,
    state: reply.state ?? null,
    replayed: reply.replayed ?? null,
    refused: Array.isArray(reply.refused) ? reply.refused.slice(0, 10) : null,
  };
}

/** Forget relay rows past their lifetime. */
export async function pruneComputerRelays(now = Date.now()): Promise<void> {
  await getPool().query(
    `DELETE FROM account_computer_relays WHERE expires_at < $1`,
    [new Date(now)],
  );
}
