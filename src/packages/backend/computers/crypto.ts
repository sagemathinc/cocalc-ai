/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Keys, fingerprints and signatures for the computers protocol (Node only).
// Plan: src/.agents/computers-plan-2026-10-11.md ("Enrollment and the
// daemon's identity"). The objects and their checks are in
// @cocalc/util/computers/protocol.
//
// - A machine has two keys: Ed25519 to sign, X25519 for key agreement
//   (never one key for both).
// - A fingerprint is "sha256:" + base64url(sha256(DER SPKI public key)).
// - Every signature covers signingInput(kind, payload): canonical JSON with a
//   domain-separation prefix, so a signature over one kind of object can't be
//   replayed as another.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { canonicalJson, signingInput } from "@cocalc/util/computers/canonical";
import { pairingPhrase } from "@cocalc/util/computers/pairing-phrase";
import type { ComputerPolicy } from "@cocalc/util/computers/policy";
import type {
  PairingTranscript,
  SignedEnvelope,
} from "@cocalc/util/computers/protocol";

export interface KeyPair {
  publicKey: KeyObject;
  privateKey: KeyObject;
  /** base64url DER (SPKI) of the public key */
  publicDer: string;
  fingerprint: string;
}

export function generateSigningKey(): KeyPair {
  return describe(generateKeyPairSync("ed25519"));
}

export function generateAgreementKey(): KeyPair {
  return describe(generateKeyPairSync("x25519"));
}

function describe({
  publicKey,
  privateKey,
}: {
  publicKey: KeyObject;
  privateKey: KeyObject;
}): KeyPair {
  const der = publicKey.export({ type: "spki", format: "der" });
  return {
    publicKey,
    privateKey,
    publicDer: der.toString("base64url"),
    fingerprint: fingerprintOfDer(der),
  };
}

export function fingerprintOfDer(der: Buffer): string {
  return `sha256:${createHash("sha256").update(der).digest("base64url")}`;
}

export function fingerprintOf(key: KeyObject): string {
  return fingerprintOfDer(key.export({ type: "spki", format: "der" }));
}

/** An Ed25519 public key from base64url DER (SPKI); anything else is refused. */
export function signingPublicKeyFromDer(publicDer: string): KeyObject {
  const key = createPublicKey({
    key: Buffer.from(publicDer, "base64url"),
    format: "der",
    type: "spki",
  });
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("not an Ed25519 public key");
  }
  return key;
}

export function privateKeyToPem(key: KeyObject): string {
  return key.export({ type: "pkcs8", format: "pem" }).toString();
}

export function privateKeyFromPem(pem: string): KeyObject {
  return createPrivateKey(pem);
}

/** A key pair from its private key (PEM), e.g. as stored on the computer. */
export function keyPairFromPrivatePem(pem: string): KeyPair {
  const privateKey = createPrivateKey(pem);
  return describe({ privateKey, publicKey: createPublicKey(privateKey) });
}

/** "sha256:" + base64url digest of a value's canonical JSON. */
export function canonicalHash(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(value))
    .digest("base64url")}`;
}

/** The hash a ticket names for a policy (the ceiling, or an effective one). */
export function policyHash(policy: ComputerPolicy): string {
  return canonicalHash(policy);
}

/** The hash of an operation's canonical request, named in its ticket. */
export function requestHash(request: unknown): string {
  return canonicalHash(request);
}

export function transcriptHash(transcript: PairingTranscript): string {
  return canonicalHash(transcript);
}

/** The phrase shown on the machine and on the approval card. */
export function transcriptPairingPhrase(transcript: PairingTranscript): string {
  const digest = createHash("sha256")
    .update(canonicalJson(transcript))
    .digest();
  return pairingPhrase(new Uint8Array(digest));
}

export function randomNonce(): string {
  return randomBytes(32).toString("base64url");
}

export function signEnvelope<T>(
  kind: string,
  payload: T,
  key: KeyPair,
): SignedEnvelope<T> {
  if (key.privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("only Ed25519 keys sign");
  }
  const sig = cryptoSign(
    null,
    Buffer.from(signingInput(kind, payload), "utf8"),
    key.privateKey,
  );
  return { kid: key.fingerprint, payload, sig: sig.toString("base64url") };
}

/**
 * Verify an envelope against the keys trusted for this kind, looked up by
 * kid. The key must also hash to that kid, so a key set can't map a kid to a
 * different key.
 */
export function verifyEnvelope<T>(
  kind: string,
  envelope: SignedEnvelope<T>,
  trusted: (kid: string) => KeyObject | undefined,
): boolean {
  const key = trusted(envelope.kid);
  if (key == null || key.asymmetricKeyType !== "ed25519") return false;
  if (fingerprintOf(key) !== envelope.kid) return false;
  let sig: Buffer;
  try {
    sig = Buffer.from(envelope.sig, "base64url");
  } catch {
    return false;
  }
  if (sig.length !== 64) return false;
  try {
    return cryptoVerify(
      null,
      Buffer.from(signingInput(kind, envelope.payload), "utf8"),
      key,
      sig,
    );
  } catch {
    return false;
  }
}

/**
 * Proof of possession: the requester signs the operation's request hash and
 * ticket id with the per-request key named in the ticket. It protects
 * tickets in transit; it is NOT a boundary between processes of one project
 * (see "Trust boundaries" in the plan).
 */
export function signProofOfPossession(
  key: KeyPair,
  ticket_id: string,
  request_hash: string,
): string {
  return cryptoSign(
    null,
    Buffer.from(
      signingInput("proof-of-possession", { ticket_id, request_hash }),
      "utf8",
    ),
    key.privateKey,
  ).toString("base64url");
}

export function verifyProofOfPossession(
  pop_key: string,
  ticket_id: string,
  request_hash: string,
  proof: string,
): boolean {
  try {
    const key = signingPublicKeyFromDer(pop_key);
    const sig = Buffer.from(proof, "base64url");
    if (sig.length !== 64) return false;
    return cryptoVerify(
      null,
      Buffer.from(
        signingInput("proof-of-possession", { ticket_id, request_hash }),
        "utf8",
      ),
      key,
      sig,
    );
  } catch {
    return false;
  }
}
