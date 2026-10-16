/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Computers across bays: a computer and its pairing requests are
// authoritative at its account's home bay. Bay-internal: never reachable
// from a browser, project or host.
// Design: src/.agents/computers-direct-host-2026-10-16.md.

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
} from "@cocalc/util/computers/api";

export interface InterBayComputersApi {
  createRequest(opts: {
    account_id: string;
    name: string;
    project_id: string;
  }): Promise<CreatedComputerRequest>;
  listRequests(opts: { account_id: string }): Promise<ComputerRequestSummary[]>;
  /** Fresh auth is checked here, at the home bay, from session_hash. */
  approveRequest(opts: {
    account_id: string;
    session_hash?: string;
    request_id: string;
    /** The words the owner compared with the machine's. */
    pairing_phrase: string;
  }): Promise<{ computer_id: string }>;
  declineRequest(opts: {
    account_id: string;
    request_id: string;
  }): Promise<void>;
  list(opts: { account_id: string }): Promise<ComputerSummary[]>;
  revoke(opts: { account_id: string; computer_id: string }): Promise<void>;
  rename(opts: {
    account_id: string;
    computer_id: string;
    name: string;
  }): Promise<void>;
}

function subject(bay_id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(bay_id)) throw Error("invalid bay_id");
  return `bay.${bay_id}.rpc.computers.v2`;
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
