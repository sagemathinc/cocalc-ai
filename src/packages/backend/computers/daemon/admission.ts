/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Admit one operation: every check the daemon makes before the ledger.
// Plan: src/.agents/computers-plan-2026-10-11.md ("The daemon's checks").
//
// 1. The ticket parses (unknown versions fail closed) and is signed by a
//    trusted key of the computer's home bay.
// 2. Its attestation is signed by a trusted key of the project's bay.
// 3. The request parses into its canonical form and hashes to the ticket's
//    request hash, and the proof of possession is by the ticket's PoP key.
// 4. ticketRefusals: audience, policy epoch, floors, attestation, start-by,
//    the local receipt bound.
// 5. The session hasn't ended.
// Anything malformed is a refusal, never an exception.

import {
  parseComputerTicket,
  parseSignedEnvelope,
  SIGNED_KINDS,
  ticketRefusals,
  type ComputerTicket,
} from "@cocalc/util/computers/protocol";
import {
  parseOperationRequest,
  type OperationRequest,
} from "@cocalc/util/computers/operations";
import {
  requestHash,
  verifyEnvelope,
  verifyProofOfPossession,
} from "../crypto";
import type { DaemonStore } from "./state";

export interface AdmissionInput {
  ticket: unknown;
  /** base64url signature by the ticket's PoP key over (ticket id, request hash). */
  proof: unknown;
  request: unknown;
  /** The continuous clock when the message arrived. */
  received_at: number;
}

export interface AdmissionContext {
  store: DaemonStore;
  /** The daemon's estimate of hub time; undefined before it has one. */
  hub_now: number | undefined;
  /** The continuous clock now. */
  continuous_now: number;
  session_ended: boolean;
}

export type Admission =
  | { ok: true; ticket: ComputerTicket; operation: OperationRequest }
  | { ok: false; refusals: string[] };

export function admit(input: AdmissionInput, ctx: AdmissionContext): Admission {
  const refuse = (...refusals: string[]): Admission => ({
    ok: false,
    refusals,
  });
  if (ctx.session_ended)
    return refuse("the session on this computer has ended");
  if (ctx.hub_now == null) return refuse("this computer has no hub time yet");
  const hubNow = ctx.hub_now;
  const state = ctx.store.state;

  let envelope;
  try {
    envelope = parseSignedEnvelope(input.ticket, parseComputerTicket, "ticket");
  } catch (err) {
    return refuse(`malformed ticket: ${(err as Error).message}`);
  }
  const homeKey = ctx.store.trustedKey(envelope.kid, state.home_bay_id, hubNow);
  if (
    homeKey == null ||
    !verifyEnvelope(SIGNED_KINDS.ticket, envelope, (kid) =>
      kid === envelope.kid ? homeKey : undefined,
    )
  ) {
    return refuse("ticket is not signed by this computer's home bay");
  }
  const ticket = envelope.payload;

  const attestation = ticket.attestation;
  const projectKey = ctx.store.trustedKey(
    attestation.kid,
    attestation.payload.project_bay_id,
    hubNow,
  );
  if (
    projectKey == null ||
    !verifyEnvelope(SIGNED_KINDS.attestation, attestation, (kid) =>
      kid === attestation.kid ? projectKey : undefined,
    )
  ) {
    return refuse("project attestation is not signed by the project's bay");
  }

  let operation: OperationRequest;
  try {
    operation = parseOperationRequest(ticket.operation, input.request);
  } catch (err) {
    return refuse(`malformed request: ${(err as Error).message}`);
  }
  if (requestHash(operation) !== ticket.request_hash) {
    return refuse("request does not match the ticket");
  }
  if (
    typeof input.proof !== "string" ||
    !verifyProofOfPossession(
      ticket.pop_key,
      ticket.ticket_id,
      ticket.request_hash,
      input.proof,
    )
  ) {
    return refuse("proof of possession is invalid");
  }

  const refusals = ticketRefusals(ticket, state, {
    hub_now: hubNow,
    since_receipt_ms: Math.max(0, ctx.continuous_now - input.received_at),
  });
  if (refusals.length > 0) return refuse(...refusals);
  return { ok: true, ticket, operation };
}

/**
 * The cheap check before anything else (any authenticated principal can send
 * to the computer's subject): a token bucket per sender and one overall.
 */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
    private readonly maxSenders = 1000,
  ) {}

  allow(sender: string, now: number): boolean {
    let b = this.buckets.get(sender);
    if (b == null) {
      if (this.buckets.size >= this.maxSenders) {
        for (const [k, v] of this.buckets) {
          if (now - v.at > 60_000) this.buckets.delete(k);
        }
        if (this.buckets.size >= this.maxSenders) return false;
      }
      b = { tokens: this.burst, at: now };
      this.buckets.set(sender, b);
    }
    b.tokens = Math.min(
      this.burst,
      b.tokens + ((now - b.at) / 1000) * this.perSecond,
    );
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}
