import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import type { DerivedSiteKey } from "@cocalc/util/master-key-lifecycle";
import {
  credentialAad,
  decryptGpuCredential,
  encryptGpuCredential,
  GpuCredentialEnvelopeError,
  type GpuCredentialBinding,
} from "./credential-envelope";

const SECRET = "rpa_SYNTHETICKEY0123456789abcdefghijklmnopqrstuv";
const binding: GpuCredentialBinding = {
  credentialId: "6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
  ownerAccountId: "0d4e6c1a-2b3c-4d5e-9f6a-7b8c9d0e1f2a",
  provider: "runpod",
};

function key(id: string, role: DerivedSiteKey["role"] = "active") {
  return { id, role, key: randomBytes(32) } satisfies DerivedSiteKey;
}

const active = key("smk_active");
const retired = key("smk_old", "retired");

function failsClosed(fn: () => unknown) {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(GpuCredentialEnvelopeError);
  // never echo the secret, the key or the ciphertext
  expect(`${(err as Error).message} ${inspect(err)}`).not.toContain(SECRET);
  return err as GpuCredentialEnvelopeError;
}

describe("GPU credential envelope", () => {
  it("round-trips under the active key", () => {
    const env = encryptGpuCredential(binding, SECRET, active);
    expect(env.envelope_version).toBe(1);
    expect(env.key_id).toBe("smk_active");
    expect(JSON.stringify(env)).not.toContain(SECRET);
    expect(decryptGpuCredential(binding, env, [active, retired])).toEqual({
      secret: SECRET,
      needsRewrap: false,
    });
  });

  it("uses a fresh nonce every time", () => {
    const a = encryptGpuCredential(binding, SECRET, active);
    const b = encryptGpuCredential(binding, SECRET, active);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("normalizes case and whitespace in the binding", () => {
    const env = encryptGpuCredential(binding, SECRET, active);
    const shouted = {
      credentialId: ` ${binding.credentialId.toUpperCase()} `,
      ownerAccountId: binding.ownerAccountId.toUpperCase(),
      provider: "RunPod",
    };
    expect(decryptGpuCredential(shouted, env, [active]).secret).toBe(SECRET);
  });

  it("fails when the ciphertext is moved to another row, owner or provider", () => {
    const env = encryptGpuCredential(binding, SECRET, active);
    const other = "11111111-2222-4333-8444-555555555555";
    failsClosed(() =>
      decryptGpuCredential({ ...binding, credentialId: other }, env, [active]),
    );
    failsClosed(() =>
      decryptGpuCredential({ ...binding, ownerAccountId: other }, env, [
        active,
      ]),
    );
    failsClosed(() =>
      decryptGpuCredential({ ...binding, provider: "lambda" }, env, [active]),
    );
  });

  it("encodes the AAD unambiguously", () => {
    // Field boundaries can't be shifted between adjacent fields.
    const a = credentialAad(binding);
    const b = credentialAad({ ...binding, provider: "runpo" });
    expect(a.equals(b)).toBe(false);
    expect(credentialAad(binding).equals(credentialAad(binding))).toBe(true);
    // version is part of the AAD
    expect(credentialAad(binding, 1).equals(credentialAad(binding, 2))).toBe(
      false,
    );
  });

  it("fails closed on any tampering", () => {
    const env = encryptGpuCredential(binding, SECRET, active);
    const flip = (b64: string) => {
      const buf = Buffer.from(b64, "base64");
      buf[0] ^= 1;
      return buf.toString("base64");
    };
    failsClosed(() =>
      decryptGpuCredential(
        binding,
        { ...env, ciphertext: flip(env.ciphertext) },
        [active],
      ),
    );
    failsClosed(() =>
      decryptGpuCredential(binding, { ...env, tag: flip(env.tag) }, [active]),
    );
    failsClosed(() =>
      decryptGpuCredential(binding, { ...env, nonce: flip(env.nonce) }, [
        active,
      ]),
    );
  });

  it("fails closed on malformed or unknown envelopes", () => {
    const env = encryptGpuCredential(binding, SECRET, active);
    failsClosed(() =>
      decryptGpuCredential(binding, { ...env, envelope_version: 2 }, [active]),
    );
    failsClosed(() =>
      decryptGpuCredential(binding, { ...env, nonce: "short" }, [active]),
    );
    failsClosed(() =>
      decryptGpuCredential(binding, { ...env, tag: "" }, [active]),
    );
    failsClosed(() =>
      decryptGpuCredential(binding, { ...env, ciphertext: "" }, [active]),
    );
    failsClosed(() =>
      decryptGpuCredential(binding, { ...env, ciphertext: "not base64!" }, [
        active,
      ]),
    );
    failsClosed(() => decryptGpuCredential(binding, null as any, [active]));
  });

  it("only tries the key the envelope names", () => {
    const env = encryptGpuCredential(binding, SECRET, active);
    // a relabeled envelope fails instead of silently trying other keys
    failsClosed(() =>
      decryptGpuCredential(binding, { ...env, key_id: "smk_old" }, [
        active,
        retired,
      ]),
    );
    // the named key missing from the keyring
    failsClosed(() => decryptGpuCredential(binding, env, [retired]));
    // same id, different key material (e.g. a wrong keyring)
    failsClosed(() => decryptGpuCredential(binding, env, [key("smk_active")]));
  });

  it("asks for a rewrap only under a retired key", () => {
    // encrypted while the old key was active, read after it was retired
    const old = { ...retired, role: "active" as const };
    const env = encryptGpuCredential(binding, SECRET, old);
    expect(decryptGpuCredential(binding, env, [active, retired])).toEqual({
      secret: SECRET,
      needsRewrap: true,
    });
  });

  it("does not rewrap a newer 'next' key during a rolling rotation", () => {
    // written by a process that already switched to the new key, read by a
    // stale process that still sees it as "next"
    const newer = key("smk_new");
    const env = encryptGpuCredential(binding, SECRET, newer);
    const stale = [active, { ...newer, role: "next" as const }];
    expect(decryptGpuCredential(binding, env, stale)).toEqual({
      secret: SECRET,
      needsRewrap: false,
    });
  });

  it("encrypts only under the active key", () => {
    failsClosed(() => encryptGpuCredential(binding, SECRET, retired));
    failsClosed(() =>
      encryptGpuCredential(binding, SECRET, { ...active, role: "next" }),
    );
  });

  it("bounds the ciphertext before decoding", () => {
    const env = encryptGpuCredential(binding, SECRET, active);
    const huge = Buffer.alloc(8192, 1).toString("base64");
    failsClosed(() =>
      decryptGpuCredential(binding, { ...env, ciphertext: huge }, [active]),
    );
    // non-canonical base64 is rejected: set an unused low bit in the last
    // significant character of the 16-byte tag ("xxxx...x==")
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const v = alphabet.indexOf(env.tag[21]);
    const tag = env.tag.slice(0, 21) + alphabet[v ^ 1] + env.tag.slice(22);
    expect(
      Buffer.from(tag, "base64").equals(Buffer.from(env.tag, "base64")),
    ).toBe(true);
    failsClosed(() => decryptGpuCredential(binding, { ...env, tag }, [active]));
  });

  it("validates inputs", () => {
    failsClosed(() => encryptGpuCredential(binding, "", active));
    failsClosed(() => encryptGpuCredential(binding, "x".repeat(5000), active));
    failsClosed(() =>
      encryptGpuCredential(
        { ...binding, credentialId: "nope" },
        SECRET,
        active,
      ),
    );
    failsClosed(() =>
      encryptGpuCredential({ ...binding, provider: "run:pod" }, SECRET, active),
    );
    failsClosed(() =>
      encryptGpuCredential(binding, SECRET, {
        id: "k",
        role: "active",
        key: randomBytes(16),
      }),
    );
  });
});
