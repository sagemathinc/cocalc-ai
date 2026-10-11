/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Shapes shared by the hub, the inter-bay service, the CLI and the frontend.

import type { OperationRequest } from "./operations";
import type { ComputerPolicy, RequestedPolicy } from "./policy";
import type {
  ComputerCertificate,
  ComputerTicket,
  SignedEnvelope,
} from "./protocol";

export interface ComputerSummary {
  computer_id: string;
  name: string;
  hostname: string;
  os: string;
  arch: string;
  machine_user: string;
  mode: "direct" | "isolated";
  agent_network_id: string;
  effective_policy: ComputerPolicy;
  policy_epoch: number;
  epoch: number;
  deadline: number | null;
  max_deadline: number | null;
  notes: string;
  notes_revision: number;
  notes_locked: boolean;
  connected_at: number | null;
  last_seen: number | null;
  revoked_at: number | null;
  origin: string;
}

/** What the machine shows the owner before pairing. Not secret. */
export interface PairingView {
  site: string;
  cluster_id: string;
  request_id: string;
  account_id: string;
  /** Who will control the computer, so the owner can tell it's their account. */
  account_label: string;
  name: string;
  requested_policy: RequestedPolicy;
  why: string;
  server_nonce: string;
  state: string;
  expires_at: number;
}

/**
 * What the machine sees while it waits for the owner. Only the claimant, who
 * knows the transcript hash, gets an answer.
 */
export interface PairingStatus {
  request_id: string;
  /** pending/paired/approved/declined/expired/invalidated, or revoked. */
  state: string;
  pairing_phrase: string;
  expires_at: number;
  /** Once approved. */
  computer_id?: string;
  name?: string;
  certificate?: SignedEnvelope<ComputerCertificate>;
}

/** A new request, and the line the owner runs on the computer. */
export interface CreatedComputerRequest {
  request_id: string;
  expires_at: number;
  pairing_url: string;
}

export interface ComputerRequestSummary {
  request_id: string;
  name: string;
  state: string;
  why: string;
  requested_policy: RequestedPolicy;
  resolved_policy: ComputerPolicy | null;
  pairing_phrase: string | null;
  transcript_hash: string | null;
  machine: { hostname: string; os: string; arch: string; user: string } | null;
  requested_by_agent_id: string | null;
  computer_id: string | null;
  expires_at: number;
  created_at: number;
}

export type TicketResult =
  | { ticket: SignedEnvelope<ComputerTicket>; operation: OperationRequest }
  /** The operation already finished; its recorded outcome, no new ticket. */
  | { finished: { state: string; exit_code: number | null } };
