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
  SigningKeyEndorsement,
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
  /** When it was last heard from (its connector's latest heartbeat). */
  last_seen: number | null;
  /** Its connector is online now: a live session seen in the last 45 s. */
  connected: boolean;
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
  /** Once approved: the cluster's signing keys the daemon will trust. */
  directory?: DirectorySigningKey[];
  /** Once approved: the approved policy (the certificate's ceiling). */
  policy?: ComputerPolicy;
  agent_network_id?: string;
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
  /**
   * The agent network the computer would serve, as it is now. Approval must
   * send back this generation: it changes with every membership change.
   */
  agent_network: {
    agent_network_id: string;
    title: string;
    state: string;
    generation: string;
    members: { agent_id: string; project_id: string }[];
  } | null;
  computer_id: string | null;
  expires_at: number;
  created_at: number;
}

export type TicketResult =
  | { ticket: SignedEnvelope<ComputerTicket>; operation: OperationRequest }
  /** The operation already finished; its recorded outcome, no new ticket. */
  | { finished: { state: string; exit_code: number | null } };

/** A bay's public signing key, as it publishes it to the seed's directory. */
export interface PublishedSigningKey {
  kid: string;
  public_key: string;
  not_after: number;
  /** By the bay's previous key; null for its first. */
  endorsement: SignedEnvelope<SigningKeyEndorsement> | null;
}

/** A key in the cluster's directory: which bay holds it, until when. */
export interface DirectorySigningKey {
  kid: string;
  bay_id: string;
  public_key: string;
  not_after: number;
}
