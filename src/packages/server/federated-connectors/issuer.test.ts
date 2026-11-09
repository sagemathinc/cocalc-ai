/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  constants,
  createPublicKey,
  generateKeyPairSync,
  privateEncrypt,
  verify as rsaVerify,
} from "node:crypto";
import {
  assertClockWithinSkew,
  assertionClaims,
  buildJwks,
  discoveryDocument,
  signAssertion,
} from "./issuer";
import {
  federationKeyId,
  KmsFederationSigner,
  type FederationSigner,
  type KmsHttpClient,
} from "./signer";

// Fake values only.
const UUID = (n: number) =>
  `00000000-0000-4000-8000-${`${n}`.padStart(12, "0")}`;
const ISSUER = "https://staging.example.com/_cocalc/oidc/connectors";
const PROVIDER = {
  pool_project_number: "123456789012",
  pool_id: "example-pool",
  provider_id: "example-provider",
};
const KEY_VERSION =
  "projects/example-project-1/locations/us/keyRings/example-ring/cryptoKeys/example-key/cryptoKeyVersions/1";
const NOW = 1_800_000_000_000;

const attributes = () => ({
  site_id: UUID(1),
  account_id: UUID(2),
  agent_id: UUID(3),
  project_id: UUID(4),
  connection_id: UUID(5),
  grant_id: UUID(6),
  grant_revision: "2",
  lease_id: UUID(7),
});

// A local test key: signs a SHA-256 digest the way KMS does
// (RSASSA-PKCS1-v1_5). Exists only in this test.
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicPem = keys.publicKey.export({ type: "spki", format: "pem" });
function testSigner(keyVersion = KEY_VERSION): FederationSigner {
  return {
    keyVersion,
    algorithm: "RS256",
    async signDigest(digest: Buffer) {
      // RSASSA-PKCS1-v1_5 over a prehashed SHA-256 digest: the
      // DigestInfo prefix plus the digest, PKCS#1 type 1 padding.
      const prefix = Buffer.from(
        "3031300d060960864801650304020105000420",
        "hex",
      );
      return privateEncrypt(
        { key: keys.privateKey, padding: constants.RSA_PKCS1_PADDING },
        Buffer.concat([prefix, digest]),
      );
    },
    async publicKeyPem() {
      return `${publicPem}`;
    },
  };
}

function decode(part: string) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

describe("signed assertions", () => {
  it("signs an assertion that verifies with the published JWKS key", async () => {
    const signed = await signAssertion(testSigner(), {
      issuer: ISSUER,
      provider: PROVIDER,
      attributes: attributes(),
      now: NOW,
      jti: UUID(9),
    });
    const [h, p, s] = signed.assertion.split(".");
    const jwks = buildJwks([
      { keyVersion: KEY_VERSION, publicKeyPem: `${publicPem}` },
    ]);
    const jwk = jwks.keys.find((k) => k.kid === decode(h).kid)!;
    expect(jwk).toBeDefined();
    expect(
      rsaVerify(
        "sha256",
        Buffer.from(`${h}.${p}`),
        createPublicKey({ key: jwk as any, format: "jwk" }),
        Buffer.from(s, "base64url"),
      ),
    ).toBe(true);
    expect(decode(h)).toEqual({
      alg: "RS256",
      typ: "JWT",
      kid: federationKeyId(KEY_VERSION),
    });
  });

  it("carries exactly the agreed claims, opaque ids only", async () => {
    const signed = await signAssertion(testSigner(), {
      issuer: ISSUER,
      provider: PROVIDER,
      attributes: attributes(),
      now: NOW,
      jti: UUID(9),
    });
    const claims = decode(signed.assertion.split(".")[1]);
    expect(claims).toEqual({
      iss: ISSUER,
      aud: "https://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/example-pool/providers/example-provider",
      sub: UUID(7),
      iat: NOW / 1000,
      exp: NOW / 1000 + 300,
      jti: UUID(9),
      ...attributes(),
    });
    expect(JSON.stringify(claims)).not.toMatch(/@/);
    expect(signed.expiresAt - signed.issuedAt).toBe(300_000);
  });

  it("never issues an assertion valid for more than 5 minutes", () => {
    for (const lifetimeSeconds of [0, 301, 3600, 1.5, -1]) {
      expect(() =>
        assertionClaims({
          issuer: ISSUER,
          provider: PROVIDER,
          attributes: attributes(),
          now: NOW,
          lifetimeSeconds,
          jti: UUID(9),
        }),
      ).toThrow("invalid assertion lifetime");
    }
  });

  it.each([
    "http://staging.example.com/_cocalc/oidc/connectors",
    "https://staging.example.com/_cocalc/oidc/connectors/",
    "https://staging.example.com/other",
    "https://user@staging.example.com/_cocalc/oidc/connectors",
    "https://staging..example.com/_cocalc/oidc/connectors",
    "https://.staging.example.com/_cocalc/oidc/connectors",
    "https://-staging.example.com/_cocalc/oidc/connectors",
    "https://staging.example.com:99999/_cocalc/oidc/connectors",
    "https://staging.example.com:443/_cocalc/oidc/connectors",
    "https://STAGING.example.com/_cocalc/oidc/connectors",
    "https://localhost/_cocalc/oidc/connectors",
    "https://10.0.0.1/_cocalc/oidc/connectors",
    "https://staging.example.com/_cocalc/oidc/connectors?x=1",
    "https://staging.example.com/_cocalc/oidc/connectors#x",
  ])("refuses the issuer %s", (issuer) => {
    expect(() =>
      assertionClaims({
        issuer,
        provider: PROVIDER,
        attributes: attributes(),
        now: NOW,
        jti: UUID(9),
      }),
    ).toThrow("invalid issuer");
  });

  it("refuses identity attributes that aren't opaque ids", () => {
    expect(() =>
      assertionClaims({
        issuer: ISSUER,
        provider: PROVIDER,
        attributes: { ...attributes(), account_id: "a@example.com" },
        now: NOW,
        jti: UUID(9),
      }),
    ).toThrow("account_id");
  });

  it("refuses a malformed jti or time", () => {
    const base = {
      issuer: ISSUER,
      provider: PROVIDER,
      attributes: attributes(),
    };
    expect(() => assertionClaims({ ...base, now: NOW, jti: "x" })).toThrow(
      "invalid jti",
    );
    expect(() => assertionClaims({ ...base, now: NaN, jti: UUID(9) })).toThrow(
      "invalid time",
    );
  });
});

describe("local signature verification", () => {
  it("refuses a signature that doesn't verify with the version's key", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const signer = testSigner();
    signer.publicKeyPem = async () =>
      `${other.publicKey.export({ type: "spki", format: "pem" })}`;
    await expect(
      signAssertion(signer, {
        issuer: ISSUER,
        provider: PROVIDER,
        attributes: attributes(),
        now: NOW,
      }),
    ).rejects.toThrow("does not verify");
  });

  it("refuses a corrupted signature", async () => {
    const signer = testSigner();
    const sign = signer.signDigest.bind(signer);
    signer.signDigest = async (d: Buffer) => {
      const sig = await sign(d);
      sig[10] ^= 0xff;
      return sig;
    };
    await expect(
      signAssertion(signer, {
        issuer: ISSUER,
        provider: PROVIDER,
        attributes: attributes(),
        now: NOW,
      }),
    ).rejects.toThrow("does not verify");
  });
});

describe("clock check", () => {
  it("accepts a small skew and refuses a large or unusable one", () => {
    expect(() =>
      assertClockWithinSkew({ localNow: NOW, referenceNow: NOW + 29_000 }),
    ).not.toThrow();
    expect(() =>
      assertClockWithinSkew({ localNow: NOW, referenceNow: NOW - 31_000 }),
    ).toThrow("skew");
    expect(() =>
      assertClockWithinSkew({ localNow: NOW, referenceNow: NaN }),
    ).toThrow("no usable time");
    for (const maxSkewMs of [NaN, -1, Infinity]) {
      expect(() =>
        assertClockWithinSkew({ localNow: NOW, referenceNow: NOW, maxSkewMs }),
      ).toThrow("invalid skew limit");
    }
  });
});

describe("JWKS and discovery", () => {
  it("publishes only RSA 2048 public keys with one kid per version", () => {
    const jwks = buildJwks([
      { keyVersion: KEY_VERSION, publicKeyPem: `${publicPem}` },
    ]);
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({
      kty: "RSA",
      alg: "RS256",
      use: "sig",
      kid: federationKeyId(KEY_VERSION),
    });
    expect(Object.keys(jwks.keys[0]).sort()).toEqual(
      ["alg", "e", "kid", "kty", "n", "use"].sort(),
    );
  });

  it("accepts a non-default port", () => {
    expect(
      discoveryDocument(
        "https://staging.example.com:8443/_cocalc/oidc/connectors",
      ).issuer,
    ).toBe("https://staging.example.com:8443/_cocalc/oidc/connectors");
  });

  it("refuses other key types and sizes, private keys and duplicates", () => {
    const small = generateKeyPairSync("rsa", { modulusLength: 1024 });
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
    for (const pem of [
      small.publicKey.export({ type: "spki", format: "pem" }),
      ec.publicKey.export({ type: "spki", format: "pem" }),
    ]) {
      expect(() =>
        buildJwks([{ keyVersion: KEY_VERSION, publicKeyPem: `${pem}` }]),
      ).toThrow("RSA 2048");
    }
    // Private key material is refused, never used to derive a public key.
    for (const privatePem of [
      keys.privateKey.export({ type: "pkcs8", format: "pem" }),
      keys.privateKey.export({ type: "pkcs1", format: "pem" }),
    ]) {
      expect(() =>
        buildJwks([{ keyVersion: KEY_VERSION, publicKeyPem: `${privatePem}` }]),
      ).toThrow("PEM public keys");
    }
    // An RSA public key in PKCS#1 form isn't the SPKI form KMS returns.
    expect(() =>
      buildJwks([
        {
          keyVersion: KEY_VERSION,
          publicKeyPem: `${keys.publicKey.export({ type: "pkcs1", format: "pem" })}`,
        },
      ]),
    ).toThrow("PEM public keys");
    expect(() =>
      buildJwks([
        { keyVersion: KEY_VERSION, publicKeyPem: `${publicPem}` },
        { keyVersion: KEY_VERSION, publicKeyPem: `${publicPem}` },
      ]),
    ).toThrow("duplicate key id");
  });

  it("describes the issuer and its JWKS location", () => {
    expect(discoveryDocument(ISSUER)).toMatchObject({
      issuer: ISSUER,
      jwks_uri: `${ISSUER}/jwks.json`,
      id_token_signing_alg_values_supported: ["RS256"],
    });
    expect(() => discoveryDocument("https://x.example.com/")).toThrow();
  });
});

describe("KMS signer", () => {
  function fakeKms(
    overrides: Partial<{
      state: string;
      algorithm: string;
      name: string;
      signature: string;
      pem: string;
      failFirst: boolean;
    }> = {},
  ) {
    const calls: { url: string; method: string; retry?: boolean }[] = [];
    let failed = false;
    const client: KmsHttpClient = {
      async request<T>(opts: any) {
        calls.push({ url: opts.url, method: opts.method, retry: opts.retry });
        if (overrides.failFirst && !failed) {
          failed = true;
          throw Error("transient");
        }
        if (opts.url.endsWith(":asymmetricSign")) {
          return {
            data: {
              name: overrides.name ?? KEY_VERSION,
              signature:
                overrides.signature ?? Buffer.alloc(256, 1).toString("base64"),
            } as T,
          };
        }
        if (opts.url.endsWith("/publicKey")) {
          return {
            data: {
              pem: overrides.pem ?? `${publicPem}`,
              algorithm: overrides.algorithm ?? "RSA_SIGN_PKCS1_2048_SHA256",
            } as T,
          };
        }
        return {
          data: {
            state: overrides.state ?? "ENABLED",
            algorithm: overrides.algorithm ?? "RSA_SIGN_PKCS1_2048_SHA256",
          } as T,
        };
      },
    };
    return { client: async () => client, calls };
  }

  it("refuses a malformed key version name", () => {
    expect(() => new KmsFederationSigner("projects/x/keys/y")).toThrow(
      "invalid KMS key version name",
    );
  });

  it("checks the version, then signs once without retries", async () => {
    const kms = fakeKms();
    const signer = new KmsFederationSigner(KEY_VERSION, { client: kms.client });
    const sig = await signer.signDigest(Buffer.alloc(32, 7));
    expect(sig).toHaveLength(256);
    const sign = kms.calls.filter((c) => c.url.endsWith(":asymmetricSign"));
    expect(sign).toHaveLength(1);
    expect(sign[0]).toMatchObject({ method: "POST", retry: false });
    expect(sign[0].url).toBe(
      `https://cloudkms.googleapis.com/v1/${KEY_VERSION}:asymmetricSign`,
    );
  });

  it.each([
    [{ state: "DISABLED" }, "not enabled"],
    [{ algorithm: "EC_SIGN_P256_SHA256" }, "unexpected algorithm"],
    [{ name: `${KEY_VERSION.slice(0, -1)}2` }, "unexpected key version"],
    [{ signature: Buffer.alloc(128).toString("base64") }, "unexpected length"],
  ])("refuses %j", async (overrides, message) => {
    const kms = fakeKms(overrides);
    const signer = new KmsFederationSigner(KEY_VERSION, { client: kms.client });
    await expect(signer.signDigest(Buffer.alloc(32))).rejects.toThrow(
      message as string,
    );
  });

  it("refuses anything but a SHA-256 digest", async () => {
    const kms = fakeKms();
    const signer = new KmsFederationSigner(KEY_VERSION, { client: kms.client });
    await expect(signer.signDigest(Buffer.alloc(31))).rejects.toThrow(
      "SHA-256 digest",
    );
    expect(kms.calls).toHaveLength(0);
  });

  it("does not cache a failed version check", async () => {
    const kms = fakeKms({ failFirst: true });
    const signer = new KmsFederationSigner(KEY_VERSION, { client: kms.client });
    await expect(signer.publicKeyPem()).rejects.toThrow("transient");
    await expect(signer.publicKeyPem()).resolves.toContain("PUBLIC KEY");
  });
});
