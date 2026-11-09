/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
A bay's side of the broker transport (G3b design v3 §3): the mint client
(replies checked strictly by broker-service.ts) and the broker's heartbeats,
which feed this process's registration lease. A heartbeat counts only when
the conat server stamped it as the broker, for the signer recorded now; the
stamp (never the message) is the connection identity.
*/

import type { Client } from "@cocalc/conat/core/client";
import {
  createFederatedBrokerMintCall,
  onFederatedBrokerHeartbeat,
} from "@cocalc/conat/inter-bay/federated-broker";
import type { BrokerRegistration } from "./broker-registration";
import { BrokerLookupRefusal, requireBrokerCaller } from "./broker-lookups";
import { createBrokerMintClient } from "./broker-service";

/** Feeds one heartbeat to the registration; false if it doesn't count. */
export function acceptBrokerHeartbeat({
  beat,
  caller,
  currentSignerId,
  registration,
}: {
  beat: unknown;
  caller: unknown;
  currentSignerId: string | undefined;
  registration: Pick<BrokerRegistration, "heartbeat" | "clear">;
}): boolean {
  try {
    requireBrokerCaller(caller, currentSignerId);
  } catch (err) {
    if (!(err instanceof BrokerLookupRefusal)) throw err;
    // Not exactly the broker for the signer recorded now. If it claims to be
    // a broker at all, the registration ends at once (e.g. the signer
    // record was replaced); anything else is ignored.
    if (
      caller != null &&
      typeof caller === "object" &&
      "federated_broker_signer_id" in caller
    ) {
      registration.clear("signer_changed");
    }
    return false;
  }
  return registration.heartbeat(
    beat,
    (caller as { federated_broker_signer_id: string })
      .federated_broker_signer_id,
  );
}

export async function startFederatedBrokerTransport({
  client,
  clusterId,
  currentSignerId,
  registration,
  setMintClient,
}: {
  client: Client;
  clusterId: string;
  currentSignerId: () => Promise<string | undefined>;
  registration: BrokerRegistration;
  setMintClient: (
    mintClient: ReturnType<typeof createBrokerMintClient> | undefined,
  ) => void;
}): Promise<() => void> {
  setMintClient(
    createBrokerMintClient(createFederatedBrokerMintCall(client, clusterId)),
  );
  return await onFederatedBrokerHeartbeat(
    client,
    clusterId,
    (beat, caller) => {
      void currentSignerId()
        .catch(() => undefined)
        .then((current) =>
          acceptBrokerHeartbeat({
            beat,
            caller,
            currentSignerId: current,
            registration,
          }),
        );
    },
    () => {
      registration.clear("transport_lost");
      setMintClient(undefined);
    },
  );
}
