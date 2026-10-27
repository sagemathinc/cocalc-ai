/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Encryption envelope for escrowed GPU provider API keys (bring-your-own-key).
//
// AES-256-GCM under a key derived from the site master keyring for the
// "gpu-provider-credentials:v1" purpose. The additional authenticated data
// binds every ciphertext to its credential row: a canonical, length-prefixed
// encoding of the envelope version, credential id, owner account and
// provider. A ciphertext copied to another row, owner or provider fails to
// decrypt. Mutable placement (such as the home bay) is deliberately not
// bound, so a rehomed account's credentials still decrypt.
//
// Decryption fails closed: an unknown version, a key id not in the keyring,
// malformed fields or any authentication failure all throw, with messages
// that never include secret material.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { DerivedSiteKey } from "@cocalc/util/master-key-lifecycle";

export const GPU_CREDENTIAL_PURPOSE = "gpu-provider-credentials:v1";
export const GPU_CREDENTIAL_ENVELOPE_VERSION = 1;

const AAD_DOMAIN = "cocalc-gpu-provider-credential";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_SECRET_BYTES = 4096;

export interface GpuCredentialBinding {
  credentialId: string;
  ownerAccountId: string;
  provider: string;
}

// Stored alongside the row; none of these fields is secret on its own.
export interface GpuCredentialEnvelope {
  envelope_version: number;
  key_id: string;
  nonce: string; // base64
  tag: string; // base64
  ciphertext: string; // base64
}

export class GpuCredentialEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GpuCredentialEnvelopeError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROVIDER = /^[a-z][a-z0-9-]{0,31}$/;

export function normalizeBinding(
  binding: GpuCredentialBinding,
): GpuCredentialBinding {
  const credentialId = `${binding.credentialId ?? ""}`.trim().toLowerCase();
  const ownerAccountId = `${binding.ownerAccountId ?? ""}`.trim().toLowerCase();
  const provider = `${binding.provider ?? ""}`.trim().toLowerCase();
  if (!UUID.test(credentialId)) {
    throw new GpuCredentialEnvelopeError("invalid credential id");
  }
  if (!UUID.test(ownerAccountId)) {
    throw new GpuCredentialEnvelopeError("invalid owner account id");
  }
  if (!PROVIDER.test(provider)) {
    throw new GpuCredentialEnvelopeError("invalid provider");
  }
  return { credentialId, ownerAccountId, provider };
}

// Each field is a 4-byte big-endian length followed by its UTF-8 bytes, so no
// choice of field values can make two different bindings encode the same.
export function credentialAad(
  binding: GpuCredentialBinding,
  version: number = GPU_CREDENTIAL_ENVELOPE_VERSION,
): Buffer {
  const b = normalizeBinding(binding);
  const fields = [
    AAD_DOMAIN,
    `${version}`,
    b.credentialId,
    b.ownerAccountId,
    b.provider,
  ];
  return Buffer.concat(
    fields.flatMap((field) => {
      const bytes = Buffer.from(field, "utf8");
      const len = Buffer.alloc(4);
      len.writeUInt32BE(bytes.length);
      return [len, bytes];
    }),
  );
}

export function encryptGpuCredential(
  binding: GpuCredentialBinding,
  secret: string,
  key: DerivedSiteKey,
): GpuCredentialEnvelope {
  if (typeof secret !== "string" || secret.length === 0) {
    throw new GpuCredentialEnvelopeError("secret is required");
  }
  if (Buffer.byteLength(secret, "utf8") > MAX_SECRET_BYTES) {
    throw new GpuCredentialEnvelopeError("secret is too long");
  }
  checkKey(key);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key.key, nonce, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(credentialAad(binding));
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  return {
    envelope_version: GPU_CREDENTIAL_ENVELOPE_VERSION,
    key_id: key.id,
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export interface DecryptedGpuCredential {
  secret: string;
  // True when the key that worked is not the active one: re-encrypt under
  // the active key (key rotation).
  needsRewrap: boolean;
}

export function decryptGpuCredential(
  binding: GpuCredentialBinding,
  envelope: GpuCredentialEnvelope,
  keys: DerivedSiteKey[],
): DecryptedGpuCredential {
  if (envelope?.envelope_version !== GPU_CREDENTIAL_ENVELOPE_VERSION) {
    throw new GpuCredentialEnvelopeError("unsupported credential envelope");
  }
  // Only the key the envelope names: no trying other keys, so a mislabeled
  // envelope fails rather than silently decrypting.
  const key = keys.find((k) => k.id === envelope.key_id);
  if (!key) {
    throw new GpuCredentialEnvelopeError(
      "credential encryption key is not available",
    );
  }
  checkKey(key);
  const nonce = decodeBase64(envelope.nonce, NONCE_BYTES);
  const tag = decodeBase64(envelope.tag, TAG_BYTES);
  const ciphertext = decodeBase64(envelope.ciphertext);
  if (ciphertext.length === 0) {
    throw new GpuCredentialEnvelopeError("malformed credential envelope");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key.key, nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(credentialAad(binding, envelope.envelope_version));
    decipher.setAuthTag(tag);
    const secret = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
    return { secret, needsRewrap: key.role !== "active" };
  } catch {
    throw new GpuCredentialEnvelopeError(
      "credential failed authentication (wrong row, owner, provider or key)",
    );
  }
}

function checkKey(key: DerivedSiteKey): void {
  if (!key || !Buffer.isBuffer(key.key) || key.key.length !== 32 || !key.id) {
    throw new GpuCredentialEnvelopeError("invalid encryption key");
  }
}

function decodeBase64(value: unknown, expectedBytes?: number): Buffer {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value) ||
    value.length % 4 !== 0
  ) {
    throw new GpuCredentialEnvelopeError("malformed credential envelope");
  }
  const buf = Buffer.from(value, "base64");
  if (expectedBytes != null && buf.length !== expectedBytes) {
    throw new GpuCredentialEnvelopeError("malformed credential envelope");
  }
  return buf;
}
