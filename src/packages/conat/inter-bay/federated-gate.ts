/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

/*
Replication of the federated connector gate (the federated_cli_connectors
site setting) from the seed bay to the other bays. The gate changes only on
the seed (with admin fresh authentication and an audit row); every other bay
accepts a new value only through this service, and only when the transport
authenticated the caller as the seed bay of this cluster. The handler gets
the caller from the conat server (never from the request), so no argument can
claim to be the seed. The generic site-setting replication refuses the gate.
*/

import type { AuthenticatedCaller, Client } from "@cocalc/conat/core/client";
import { createServiceClient } from "@cocalc/conat/service/typed";
import {
  createConatService,
  type Options,
} from "@cocalc/conat/service/service";

export interface InterBayFederatedGateApi {
  /** Sets this bay's copy of the gate (seed bay callers only). */
  apply(opts: { value: string }): Promise<void>;
}

const SERVICE = "inter-bay-federated-gate";

function subject(bay_id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(bay_id)) throw Error("invalid bay_id");
  return `bay.${bay_id}.rpc.federated-gate-replica.v1`;
}

export function createInterBayFederatedGateClient(
  client: Client,
  bay_id: string,
): InterBayFederatedGateApi {
  return createServiceClient<InterBayFederatedGateApi>({
    client,
    service: SERVICE,
    subject: subject(bay_id),
    timeout: 15_000,
    noRetry: true,
    transport: "request",
  });
}

export function createInterBayFederatedGateHandler(
  bay_id: string,
  apply: (
    opts: { value: string },
    caller: AuthenticatedCaller | undefined,
  ) => Promise<void>,
  options: Omit<Options, "handler" | "service" | "subject">,
) {
  return createConatService({
    ...options,
    service: SERVICE,
    subject: subject(bay_id),
    handler: async (mesg, context) => {
      if (mesg?.name !== "apply" || !Array.isArray(mesg?.args)) {
        throw Error("unknown federated gate method");
      }
      return await apply(mesg.args[0], context?.caller);
    },
  });
}
