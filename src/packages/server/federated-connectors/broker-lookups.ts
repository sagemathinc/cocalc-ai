/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
A bay's answers to the token broker (G3b design v3 §3, v3.3): exactly four
lookups on bay.<id>.rpc.federated-broker.v1.

- loadGrant: the grant and its connection (on the account's home bay);
- verifyLiveTurn: the turn recheck before every mint (G4b);
- isAllowlisted: the site allowlist (only the seed answers);
- homeBay: an account's home bay and nothing else (only the seed answers),
  for the broker's home-bay binding of each mint.

Only the broker may ask: the caller must carry exactly the broker stamp the
conat server sets for a verified broker connection, equal to the signer
record now (a rotated signer is refused). Requests are parsed strictly;
errors are fixed codes.
*/

import {
  isGcpProjectId,
  isGcpServiceAccount,
  isPermissionProfile,
  isUuid,
} from "@cocalc/util/ai/federated-connectors";
import { isGoogleUniqueId } from "./google-identity";
import type { BrokerDeps, MintRequest } from "./broker";
import { parseMintRequest } from "./broker-service";

export const BROKER_LOOKUP_METHODS = [
  "loadGrant",
  "verifyLiveTurn",
  "isAllowlisted",
  "homeBay",
] as const;
export type BrokerLookupMethod = (typeof BROKER_LOOKUP_METHODS)[number];

export class BrokerLookupRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BrokerLookupRefusal";
  }
}

function exactKeys(value: unknown, keys: readonly string[]): value is object {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => own.includes(k));
}

const BAY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function isBayId(value: unknown): value is string {
  return typeof value === "string" && BAY_ID_RE.test(value);
}

/** The broker's strict reading of a homeBay reply. */
export function parseHomeBayReply(value: unknown): string | undefined {
  if (!exactKeys(value, ["home_bay_id"])) return;
  const { home_bay_id } = value as { home_bay_id: unknown };
  return isBayId(home_bay_id) ? home_bay_id : undefined;
}

/** Requires exactly the broker's stamp, for the signer recorded now. */
export function requireBrokerCaller(
  caller: unknown,
  currentSignerId: string | undefined,
): void {
  if (
    !exactKeys(caller, ["federated_broker_signer_id"]) ||
    !isGoogleUniqueId(
      (caller as { federated_broker_signer_id: unknown })
        .federated_broker_signer_id,
    ) ||
    currentSignerId == null ||
    (caller as { federated_broker_signer_id: string })
      .federated_broker_signer_id !== currentSignerId
  ) {
    throw new BrokerLookupRefusal("caller_refused");
  }
}

export function createBrokerLookupHandler({
  currentSignerId,
  loadGrant,
  verifyLiveTurn,
  isAllowlisted,
  isSeedBay,
  homeBayOf,
}: {
  currentSignerId: () => Promise<string | undefined>;
  loadGrant: BrokerDeps["loadGrant"];
  verifyLiveTurn: (request: MintRequest) => Promise<void>;
  isAllowlisted: BrokerDeps["isAllowlisted"];
  isSeedBay: () => boolean;
  /** The account's home bay id, or undefined if unknown. */
  homeBayOf: (account_id: string) => Promise<string | undefined>;
}) {
  return async function handle(
    method: unknown,
    args: unknown,
    caller: unknown,
  ): Promise<unknown> {
    requireBrokerCaller(caller, await currentSignerId());
    if (!Array.isArray(args) || args.length !== 1) {
      throw new BrokerLookupRefusal("request_refused");
    }
    const [input] = args;
    if (method === "loadGrant") {
      if (
        !exactKeys(input, ["account_id", "grant_id"]) ||
        !isUuid((input as any).account_id) ||
        !isUuid((input as any).grant_id)
      ) {
        throw new BrokerLookupRefusal("request_refused");
      }
      return await loadGrant(input as { account_id: string; grant_id: string });
    }
    if (method === "verifyLiveTurn") {
      const request = parseMintRequest(input);
      if (request == null) throw new BrokerLookupRefusal("request_refused");
      try {
        await verifyLiveTurn(request);
      } catch {
        // The broker records turn_not_live; no detail crosses the fabric.
        throw new BrokerLookupRefusal("turn_not_live");
      }
      return { live: true };
    }
    if (method === "isAllowlisted") {
      const v = input as Record<string, unknown>;
      if (
        !exactKeys(input, [
          "provider",
          "service_account",
          "permission_profile",
          "target_project",
        ]) ||
        v.provider !== "gcp" ||
        !isGcpServiceAccount(v.service_account) ||
        !isPermissionProfile(v.permission_profile) ||
        !isGcpProjectId(v.target_project)
      ) {
        throw new BrokerLookupRefusal("request_refused");
      }
      if (!isSeedBay()) throw new BrokerLookupRefusal("not_seed_bay");
      return { allowlisted: await isAllowlisted(v as any) };
    }
    if (method === "homeBay") {
      if (
        !exactKeys(input, ["account_id"]) ||
        !isUuid((input as any).account_id)
      ) {
        throw new BrokerLookupRefusal("request_refused");
      }
      if (!isSeedBay()) throw new BrokerLookupRefusal("not_seed_bay");
      let home_bay_id: string | undefined;
      try {
        home_bay_id = await homeBayOf((input as any).account_id);
      } catch {
        home_bay_id = undefined;
      }
      if (!isBayId(home_bay_id)) {
        throw new BrokerLookupRefusal("account_unknown");
      }
      return { home_bay_id };
    }
    throw new BrokerLookupRefusal("unknown_method");
  };
}
