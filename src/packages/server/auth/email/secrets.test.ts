/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

jest.mock("@cocalc/database/settings/secret-settings", () =>
  require("@cocalc/database/settings/secret-settings-test-mock").secretSettingsMock(
    Buffer.alloc(32, 7),
  ),
);

describe("email authentication secrets", () => {
  it("separates digest purposes and challenge identifiers", async () => {
    const { emailAuthDigest, emailAuthSecretMatches } =
      await import("./secrets");
    const challenge_id = "11111111-1111-4111-8111-111111111111";
    const codeDigest = await emailAuthDigest({
      challenge_id,
      kind: "code",
      value: "123456",
    });
    const linkDigest = await emailAuthDigest({
      challenge_id,
      kind: "link",
      value: "123456",
    });
    const otherChallengeDigest = await emailAuthDigest({
      challenge_id: "22222222-2222-4222-8222-222222222222",
      kind: "code",
      value: "123456",
    });

    expect(codeDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(linkDigest).not.toBe(codeDigest);
    expect(otherChallengeDigest).not.toBe(codeDigest);
    await expect(
      emailAuthSecretMatches({
        challenge_id,
        digest: codeDigest,
        kind: "code",
        value: "123456",
      }),
    ).resolves.toBe(true);
    await expect(
      emailAuthSecretMatches({
        challenge_id,
        digest: codeDigest,
        kind: "code",
        value: "123457",
      }),
    ).resolves.toBe(false);
  });

  it("masks the local part while retaining a useful domain", async () => {
    const { maskEmailAddress } = await import("./secrets");
    expect(maskEmailAddress("person@example.edu")).toBe("pe…@example.edu");
    expect(maskEmailAddress("x@example.edu")).toBe("x@example.edu");
    expect(maskEmailAddress("invalid")).toBe("***");
  });
});
