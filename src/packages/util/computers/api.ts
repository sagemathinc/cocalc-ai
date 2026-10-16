/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Shapes shared by the hub, the inter-bay service, the CLI, the connector
// and the frontend. Design: src/.agents/computers-direct-host-2026-10-16.md.

/** How often a connector asks the hub for a fresh host token. */
export const HOST_TOKEN_REFRESH_MS = 5 * 60 * 1000;
/** A computer that asked for a host token this recently counts as online. */
export const ONLINE_WITHIN_MS = 2 * HOST_TOKEN_REFRESH_MS + 60 * 1000;

export interface ComputerSummary {
  computer_id: string;
  name: string;
  /** The one project whose processes may run commands there. */
  project_id: string;
  hostname: string;
  os: string;
  arch: string;
  machine_user: string;
  created_at: number;
  /** When it last asked for a host token. */
  connected_at: number | null;
  /** Asked for a host token recently (see ONLINE_WITHIN_MS). */
  online: boolean;
  revoked_at: number | null;
}

/** The machine as it describes itself when it claims a request. */
export interface MachineInfo {
  hostname: string;
  os: string;
  arch: string;
  user: string;
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
  project_id: string;
  /** pending, claimed, approved, declined, expired, invalidated. */
  state: string;
  /** Once claimed: the words the machine shows. */
  pairing_phrase: string | null;
  machine: MachineInfo | null;
  computer_id: string | null;
  expires_at: number;
  created_at: number;
  /** The line to run on the machine (its home bay's pairing URL). */
  pairing_url?: string;
}

/** What the machine gets when it claims a request. Only it sees the secret. */
export interface PairingClaim {
  request_id: string;
  name: string;
  /** Whose computer it becomes, so the person at the machine can check. */
  account_label: string;
  pairing_phrase: string;
  expires_at: number;
  /** The computer's token once the owner approves. Shown to no one else. */
  secret: string;
}

/** What the machine sees while it waits for the owner. */
export interface PairingStatus {
  request_id: string;
  /** claimed, approved, declined, expired or invalidated. */
  state: string;
  expires_at: number;
  /** Once approved. */
  computer_id?: string;
  name?: string;
  project_id?: string;
}

/** Where and how a computer connects now. */
export interface HostConnection {
  computer_id: string;
  project_id: string;
  host_id: string;
  /** The host's conat address. */
  address: string;
  /** Host token for the computer principal. */
  token: string;
  expires_at: number;
}
