/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Federated connector routing: the hub API entry points, which bay each call
runs on, and the real dependencies of the turn (./turn.ts).

- Turns, assignments and the broker's recheck run on the account's home bay.
- Shared-project approvals and the project snapshot run on the project's
  owning bay; the snapshot is bounded (5 s) and fails closed.
- The site gate runs on the seed.

The broker (G3b) registers itself with registerFederatedBroker; until it
does, the gate is closed.
*/

import { getServerSettings } from "@cocalc/database/settings/server-settings";
import {
  createInterBayFederatedConnectorClient,
  type FederatedMintRequest,
  type InterBayFederatedConnectorApi,
} from "@cocalc/conat/inter-bay/federated-connector";
import {
  FEDERATED_GATE_SETTING,
  parseFederatedGate,
} from "@cocalc/util/ai/federated-connectors";
import { isValidUUID } from "@cocalc/util/misc";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { getConfiguredClusterSeedBayId } from "@cocalc/server/cluster-config";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { resolveProjectBay } from "@cocalc/server/inter-bay/directory";
import {
  assertLiveTurn,
  assertTrustedSource,
} from "@cocalc/server/agents/cocalc-connector-turn";
import { verifyActiveAgentRun } from "@cocalc/server/agents/identity-routing";
import {
  approveFederatedSharedProjectOnOwningBay,
  federationSnapshotOnOwningBay,
  revokeFederatedSharedProjectOnOwningBay,
  type FederationProjectSnapshot,
} from "./approvals";
import {
  listFederatedConnectorAssignments as listAssignmentsAtHome,
  removeFederatedConnectorAssignment as removeAssignmentAtHome,
  saveFederatedConnectorAssignment as saveAssignmentAtHome,
} from "./assignments";
import type { MintRequest, MintResult } from "./broker";
import { setFederatedConnectorGateOnSeed } from "./site-gate";
import {
  beginFederatedTurn,
  endFederatedTurn,
  FEDERATED_TURN_REFUSED,
  FederatedTurnError,
  reconcileFederatedLeases,
  verifyFederatedLiveTurn,
  type FederatedRunActivity,
  type FederatedTurnDeps,
} from "./turn";

const SNAPSHOT_TIMEOUT_MS = 5_000;

interface RegisteredBroker {
  site_id: string;
  getToken(request: MintRequest): Promise<MintResult>;
}

let broker: RegisteredBroker | undefined;

/** The broker transport (G3b) registers here; unset means the gate is closed. */
export function registerFederatedBroker(next: RegisteredBroker | undefined) {
  broker = next;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(Error("timeout")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** The owning bay's snapshot: bounded, and checked to come from that bay. */
export async function owningBaySnapshot(opts: {
  project_id: string;
  account_id: string;
}): Promise<FederationProjectSnapshot> {
  const ownership = await resolveProjectBay(opts.project_id);
  const bay_id = ownership?.bay_id;
  if (!bay_id) throw Error("project owner is unavailable");
  const snapshot = await withTimeout(
    bay_id === getConfiguredBayId()
      ? federationSnapshotOnOwningBay(opts)
      : createInterBayFederatedConnectorClient(
          getInterBayFabricClient(),
          bay_id,
          SNAPSHOT_TIMEOUT_MS,
        ).snapshot(opts),
    SNAPSHOT_TIMEOUT_MS,
  );
  if (snapshot?.owning_bay_id !== bay_id) {
    throw Error("project owner changed during the snapshot");
  }
  return snapshot;
}

async function gateOpen(): Promise<boolean> {
  if (broker == null) return false;
  const settings = (await getServerSettings()) as Record<string, unknown>;
  return parseFederatedGate(settings[FEDERATED_GATE_SETTING]).includes(
    "gcloud",
  );
}

function turnDeps(): FederatedTurnDeps {
  return {
    assertTrustedSource,
    verifyActiveAgentRun,
    assertLiveTurn,
    gateOpen,
    snapshot: owningBaySnapshot,
    getToken: async (request) => {
      if (broker == null) throw Error("no broker");
      return await broker.getToken(request);
    },
    get site_id() {
      return broker?.site_id ?? "";
    },
  };
}

// The authoritative "run is not active" answer (agents/store.ts activeRun);
// any other failure is unknown and leaves the lease for the next pass.
const RUN_NOT_ACTIVE = "agent credential is expired, revoked, or invalid";

export async function federatedRunActivity(lease: {
  account_id: string;
  agent_id: string;
  project_id: string;
  run_id: string;
}): Promise<FederatedRunActivity> {
  try {
    await verifyActiveAgentRun(lease);
    return "active";
  } catch (err) {
    return `${(err as Error)?.message ?? ""}`.includes(RUN_NOT_ACTIVE)
      ? "ended"
      : "unknown";
  }
}

/** Scheduled (G3b): ends this bay's leases whose runs have ended. */
export async function reconcileFederatedLeasesAtThisBay() {
  return await reconcileFederatedLeases({ runActivity: federatedRunActivity });
}

/** This bay's side of every federated connector call. */
export const federatedConnectorAtThisBay: InterBayFederatedConnectorApi = {
  beginTurn: async (opts) => await beginFederatedTurn(opts, turnDeps()),
  endTurn: async (opts) => await endFederatedTurn(opts, turnDeps()),
  verifyLiveTurn: async (opts: FederatedMintRequest) =>
    await verifyFederatedLiveTurn(opts, turnDeps()),
  listAssignments: listAssignmentsAtHome,
  saveAssignment: saveAssignmentAtHome,
  removeAssignment: removeAssignmentAtHome,
  snapshot: federationSnapshotOnOwningBay,
  approve: approveFederatedSharedProjectOnOwningBay,
  revoke: revokeFederatedSharedProjectOnOwningBay,
  setGate: setFederatedConnectorGateOnSeed,
};

function apiAt(bay_id: string): InterBayFederatedConnectorApi {
  return bay_id === getConfiguredBayId()
    ? federatedConnectorAtThisBay
    : createInterBayFederatedConnectorClient(getInterBayFabricClient(), bay_id);
}

async function accountHome(account_id: unknown) {
  if (typeof account_id !== "string" || !isValidUUID(account_id)) {
    throw Error("authenticated account required");
  }
  const { home_bay_id } = await resolveAccountHomeBay({ account_id });
  if (!home_bay_id) throw Error("account home unavailable");
  return apiAt(home_bay_id);
}

async function owningBay(project_id: unknown) {
  if (typeof project_id !== "string" || !isValidUUID(project_id)) {
    throw Error("invalid project_id");
  }
  const ownership = await resolveProjectBay(project_id);
  if (!ownership?.bay_id) throw Error("project owner is unavailable");
  return apiAt(ownership.bay_id);
}

// Host calls: the request goes to the home bay exactly as received (with
// host_id from the authenticated principal); the turn refuses unknown keys.
async function hostCall<T>(
  input: any,
  fn: (api: InterBayFederatedConnectorApi) => Promise<T>,
): Promise<T> {
  if (!isValidUUID(input?.account_id) || !isValidUUID(input?.host_id)) {
    throw new FederatedTurnError(FEDERATED_TURN_REFUSED);
  }
  return await fn(await accountHome(input.account_id));
}

export const beginFederatedConnectorTurn = async (input: any) =>
  await hostCall(input, (api) => api.beginTurn(input));

export const endFederatedConnectorTurn = async (input: any) =>
  await hostCall(input, (api) => api.endTurn(input));

export const listFederatedConnectorAssignments = async (input: any) =>
  await (
    await accountHome(input?.account_id)
  ).listAssignments({ account_id: input.account_id });

export const saveFederatedConnectorAssignment = async (input: any) =>
  await (await accountHome(input?.account_id)).saveAssignment(input);

export const removeFederatedConnectorAssignment = async (input: any) =>
  await (await accountHome(input?.account_id)).removeAssignment(input);

export const approveFederatedSharedProject = async (input: any) =>
  await (await owningBay(input?.project_id)).approve(input);

export const revokeFederatedSharedProject = async (input: any) =>
  await (await owningBay(input?.project_id)).revoke(input);

export const setFederatedConnectorGate = async (input: any) =>
  await apiAt(getConfiguredClusterSeedBayId()).setGate(input);

/** For the broker transport (G3b): the recheck, on the account's home bay. */
export async function verifyFederatedLiveTurnRouted(
  request: FederatedMintRequest,
): Promise<void> {
  await (await accountHome(request?.account_id)).verifyLiveTurn(request);
}
