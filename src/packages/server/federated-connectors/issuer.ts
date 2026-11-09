/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// The federated connector OIDC issuer: short signed assertions for one
// lease, the JWKS of the enabled signing keys and the discovery document.
// An assertion is valid for at most MAX_ASSERTION_LIFETIME_S, names one
// provider exactly, and carries opaque ids only.

import { createHash, createPublicKey, randomUUID } from "node:crypto";
import {
  FEDERATION_ATTRIBUTE_CLAIMS,
  FEDERATION_ISSUER_PATH,
  MAX_ASSERTION_LIFETIME_S,
  isUuid,
  validateFederationAttributes,
  wifAssertionAudience,
  type FederationAttributes,
  type WifProvider,
} from "@cocalc/util/ai/federated-connectors";
import { federationKeyId, type FederationSigner } from "./signer";

/** Refuse to sign when the local clock is off by more than this. */
export const MAX_CLOCK_SKEW_MS = 30_000;

const ISSUER_RE = new RegExp(
  `^https://[a-z0-9.-]+(:[0-9]{1,5})?${FEDERATION_ISSUER_PATH.replace(/\//g, "\\/")}$`,
);

export function isFederationIssuer(value: unknown): value is string {
  return typeof value === "string" && ISSUER_RE.test(value);
}

function base64url(data: Buffer | string): string {
  return Buffer.from(data).toString("base64url");
}

/**
 * Checks the local clock against a trusted reference time (for example the
 * Date header of a Google API response). Throws if the skew is too large or
 * either time is unusable.
 */
export function assertClockWithinSkew({
  localNow,
  referenceNow,
  maxSkewMs = MAX_CLOCK_SKEW_MS,
}: {
  localNow: number;
  referenceNow: number;
  maxSkewMs?: number;
}): void {
  if (!Number.isFinite(localNow) || !Number.isFinite(referenceNow)) {
    throw Error("clock check failed: no usable time");
  }
  if (Math.abs(localNow - referenceNow) > maxSkewMs) {
    throw Error("clock check failed: local clock skew too large");
  }
}

export interface AssertionRequest {
  issuer: string;
  provider: WifProvider;
  attributes: FederationAttributes;
  /** Milliseconds since epoch, from a checked clock. */
  now: number;
  lifetimeSeconds?: number;
  jti?: string;
}

export interface SignedAssertion {
  /** The compact JWS. Short-lived; never logged or stored. */
  assertion: string;
  jti: string;
  kid: string;
  keyVersion: string;
  issuedAt: number;
  expiresAt: number;
}

/** The exact claims of one assertion, after every check. */
export function assertionClaims({
  issuer,
  provider,
  attributes,
  now,
  lifetimeSeconds = MAX_ASSERTION_LIFETIME_S,
  jti,
}: AssertionRequest & { jti: string }): Record<string, string | number> {
  if (!isFederationIssuer(issuer)) throw Error("invalid issuer");
  const attrs = validateFederationAttributes(attributes);
  if (!isUuid(jti)) throw Error("invalid jti");
  if (
    !Number.isInteger(lifetimeSeconds) ||
    lifetimeSeconds < 1 ||
    lifetimeSeconds > MAX_ASSERTION_LIFETIME_S
  ) {
    throw Error("invalid assertion lifetime");
  }
  if (!Number.isSafeInteger(now) || now <= 0) throw Error("invalid time");
  const iat = Math.floor(now / 1000);
  const claims: Record<string, string | number> = {
    iss: issuer,
    aud: wifAssertionAudience(provider),
    sub: attrs.lease_id,
    iat,
    exp: iat + lifetimeSeconds,
    jti,
  };
  for (const name of FEDERATION_ATTRIBUTE_CLAIMS) {
    claims[name] = attrs[name];
  }
  return claims;
}

/** Signs one assertion with the issuer key. */
export async function signAssertion(
  signer: FederationSigner,
  request: AssertionRequest,
): Promise<SignedAssertion> {
  const jti = request.jti ?? randomUUID();
  const claims = assertionClaims({ ...request, jti });
  if (signer.algorithm !== "RS256") throw Error("unsupported algorithm");
  const kid = federationKeyId(signer.keyVersion);
  const header = { alg: signer.algorithm, typ: "JWT", kid };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(claims),
  )}`;
  const digest = createHash("sha256").update(signingInput).digest();
  const signature = await signer.signDigest(digest);
  return {
    assertion: `${signingInput}.${base64url(signature)}`,
    jti,
    kid,
    keyVersion: signer.keyVersion,
    issuedAt: (claims.iat as number) * 1000,
    expiresAt: (claims.exp as number) * 1000,
  };
}

export interface JsonWebKeySet {
  keys: {
    kty: "RSA";
    n: string;
    e: string;
    alg: "RS256";
    use: "sig";
    kid: string;
  }[];
}

/**
 * The JWKS of the given enabled key versions. Only RSA 2048 public keys are
 * accepted; a duplicate key id is refused.
 */
export function buildJwks(
  versions: { keyVersion: string; publicKeyPem: string }[],
): JsonWebKeySet {
  const keys: JsonWebKeySet["keys"] = [];
  const seen = new Set<string>();
  for (const { keyVersion, publicKeyPem } of versions) {
    const key = createPublicKey(publicKeyPem);
    if (
      key.type !== "public" ||
      key.asymmetricKeyType !== "rsa" ||
      key.asymmetricKeyDetails?.modulusLength !== 2048
    ) {
      throw Error("issuer keys must be RSA 2048 public keys");
    }
    const jwk = key.export({ format: "jwk" }) as { n?: string; e?: string };
    if (!jwk.n || !jwk.e) throw Error("invalid public key");
    const kid = federationKeyId(keyVersion);
    if (seen.has(kid)) throw Error("duplicate key id");
    seen.add(kid);
    keys.push({
      kty: "RSA",
      n: jwk.n,
      e: jwk.e,
      alg: "RS256",
      use: "sig",
      kid,
    });
  }
  return { keys };
}

/** The OpenID discovery document of the issuer. */
export function discoveryDocument(issuer: string) {
  if (!isFederationIssuer(issuer)) throw Error("invalid issuer");
  return {
    issuer,
    jwks_uri: `${issuer}/jwks.json`,
    response_types_supported: ["id_token"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    claims_supported: [
      "iss",
      "aud",
      "sub",
      "iat",
      "exp",
      "jti",
      ...FEDERATION_ATTRIBUTE_CLAIMS,
    ],
  };
}
