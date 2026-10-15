/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Conat subjects of a computer's session (plan part 4b, revision 3). Every
// subject names the computer AND the session, so a reclaimed or revoked
// session's socket can't reach its successor's traffic. Computers never
// publish to _INBOX: the hub names a reply subject in its own namespace.
//
//   computer.<computer_id>.<session_id>.op.v1          hub -> daemon
//   hub.computer.<computer_id>.reply.v1.<session_id>.<hub>.<correlation>
//                                                      daemon -> hub

import { isValidUUID } from "@cocalc/util/misc";

/**
 * Hub -> hub: a computer's state is owed, deliver it now. Hub processes
 * only: no account, project, host or computer may use it.
 */
export const COMPUTER_STATE_WAKE_SUBJECT = "hub.computer-state.wake.v1";

/** A hub process id or correlation token: one plain subject segment. */
const TOKEN = /^[A-Za-z0-9_-]{1,64}$/;

export function isSubjectToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value);
}

export function computerOpSubject(
  computer_id: string,
  session_id: string,
): string {
  return `computer.${uuid(computer_id)}.${uuid(session_id)}.op.v1`;
}

export function computerReplyPrefix(
  computer_id: string,
  session_id: string,
): string {
  return `hub.computer.${uuid(computer_id)}.reply.v1.${uuid(session_id)}`;
}

export function computerReplySubject(
  computer_id: string,
  session_id: string,
  hub: string,
  correlation: string,
): string {
  if (!isSubjectToken(hub) || !isSubjectToken(correlation)) {
    throw new Error("invalid reply subject token");
  }
  return `${computerReplyPrefix(computer_id, session_id)}.${hub}.${correlation}`;
}

/**
 * May this computer session subscribe/publish here? Exact subjects only (no
 * wildcards): its op subject to subscribe, a well-formed reply subject of
 * its own session to publish.
 */
export function computerSubjectAllowed(
  computer_id: string,
  session_id: string,
  subject: string,
  type: "sub" | "pub",
): boolean {
  if (!isValidUUID(computer_id) || !isValidUUID(session_id)) return false;
  if (typeof subject !== "string") return false;
  if (type === "sub") {
    return subject === computerOpSubject(computer_id, session_id);
  }
  const prefix = `${computerReplyPrefix(computer_id, session_id)}.`;
  if (!subject.startsWith(prefix)) return false;
  const rest = subject.slice(prefix.length).split(".");
  return rest.length === 2 && rest.every(isSubjectToken);
}

/** The cluster's signing keys, as the daemon trusts them. */
export interface ComputerDirectory {
  generation: number;
  keys: {
    kid: string;
    bay_id: string;
    public_key: string;
    not_after: number;
  }[];
}

/** What the hub sends on the op subject. */
export interface ComputerOpMessage {
  v: 1;
  correlation: string;
  reply_subject: string;
  /** Hub time when sent (the daemon's estimate of hub time follows it). */
  hub_now: number;
  /**
   * Ticket, proof of possession and request, exactly as the agent sent.
   * Absent when this is a push.
   */
  message?: { ticket: unknown; proof: unknown; request: unknown };
  /**
   * A signed push from the home bay instead of an operation: the
   * computer's current state snapshot (floors, policy, ended). The daemon
   * verifies, applies, reconciles, then acknowledges.
   */
  push?: ComputerPush;
  /** So key rotation reaches the daemon (only a newer generation applies). */
  directory?: ComputerDirectory;
}

/** A signed push: the computer's current state snapshot. */
export type ComputerPush = { state: unknown };

/**
 * How the daemon answers a push (in ComputerReplyMessage.reply): only
 * after the state is durably applied and every job reconciled.
 */
export type ComputerPushAck =
  | { ok: true; state_version: string; envelope_hash: string }
  | { ok: false; error: string };

/** What the daemon publishes on the reply subject. */
export interface ComputerReplyMessage {
  v: 1;
  correlation: string;
  reply: unknown;
}

function uuid(value: string): string {
  if (!isValidUUID(value)) throw new Error("invalid id in computer subject");
  return value;
}
