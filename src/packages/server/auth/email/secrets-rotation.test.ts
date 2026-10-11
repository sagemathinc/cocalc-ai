/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createHmac } from "node:crypto";

jest.mock("@cocalc/database/settings/secret-settings", () =>
  require("@cocalc/database/settings/secret-settings-test-mock").secretSettingsMock(
    Buffer.alloc(32, 41),
    [Buffer.alloc(32, 42)],
  ),
);

// A digest as a server still on the retired key made it.
function retiredDigest(kind: string, challenge_id: string, value: string) {
  const subkey = createHmac("sha256", Buffer.alloc(32, 42))
    .update("cocalc-email-auth:v1")
    .digest();
  return createHmac("sha256", subkey)
    .update(kind)
    .update("\0")
    .update(challenge_id)
    .update("\0")
    .update(value)
    .digest("hex");
}

describe("email authentication secrets across a key rotation", () => {
  it("matches and looks up digests made under the retired key", async () => {
    const {
      emailAuthDigest,
      emailAuthDigestCandidates,
      emailAuthSecretMatches,
    } = await import("./secrets");
    const old = retiredDigest("code", "c1", "123456");
    await expect(
      emailAuthSecretMatches({
        challenge_id: "c1",
        digest: old,
        kind: "code",
        value: "123456",
      }),
    ).resolves.toBe(true);
    await expect(
      emailAuthSecretMatches({
        challenge_id: "c1",
        digest: old,
        kind: "code",
        value: "654321",
      }),
    ).resolves.toBe(false);
    const candidates = await emailAuthDigestCandidates({
      kind: "email",
      value: "a@b.c",
    });
    expect(candidates).toEqual([
      await emailAuthDigest({ kind: "email", value: "a@b.c" }),
      retiredDigest("email", "", "a@b.c"),
    ]);
  });

  it("decrypts a registration token encrypted under the retired key", async () => {
    const { encryptSecretSettingValue } =
      await import("@cocalc/util/secret-settings-crypto");
    const { decryptEmailAuthRegistrationToken } = await import("./secrets");
    const subkey = createHmac("sha256", Buffer.alloc(32, 42))
      .update("cocalc-email-auth:v1")
      .digest();
    const encrypted = encryptSecretSettingValue(
      "email_auth_challenges.registration_token",
      "token",
      subkey,
    );
    await expect(decryptEmailAuthRegistrationToken(encrypted)).resolves.toBe(
      "token",
    );
  });
});
