/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

/*
The token broker's transport (G3b design v3 §3).

- broker.<cluster>.rpc.mint.v1: the broker's mint and publicKeys, for bays.
- broker.<cluster>.heartbeat.v1: the broker's registration heartbeats, heard
  by every bay process.

The token broker's lookups on a bay:
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

function brokerSubject(cluster_id: string, rest: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(cluster_id)) {
    throw Error("invalid cluster_id");
  }
  return `broker.${cluster_id}.${rest}`;
}

export function federatedBrokerMintSubject(cluster_id: string): string {
  return brokerSubject(cluster_id, "rpc.mint.v1");
}

export function federatedBrokerHeartbeatSubject(cluster_id: string): string {
  return brokerSubject(cluster_id, "heartbeat.v1");
}

const MINT_SERVICE = "federated-broker-mint";

export interface FederatedBrokerMintApi {
  mint(request: unknown): Promise<unknown>;
  publicKeys(): Promise<unknown>;
}

/** For a bay: the raw call; replies are checked by the caller (strictly). */
export function createFederatedBrokerMintCall(
  client: Client,
  cluster_id: string,
): (method: "mint" | "publicKeys", args: unknown[]) => Promise<unknown> {
  const api = createServiceClient<FederatedBrokerMintApi>({
    client,
    service: MINT_SERVICE,
    subject: federatedBrokerMintSubject(cluster_id),
    timeout: 15_000,
    noRetry: true,
    transport: "request",
  });
  return async (method, args) =>
    method === "mint" ? await api.mint(args[0]) : await api.publicKeys();
}

/** For the broker process. */
export function createFederatedBrokerMintService(
  cluster_id: string,
  handler: {
    mint(
      input: unknown,
      caller: AuthenticatedCaller | undefined,
    ): Promise<unknown>;
    publicKeys(caller: AuthenticatedCaller | undefined): Promise<unknown>;
  },
  options: Omit<Options, "handler" | "service" | "subject">,
) {
  return createConatService({
    ...options,
    service: MINT_SERVICE,
    subject: federatedBrokerMintSubject(cluster_id),
    handler: async (mesg, context) => {
      const args = mesg?.args;
      if (mesg?.name === "mint" && Array.isArray(args) && args.length === 1) {
        return await handler.mint(args[0], context?.caller);
      }
      if (
        mesg?.name === "publicKeys" &&
        Array.isArray(args) &&
        args.length === 0
      ) {
        return await handler.publicKeys(context?.caller);
      }
      throw Error("request_refused");
    },
  });
}

/** For the broker process: one heartbeat. */
export async function publishFederatedBrokerHeartbeat(
  client: Client,
  cluster_id: string,
  beat: unknown,
): Promise<void> {
  await client.publish(federatedBrokerHeartbeatSubject(cluster_id), beat);
}

/**
 * For a bay: every heartbeat with the caller the conat server stamped (never
 * from the message). `onEnd` runs when the subscription ends for any
 * reason. Returns a function that stops listening.
 */
export async function onFederatedBrokerHeartbeat(
  client: Client,
  cluster_id: string,
  handle: (beat: unknown, caller: AuthenticatedCaller | undefined) => void,
  onEnd: () => void,
): Promise<() => void> {
  const sub = await client.subscribe(
    federatedBrokerHeartbeatSubject(cluster_id),
  );
  (async () => {
    try {
      for await (const mesg of sub) {
        try {
          handle(mesg.data, mesg.caller);
        } catch {
          // A malformed heartbeat is the handler's business; keep listening.
        }
      }
    } catch {
      // The subscription failed: the same as it ending.
    } finally {
      onEnd();
    }
  })();
  return () => sub.close();
}
