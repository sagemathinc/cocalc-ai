import { createPublicKey } from "node:crypto";
import { parseComputerPolicy } from "@cocalc/util/computers/policy";
import {
  parsePairingTranscript,
  SIGNED_KINDS,
  type PairingTranscript,
} from "@cocalc/util/computers/protocol";
import {
  canonicalHash,
  fingerprintOf,
  generateAgreementKey,
  generateSigningKey,
  policyHash,
  privateKeyFromPem,
  privateKeyToPem,
  randomNonce,
  signEnvelope,
  signingPublicKeyFromDer,
  signProofOfPossession,
  transcriptHash,
  transcriptPairingPhrase,
  verifyEnvelope,
  verifyProofOfPossession,
} from "./crypto";

const NETWORK = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

function transcriptFor(
  signing = generateSigningKey(),
  agreement = generateAgreementKey(),
): PairingTranscript {
  return parsePairingTranscript({
    type: "cocalc-computer-pairing",
    version: 1,
    site: "https://cocalc.ai",
    cluster_id: "11111111-2222-4333-8444-555555555555",
    request_id: "R-7Q2M9K4WXZ",
    account_id: "0b8f1c9e-1f7c-4c55-9a3e-2f0c4e5d6a7b",
    policy_hash: policyHash(
      parseComputerPolicy({
        version: 1,
        mode: "isolated",
        duration: { initial_seconds: 3600, max_seconds: 8 * 3600 },
        lease_hours: 24,
        agent_network_id: NETWORK,
        network: "on",
        gpu: false,
        mounts: [],
        images: { kind: "any" },
        scratch_bytes: null,
        limits: { cpu_millis: null, memory_bytes: null, pids: null },
      }),
    ),
    signing_key: signing.fingerprint,
    agreement_key: agreement.fingerprint,
    client_nonce: randomNonce(),
    server_nonce: randomNonce(),
    machine: {
      hostname: "macbook",
      os: "darwin",
      arch: "arm64",
      user: "wstein",
    },
  });
}

describe("keys and fingerprints", () => {
  it("makes distinct Ed25519 and X25519 keys with sha256 fingerprints", () => {
    const signing = generateSigningKey();
    const agreement = generateAgreementKey();
    expect(signing.publicKey.asymmetricKeyType).toBe("ed25519");
    expect(agreement.publicKey.asymmetricKeyType).toBe("x25519");
    expect(signing.fingerprint).toMatch(/^sha256:[A-Za-z0-9_-]{43}$/);
    expect(signing.fingerprint).not.toBe(agreement.fingerprint);
    expect(fingerprintOf(signing.publicKey)).toBe(signing.fingerprint);
  });

  it("round-trips a public key through DER and a private key through PEM", () => {
    const signing = generateSigningKey();
    expect(fingerprintOf(signingPublicKeyFromDer(signing.publicDer))).toBe(
      signing.fingerprint,
    );
    const restored = privateKeyFromPem(privateKeyToPem(signing.privateKey));
    expect(fingerprintOf(createPublicKey(restored))).toBe(signing.fingerprint);
  });

  it("refuses a non-Ed25519 key where a signing key is expected", () => {
    expect(() =>
      signingPublicKeyFromDer(generateAgreementKey().publicDer),
    ).toThrow(/Ed25519/);
  });
});

describe("signed envelopes", () => {
  const signer = generateSigningKey();
  const trusted = (kid: string) =>
    kid === signer.fingerprint ? signer.publicKey : undefined;

  it("verifies its own signature", () => {
    const env = signEnvelope(
      SIGNED_KINDS.transcript,
      transcriptFor(signer),
      signer,
    );
    expect(verifyEnvelope(SIGNED_KINDS.transcript, env, trusted)).toBe(true);
  });

  it("fails for a changed payload, another kind, an unknown kid, or a bad signature", () => {
    const env = signEnvelope(
      SIGNED_KINDS.transcript,
      transcriptFor(signer),
      signer,
    );
    expect(
      verifyEnvelope(
        SIGNED_KINDS.transcript,
        { ...env, payload: { ...env.payload, request_id: "R-0000000000" } },
        trusted,
      ),
    ).toBe(false);
    expect(verifyEnvelope(SIGNED_KINDS.ticket, env, trusted)).toBe(false);
    expect(verifyEnvelope(SIGNED_KINDS.transcript, env, () => undefined)).toBe(
      false,
    );
    expect(
      verifyEnvelope(
        SIGNED_KINDS.transcript,
        { ...env, sig: "A".repeat(86) },
        trusted,
      ),
    ).toBe(false);
    expect(
      verifyEnvelope(
        SIGNED_KINDS.transcript,
        { ...env, sig: "short" },
        trusted,
      ),
    ).toBe(false);
  });

  it("fails when a key set maps the kid to a different key", () => {
    const env = signEnvelope(SIGNED_KINDS.ticket, { a: 1 }, signer);
    const other = generateSigningKey();
    expect(
      verifyEnvelope(SIGNED_KINDS.ticket, env, () => other.publicKey),
    ).toBe(false);
  });

  it("does not sign with an agreement key", () => {
    expect(() =>
      signEnvelope(SIGNED_KINDS.ticket, { a: 1 }, generateAgreementKey()),
    ).toThrow();
  });
});

describe("pairing transcript", () => {
  it("gives the same hash and phrase for the same transcript, in any key order", () => {
    const t = transcriptFor();
    const reordered = Object.fromEntries(
      Object.entries(t).reverse(),
    ) as PairingTranscript;
    expect(Object.keys(reordered)[0]).toBe("machine");
    expect(transcriptHash(reordered)).toBe(transcriptHash(t));
    expect(transcriptPairingPhrase(reordered)).toBe(transcriptPairingPhrase(t));
    expect(transcriptPairingPhrase(t)).toMatch(/^[a-z]+-[a-z]+-[a-z]+-[a-z]+$/);
  });

  it("changes the phrase when the key, policy or site changes", () => {
    const signing = generateSigningKey();
    const agreement = generateAgreementKey();
    const t = transcriptFor(signing, agreement);
    const phrases = new Set([
      transcriptPairingPhrase(t),
      transcriptPairingPhrase({
        ...t,
        signing_key: generateSigningKey().fingerprint,
      }),
      transcriptPairingPhrase({
        ...t,
        policy_hash: canonicalHash({ other: 1 }),
      }),
      transcriptPairingPhrase({ ...t, site: "https://lite1b.cocalc.ai" }),
    ]);
    // 32-bit phrases: a collision among four is astronomically unlikely
    expect(phrases.size).toBe(4);
  });
});

describe("proof of possession", () => {
  it("verifies only for the same ticket and request", () => {
    const pop = generateSigningKey();
    const proof = signProofOfPossession(
      pop,
      "aaaaaaaa-1111-4222-8333-444444444444",
      "sha256:" + "r".repeat(43),
    );
    expect(
      verifyProofOfPossession(
        pop.publicDer,
        "aaaaaaaa-1111-4222-8333-444444444444",
        "sha256:" + "r".repeat(43),
        proof,
      ),
    ).toBe(true);
    expect(
      verifyProofOfPossession(
        pop.publicDer,
        "aaaaaaaa-1111-4222-8333-444444444445",
        "sha256:" + "r".repeat(43),
        proof,
      ),
    ).toBe(false);
    expect(
      verifyProofOfPossession(
        generateSigningKey().publicDer,
        "aaaaaaaa-1111-4222-8333-444444444444",
        "sha256:" + "r".repeat(43),
        proof,
      ),
    ).toBe(false);
    expect(verifyProofOfPossession("not-a-key", "x", "y", proof)).toBe(false);
  });
});
