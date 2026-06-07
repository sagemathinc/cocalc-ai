/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  authorizedKeysContainAnyFingerprint,
  authorizedKeysContainFingerprint,
  computeSshFingerprintFromBase64,
  extractAuthorizedKeyBase64,
  matchingAuthorizedKeyFingerprint,
  sshPublicKeyCandidateFingerprints,
} from "./ssh-keys";

describe("ssh authorized key helpers", () => {
  it("extracts the key blob from an authorized_keys line with options", () => {
    expect(
      extractAuthorizedKeyBase64(
        'command="/bin/true",no-pty ssh-ed25519 YWJjZA== laptop',
      ),
    ).toEqual({
      key_type: "ssh-ed25519",
      base64: "YWJjZA==",
    });
  });

  it("matches fingerprints inside authorized_keys text", () => {
    const fingerprint = computeSshFingerprintFromBase64("YWJjZA==");
    const text = [
      "# comment",
      'command="/bin/true",no-pty ssh-ed25519 YWJjZA== laptop',
      "ssh-rsa ZWZnaA== server",
    ].join("\n");
    expect(authorizedKeysContainFingerprint(text, fingerprint)).toBe(true);
    expect(
      authorizedKeysContainFingerprint(
        text,
        computeSshFingerprintFromBase64("bm9wZQ=="),
      ),
    ).toBe(false);
  });

  it("matches sshpiperd public key bytes when they are raw key blobs", () => {
    const raw = Buffer.from("abcd");
    const fingerprints = sshPublicKeyCandidateFingerprints(raw);
    const text = "ssh-ed25519 YWJjZA== laptop";

    expect(authorizedKeysContainAnyFingerprint(text, fingerprints)).toBe(true);
    expect(matchingAuthorizedKeyFingerprint(text, fingerprints)).toBe(
      computeSshFingerprintFromBase64("YWJjZA=="),
    );
  });

  it("matches sshpiperd public key bytes when they are authorized-key text", () => {
    const offered = Buffer.from("ssh-ed25519 YWJjZA== laptop");
    const fingerprints = sshPublicKeyCandidateFingerprints(offered);
    const text = "ssh-ed25519 YWJjZA== laptop";

    expect(authorizedKeysContainAnyFingerprint(text, fingerprints)).toBe(true);
    expect(matchingAuthorizedKeyFingerprint(text, fingerprints)).toBe(
      computeSshFingerprintFromBase64("YWJjZA=="),
    );
  });
});
