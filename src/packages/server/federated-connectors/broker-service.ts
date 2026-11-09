/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
The broker service between bays and the token broker (G3b design v3 §3 and
the v3.1 amendment).

- Bays call `mint(MintRequest)` and `publicKeys()` on the broker's subject.
- The broker accepts a mint only from the account's home bay, as
  authenticated by the fabric (context.caller, never the request), and does
  no other work otherwise.
- Every mint reply echoes request_sha256, the sha256 of the canonical JSON of
  the exact request. The requesting bay compares it before accepting the
  strictly parsed result; anything malformed or mis-correlated is treated as
  unavailable. publicKeys() replies are strictly shaped and bounded.

Nothing here logs reply subjects, correlations or tokens.
*/

import { createHash } from "node:crypto";
import { canonicalJson, isUuid } from "@cocalc/util/ai/federated-connectors";
import type { MintGuard, MintRequest, MintResult } from "./broker";

export const BROKER_PUBLIC_KEYS_MAX_BYTES = 16 * 1024;
const MAX_KEYS = 8;
const REASON_RE = /^[a-z_]{1,64}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const KEY_VERSION_RE =
  /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/locations\/[a-z0-9-]{1,63}\/keyRings\/[A-Za-z0-9_-]{1,63}\/cryptoKeys\/[A-Za-z0-9_-]{1,63}\/cryptoKeyVersions\/[1-9][0-9]{0,9}$/;

const MINT_REQUEST_KEYS = [
  "site_id",
  "account_id",
  "agent_id",
  "project_id",
  "host_id",
  "run_id",
  "grant_id",
  "lease_id",
  "grant_revision",
];

function exactKeys(value: unknown, keys: readonly string[]): value is object {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => own.includes(k));
}

/** A mint request, exactly; undefined otherwise. */
export function parseMintRequest(value: unknown): MintRequest | undefined {
  if (!exactKeys(value, MINT_REQUEST_KEYS)) return;
  const v = value as Record<string, unknown>;
  for (const key of MINT_REQUEST_KEYS) {
    if (key === "grant_revision") continue;
    if (!isUuid(v[key])) return;
  }
  if (
    !Number.isSafeInteger(v.grant_revision) ||
    (v.grant_revision as number) < 1
  ) {
    return;
  }
  return v as unknown as MintRequest;
}

/** The correlation of a mint reply: sha256 of the request's canonical JSON. */
export function mintRequestSha256(request: MintRequest): string {
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
}

export interface MintEnvelope {
  request_sha256: string;
  result: MintResult;
}

const ISSUED_KEYS = [
  "status",
  "token",
  "expires_at",
  "grant_revision",
  "connection_id",
  "project",
  "sa_label",
];

function parseMintResult(value: unknown): MintResult | undefined {
  const v = value as Record<string, unknown> | null;
  if (v == null || typeof v !== "object" || Array.isArray(v)) return;
  if (v.status === "issued") {
    if (!exactKeys(v, ISSUED_KEYS)) return;
    if (
      typeof v.token !== "string" ||
      v.token.length === 0 ||
      v.token.length > 8192 ||
      !/^[\x21-\x7e]+$/.test(v.token) ||
      !Number.isSafeInteger(v.expires_at) ||
      !Number.isSafeInteger(v.grant_revision) ||
      !isUuid(v.connection_id) ||
      typeof v.project !== "string" ||
      typeof v.sa_label !== "string"
    ) {
      return;
    }
    return v as unknown as MintResult;
  }
  if (v.status === "denied") {
    if (!exactKeys(v, ["status", "reason"])) return;
    if (typeof v.reason !== "string" || !REASON_RE.test(v.reason)) return;
    return v as unknown as MintResult;
  }
  if (v.status === "error") {
    const keys = Object.keys(v);
    if (
      !(
        exactKeys(v, ["status", "reason"]) ||
        exactKeys(v, ["status", "reason", "retry_after_ms"])
      )
    ) {
      return;
    }
    if (typeof v.reason !== "string" || !REASON_RE.test(v.reason)) return;
    if (
      keys.includes("retry_after_ms") &&
      (!Number.isSafeInteger(v.retry_after_ms) ||
        (v.retry_after_ms as number) < 0)
    ) {
      return;
    }
    return v as unknown as MintResult;
  }
}

/**
 * The broker's reply to `request`, or undefined when it isn't exactly a
 * well-formed envelope for this very request (correlation and, for an issued
 * token, the grant revision).
 */
export function parseMintEnvelope(
  value: unknown,
  request: MintRequest,
): MintResult | undefined {
  if (!exactKeys(value, ["request_sha256", "result"])) return;
  const v = value as Record<string, unknown>;
  if (
    typeof v.request_sha256 !== "string" ||
    !HEX64_RE.test(v.request_sha256)
  ) {
    return;
  }
  if (v.request_sha256 !== mintRequestSha256(request)) return;
  const result = parseMintResult(v.result);
  if (result == null) return;
  if (
    result.status === "issued" &&
    result.grant_revision !== request.grant_revision
  ) {
    return;
  }
  return result;
}

export interface PublicKeyEntry {
  /** The KMS key version's resource name. */
  version: string;
  /** The DER SubjectPublicKeyInfo, base64. */
  spki_der_b64: string;
}

/** A publicKeys() reply, exactly and within 16 KiB; undefined otherwise. */
export function parsePublicKeys(value: unknown): PublicKeyEntry[] | undefined {
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(value) ?? "");
  } catch {
    return;
  }
  if (size > BROKER_PUBLIC_KEYS_MAX_BYTES) return;
  if (!exactKeys(value, ["keys"])) return;
  const keys = (value as { keys: unknown }).keys;
  if (!Array.isArray(keys) || keys.length > MAX_KEYS) return;
  const seen = new Set<string>();
  for (const k of keys) {
    if (!exactKeys(k, ["version", "spki_der_b64"])) return;
    const { version, spki_der_b64 } = k as Record<string, unknown>;
    if (typeof version !== "string" || !KEY_VERSION_RE.test(version)) return;
    if (
      typeof spki_der_b64 !== "string" ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(spki_der_b64) ||
      spki_der_b64.length > 2048
    ) {
      return;
    }
    if (seen.has(version)) return;
    seen.add(version);
  }
  return keys as PublicKeyEntry[];
}

// ---------------------------------------------------------------------------
// The broker's side.

/** The fabric-authenticated caller (from the conat server, never the request). */
export interface BrokerServiceCaller {
  cluster_id?: string;
  bay_id?: string;
  bay_credential_id?: string;
}

export class BrokerServiceRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BrokerServiceRefusal";
  }
}

export interface BrokerServiceCounters {
  refused_caller: number;
  refused_request: number;
  not_home_bay: number;
}

export function createBrokerServiceHandler({
  clusterId,
  homeBayOf,
  getToken,
  publicKeys,
}: {
  clusterId: string;
  /** The account's home bay, from the directory. */
  homeBayOf(account_id: string): Promise<string | undefined>;
  getToken(request: MintRequest, guard: MintGuard): Promise<MintResult>;
  publicKeys(): Promise<PublicKeyEntry[]>;
}) {
  const counters: BrokerServiceCounters = {
    refused_caller: 0,
    refused_request: 0,
    not_home_bay: 0,
  };

  function requireBay(caller: BrokerServiceCaller | undefined): string {
    if (
      caller?.cluster_id !== clusterId ||
      typeof caller.bay_id !== "string" ||
      caller.bay_id.length === 0 ||
      typeof caller.bay_credential_id !== "string" ||
      caller.bay_credential_id.length === 0
    ) {
      counters.refused_caller += 1;
      throw new BrokerServiceRefusal("caller_refused");
    }
    return caller.bay_id;
  }

  return {
    counters,
    async mint(
      input: unknown,
      caller: BrokerServiceCaller | undefined,
    ): Promise<MintEnvelope> {
      const bay_id = requireBay(caller);
      const request = parseMintRequest(input);
      if (request == null) {
        counters.refused_request += 1;
        throw new BrokerServiceRefusal("request_refused");
      }
      let home: string | undefined;
      try {
        home = await homeBayOf(request.account_id);
      } catch {
        home = undefined;
      }
      if (home == null || home !== bay_id) {
        // Only the account's home bay may ask: no Google call, no lookup.
        counters.not_home_bay += 1;
        throw new BrokerServiceRefusal("not_home_bay");
      }
      // The final check (v3.3.2) asks the directory again after the mint,
      // inside the broker core, before anything is cached or returned.
      const guard: MintGuard = {
        scope: bay_id,
        confirmHome: async () =>
          (await homeBayOf(request.account_id)) === bay_id,
      };
      return {
        request_sha256: mintRequestSha256(request),
        result: await getToken(request, guard),
      };
    },
    async publicKeys(
      caller: BrokerServiceCaller | undefined,
    ): Promise<{ keys: PublicKeyEntry[] }> {
      requireBay(caller);
      const keys = await publicKeys();
      const reply = { keys };
      if (parsePublicKeys(reply) == null) {
        throw new BrokerServiceRefusal("public_keys_unavailable");
      }
      return reply;
    },
  };
}

// ---------------------------------------------------------------------------
// The bay's side.

/**
 * The bay's client: a transport call to the broker plus strict checking of
 * every reply. A malformed or mis-correlated reply is an error result (the
 * turn maps it to unavailable), never an issued token.
 */
export function createBrokerMintClient(
  call: (method: "mint" | "publicKeys", args: unknown[]) => Promise<unknown>,
) {
  return {
    async getToken(request: MintRequest): Promise<MintResult> {
      let reply: unknown;
      try {
        reply = await call("mint", [request]);
      } catch {
        return { status: "error", reason: "broker_unavailable" };
      }
      return (
        parseMintEnvelope(reply, request) ?? {
          status: "error",
          reason: "broker_reply_invalid",
        }
      );
    },
    async publicKeys(): Promise<PublicKeyEntry[]> {
      const keys = parsePublicKeys(await call("publicKeys", []));
      if (keys == null) throw Error("public_keys_invalid");
      return keys;
    },
  };
}
