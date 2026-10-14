/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Computers across bays: everything about a computer is authoritative at its
// account's home bay; project attestations come from the project's bay.
// Bay-internal: never reachable from a browser, project or host.
// Plan: src/.agents/computers-plan-2026-10-11.md ("Multi-bay").

import type { Client } from "@cocalc/conat/core/client";
import {
  createServiceClient,
  createServiceHandler,
} from "@cocalc/conat/service/typed";
import type { Options } from "@cocalc/conat/service/service";
import type {
  ComputerRequestSummary,
  ComputerSummary,
  CreatedComputerRequest,
  PairingView,
  TicketResult,
} from "@cocalc/util/computers/api";
import type {
  ComputerCertificate,
  ProjectAttestation,
  SignedEnvelope,
} from "@cocalc/util/computers/protocol";
import type {
  ComputerPolicy,
  RequestedPolicy,
} from "@cocalc/util/computers/policy";

export interface ComputerRequester {
  agent_id: string;
  run_id: string;
  project_id: string;
  thread_id?: string | null;
}

export interface InterBayComputersApi {
  // At the account's home bay.
  createRequest(opts: {
    account_id: string;
    requested_by?: ComputerRequester;
    name: string;
    requested_policy: unknown;
    why?: string;
  }): Promise<CreatedComputerRequest & { policy: RequestedPolicy }>;
  listRequests(opts: { account_id: string }): Promise<ComputerRequestSummary[]>;
  getPairingView(opts: { request_id: string }): Promise<PairingView>;
  submitPairing(opts: {
    request_id: string;
    transcript: unknown;
    signing_public_key: string;
    resolved_policy: unknown;
  }): Promise<{ pairing_phrase: string; transcript_hash: string }>;
  /** Fresh auth is checked here, at the home bay, from session_hash. */
  approveRequest(opts: {
    account_id: string;
    session_hash?: string;
    request_id: string;
    transcript_hash: string;
    agent_network_generation: string;
  }): Promise<{
    computer_id: string;
    certificate: SignedEnvelope<ComputerCertificate>;
    policy: ComputerPolicy;
  }>;
  declineRequest(opts: {
    account_id: string;
    request_id: string;
  }): Promise<void>;
  list(opts: { account_id: string }): Promise<ComputerSummary[]>;
  /** Computers serving a network the agent is in (agent views). */
  listForAgent(opts: {
    account_id: string;
    agent_id: string;
    project_id: string;
  }): Promise<ComputerSummary[]>;
  getForAgent(opts: {
    account_id: string;
    agent_id: string;
    project_id: string;
    computer: string;
  }): Promise<ComputerSummary>;
  get(opts: { account_id: string; computer: string }): Promise<ComputerSummary>;
  revoke(opts: {
    account_id: string;
    computer_id: string;
  }): Promise<{ epoch: number }>;
  /** Fresh auth is checked here, at the home bay, from session_hash. */
  extend(opts: {
    account_id: string;
    session_hash?: string;
    computer_id: string;
    seconds: number;
  }): Promise<{ deadline: number }>;
  rename(opts: {
    account_id: string;
    computer_id: string;
    name: string;
  }): Promise<void>;
  setNotes(opts: {
    account_id: string;
    computer: string;
    author:
      | { kind: "owner"; account_id: string }
      | { kind: "agent"; agent_id: string; project_id: string };
    notes: string;
    expected_revision: number;
    locked?: boolean;
  }): Promise<{ notes_revision: number }>;
  setEffectivePolicy(opts: {
    account_id: string;
    computer_id: string;
    policy: unknown;
  }): Promise<{ policy_epoch: number }>;
  issueTicket(opts: {
    account_id: string;
    agent_id: string;
    run_id: string;
    source_project_id: string;
    run_expires_at: number;
    thread_id?: string | null;
    computer: string;
    operation: string;
    request: unknown;
    operation_id: string;
    pop_key: string;
    attestation: SignedEnvelope<ProjectAttestation>;
  }): Promise<TicketResult>;

  // At the project's owning bay.
  attestProject(opts: {
    project_id: string;
    account_id: string;
    home_bay_id: string;
  }): Promise<SignedEnvelope<ProjectAttestation>>;
}

function subject(bay_id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(bay_id)) throw Error("invalid bay_id");
  return `bay.${bay_id}.rpc.computers.v1`;
}

export function createInterBayComputersClient(
  client: Client,
  bay_id: string,
): InterBayComputersApi {
  return createServiceClient<InterBayComputersApi>({
    client,
    service: "inter-bay-computers",
    subject: subject(bay_id),
    timeout: 30_000,
    noRetry: true,
  });
}

export function createInterBayComputersHandler(
  bay_id: string,
  impl: InterBayComputersApi,
  options: Omit<Options, "handler" | "service" | "subject">,
) {
  return createServiceHandler<InterBayComputersApi>({
    ...options,
    impl,
    service: "inter-bay-computers",
    subject: subject(bay_id),
  });
}
