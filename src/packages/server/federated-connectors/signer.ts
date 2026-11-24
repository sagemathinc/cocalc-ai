/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// The signing key of the federated connector issuer. Production signs with a
// non-exportable Cloud KMS key (RSA 2048, PKCS#1 v1.5, SHA-256): the private
// key never leaves KMS, and only the broker's own identity may use it. This
// module never reads, stores or derives private key material.

import { createHash } from "node:crypto";
import { GoogleAuth } from "google-auth-library";

export type FederationSigningAlgorithm = "RS256";

export interface FederationSigner {
  /** The full Cloud KMS key version resource name (or a test name). */
  readonly keyVersion: string;
  readonly algorithm: FederationSigningAlgorithm;
  /** Signs a SHA-256 digest; returns the raw signature bytes. */
  signDigest(digest: Buffer): Promise<Buffer>;
  /** The public key of this version, as PEM. */
  publicKeyPem(): Promise<string>;
}

const KMS_KEY_VERSION_RE =
  /^projects\/[a-z][-a-z0-9]{4,28}[a-z0-9]\/locations\/[a-z0-9-]{1,40}\/keyRings\/[A-Za-z0-9_-]{1,63}\/cryptoKeys\/[A-Za-z0-9_-]{1,63}\/cryptoKeyVersions\/[1-9][0-9]{0,9}$/;

export function isKmsKeyVersion(value: unknown): value is string {
  return typeof value === "string" && KMS_KEY_VERSION_RE.test(value);
}

/** The JWS `kid` of a key version: 32 hex characters of its name's SHA-256. */
export function federationKeyId(keyVersion: string): string {
  if (typeof keyVersion !== "string" || keyVersion.length === 0) {
    throw Error("invalid key version");
  }
  return createHash("sha256").update(keyVersion).digest("hex").slice(0, 32);
}

const KMS_ALGORITHM = "RSA_SIGN_PKCS1_2048_SHA256";
const KMS_SCOPE = "https://www.googleapis.com/auth/cloudkms";
const KMS_TIMEOUT_MS = 10_000;

/** The HTTP client the KMS signer uses (a google-auth-library client). */
export interface KmsHttpClient {
  request<T>(opts: {
    url: string;
    method: "GET" | "POST";
    data?: unknown;
    timeout: number;
    retry?: boolean;
  }): Promise<{ data: T }>;
}

/**
 * Signs with one Cloud KMS key version, through the broker's own runtime
 * credentials (Application Default Credentials). Refuses a key version that
 * isn't an enabled RSA 2048 PKCS#1 SHA-256 signing key, and never retries a
 * sign request.
 */
export class KmsFederationSigner implements FederationSigner {
  readonly algorithm: FederationSigningAlgorithm = "RS256";
  private client: () => Promise<KmsHttpClient>;
  private checked?: Promise<string>;

  constructor(
    readonly keyVersion: string,
    { client }: { client?: () => Promise<KmsHttpClient> } = {},
  ) {
    if (!isKmsKeyVersion(keyVersion)) {
      throw Error("invalid KMS key version name");
    }
    if (client) {
      this.client = client;
    } else {
      const auth = new GoogleAuth({ scopes: [KMS_SCOPE] });
      this.client = async () =>
        (await auth.getClient()) as unknown as KmsHttpClient;
    }
  }

  private url(suffix: string): string {
    return `https://cloudkms.googleapis.com/v1/${this.keyVersion}${suffix}`;
  }

  // The version's public key, after checking the version. Cached for the
  // signer's lifetime; a failure is not cached.
  private async checkedPublicKey(): Promise<string> {
    this.checked ??= (async () => {
      const client = await this.client();
      const version = await client.request<{
        state?: string;
        algorithm?: string;
      }>({ url: this.url(""), method: "GET", timeout: KMS_TIMEOUT_MS });
      if (version.data?.state !== "ENABLED") {
        throw Error("the signing key version is not enabled");
      }
      if (version.data?.algorithm !== KMS_ALGORITHM) {
        throw Error("the signing key version has an unexpected algorithm");
      }
      const key = await client.request<{ pem?: string; algorithm?: string }>({
        url: this.url("/publicKey"),
        method: "GET",
        timeout: KMS_TIMEOUT_MS,
      });
      if (
        key.data?.algorithm !== KMS_ALGORITHM ||
        typeof key.data?.pem !== "string"
      ) {
        throw Error("the signing key version returned no usable public key");
      }
      return key.data.pem;
    })();
    try {
      return await this.checked;
    } catch (err) {
      this.checked = undefined;
      throw err;
    }
  }

  async publicKeyPem(): Promise<string> {
    return await this.checkedPublicKey();
  }

  async signDigest(digest: Buffer): Promise<Buffer> {
    if (!Buffer.isBuffer(digest) || digest.length !== 32) {
      throw Error("expected a SHA-256 digest");
    }
    await this.checkedPublicKey();
    const client = await this.client();
    const res = await client.request<{ signature?: string; name?: string }>({
      url: this.url(":asymmetricSign"),
      method: "POST",
      data: { digest: { sha256: digest.toString("base64") } },
      timeout: KMS_TIMEOUT_MS,
      retry: false,
    });
    if (res.data?.name !== this.keyVersion) {
      throw Error("KMS signed with an unexpected key version");
    }
    if (typeof res.data?.signature !== "string") {
      throw Error("KMS returned no signature");
    }
    const signature = Buffer.from(res.data.signature, "base64");
    if (signature.length !== 256) {
      throw Error("KMS returned a signature of unexpected length");
    }
    return signature;
  }
}
