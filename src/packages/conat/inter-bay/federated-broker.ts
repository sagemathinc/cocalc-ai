/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

/*
The token broker's lookups on a bay (G3b design v3 §3):
bay.<id>.rpc.federated-broker.v1, with exactly loadGrant, verifyLiveTurn and
isAllowlisted. The broker asks the account's home bay for the first two and
the seed bay for the allowlist. The handler gets the caller from the conat
server (never from the request); the bay checks it is the broker, for the
signer recorded now.
*/

import type { AuthenticatedCaller, Client } from "@cocalc/conat/core/client";
import { createServiceClient } from "@cocalc/conat/service/typed";
import {
  createConatService,
  type Options,
} from "@cocalc/conat/service/service";

export interface InterBayFederatedBrokerApi {
  loadGrant(opts: { account_id: string; grant_id: string }): Promise<unknown>;
  verifyLiveTurn(request: unknown): Promise<{ live: true }>;
  isAllowlisted(entry: {
    provider: "gcp";
    service_account: string;
    permission_profile: string;
    target_project: string;
  }): Promise<{ allowlisted: boolean }>;
}

const SERVICE = "inter-bay-federated-broker";

export function federatedBrokerLookupSubject(bay_id: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(bay_id)) throw Error("invalid bay_id");
  return `bay.${bay_id}.rpc.federated-broker.v1`;
}

/** For the broker process. */
export function createInterBayFederatedBrokerClient(
  client: Client,
  bay_id: string,
): InterBayFederatedBrokerApi {
  return createServiceClient<InterBayFederatedBrokerApi>({
    client,
    service: SERVICE,
    subject: federatedBrokerLookupSubject(bay_id),
    timeout: 15_000,
    noRetry: true,
    transport: "request",
  });
}

export function createInterBayFederatedBrokerHandler(
  bay_id: string,
  handle: (
    method: unknown,
    args: unknown,
    caller: AuthenticatedCaller | undefined,
  ) => Promise<unknown>,
  options: Omit<Options, "handler" | "service" | "subject">,
) {
  return createConatService({
    ...options,
    service: SERVICE,
    subject: federatedBrokerLookupSubject(bay_id),
    handler: async (mesg, context) =>
      await handle(mesg?.name, mesg?.args, context?.caller),
  });
}
