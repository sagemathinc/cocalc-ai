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
import { AGENT_RUN_NOT_ACTIVE } from "@cocalc/server/agents/store";
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
import { introspectAccessToken, type TextFetch } from "./google-identity";
import { setFederatedConnectorGateOnSeed } from "./site-gate";
import { checkIssuedToken, TokenClaimsCache } from "./token-check";
import {
  beginFederatedTurn,
  endFederatedTurn,
  FEDERATED_CONNECTOR_UNAVAILABLE,
  FEDERATED_CONNECTORS_DISABLED,
  FEDERATED_TURN_REFUSED,
  FederatedTurnError,
  reconcileFederatedLeases,
  verifyFederatedLiveTurn,
  type FederatedLeaseCursor,
  type FederatedRunActivity,
  type FederatedTurnDeps,
} from "./turn";

const SNAPSHOT_TIMEOUT_MS = 5_000;

// Parsed tokeninfo claims of issued tokens (never a verdict; §6).
const tokenClaimsCache = new TokenClaimsCache();
const googleFetch: TextFetch = async (url, init) => {
  const res = await fetch(url, init);
  return { status: res.status, text: () => res.text() };
};

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
  return parseFederationSnapshot(snapshot, bay_id);
}

const SNAPSHOT_KEYS = [
  "owning_bay_id",
  "users_revision",
  "account_role",
  "other_members",
  "pending_invites",
  "approval_id",
];
const ROLES = new Set(["owner", "collaborator", "viewer"]);
const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;

/**
 * A snapshot exactly as the owning bay produces it, from the bay that owns
 * the project; anything else throws (and the caller fails closed).
 */
export function parseFederationSnapshot(
  value: unknown,
  bay_id: string,
): FederationProjectSnapshot {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw Error("malformed project snapshot");
  }
  const keys = Object.keys(value);
  const s = value as Record<string, unknown>;
  if (
    keys.length !== SNAPSHOT_KEYS.length ||
    !SNAPSHOT_KEYS.every((k) => keys.includes(k)) ||
    !count(s.users_revision) ||
    !count(s.other_members) ||
    !count(s.pending_invites) ||
    !(s.account_role === null || ROLES.has(s.account_role as string)) ||
    !(s.approval_id === null || isValidUUID(s.approval_id))
  ) {
    throw Error("malformed project snapshot");
  }
  if (s.owning_bay_id !== bay_id) {
    throw Error("project owner changed during the snapshot");
  }
  return s as unknown as FederationProjectSnapshot;
}

async function gateOpen(): Promise<boolean> {
  if (broker == null) return false;
  const settings = (await getServerSettings()) as Record<string, unknown>;
  return parseFederatedGate(settings[FEDERATED_GATE_SETTING]).includes(
    "gcloud",
  );
}

/** The turn's real dependencies on this bay. */
export function federatedTurnDeps(): FederatedTurnDeps {
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
    checkIssuedToken: async (issued, grant) =>
      await checkIssuedToken({
        issued,
        grant,
        cache: tokenClaimsCache,
        introspect: (token) => introspectAccessToken(googleFetch, token),
      }),
    get site_id() {
      return broker?.site_id ?? "";
    },
  };
}

// The authoritative "run is not active" answer is agents/store.ts activeRun's
// error; any other failure is unknown and leaves the lease for the next pass.

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
    // Exactly the store's answer, locally or as an inter-bay service error
    // (which arrives stringified, "Error: <message>"); never a near match.
    const message = (err as Error)?.message;
    return message === AGENT_RUN_NOT_ACTIVE ||
      message === `Error: ${AGENT_RUN_NOT_ACTIVE}`
      ? "ended"
      : "unknown";
  }
}

let reconcileCursor: FederatedLeaseCursor | undefined;

/**
 * Scheduled (G3b): ends this bay's leases whose runs have ended. Each pass
 * continues after the last lease the previous pass checked, so leases that
 * stay active can't keep newer candidates from being reached.
 */
export async function reconcileFederatedLeasesAtThisBay() {
  const result = await reconcileFederatedLeases({
    runActivity: federatedRunActivity,
    after: reconcileCursor,
  });
  reconcileCursor = result.next;
  return result;
}

/** This bay's side of every federated connector call. */
export const federatedConnectorAtThisBay: InterBayFederatedConnectorApi = {
  beginTurn: async (opts) =>
    await beginFederatedTurn(opts, federatedTurnDeps()),
  endTurn: async (opts) => await endFederatedTurn(opts, federatedTurnDeps()),
  verifyLiveTurn: async (opts: FederatedMintRequest) =>
    await verifyFederatedLiveTurn(opts, federatedTurnDeps()),
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

const FIXED_CODES = new Set([
  FEDERATED_TURN_REFUSED,
  FEDERATED_CONNECTORS_DISABLED,
  FEDERATED_CONNECTOR_UNAVAILABLE,
]);

// Host calls: the request goes to the home bay exactly as received (with
// host_id from the authenticated principal); the turn refuses unknown keys.
// The host only ever sees a fixed code: one that came back from the home bay
// (matched exactly; an inter-bay error isn't an instance) or, for any other
// failure on the way (home lookup, transport, timeout), unavailable.
async function hostCall<T>(
  input: any,
  fn: (api: InterBayFederatedConnectorApi) => Promise<T>,
): Promise<T> {
  if (!isValidUUID(input?.account_id) || !isValidUUID(input?.host_id)) {
    throw new FederatedTurnError(FEDERATED_TURN_REFUSED);
  }
  try {
    return await fn(await accountHome(input.account_id));
  } catch (err) {
    // A code from the home bay arrives as itself (local) or stringified by
    // the inter-bay service ("Error: <code>"); nothing else is kept.
    const message = (err as Error)?.message;
    const code =
      typeof message === "string" && message.startsWith("Error: ")
        ? message.slice("Error: ".length)
        : message;
    throw new FederatedTurnError(
      typeof code === "string" && FIXED_CODES.has(code)
        ? code
        : FEDERATED_CONNECTOR_UNAVAILABLE,
    );
  }
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
