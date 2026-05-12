/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

jest.mock("@cocalc/database/settings/get-sso-strategies", () => ({
  __esModule: true,
  default: jest.fn(async () => []),
}));

describe("auth throttling", () => {
  it("limits repeated failed registration-token attempts by email", async () => {
    const { recordSignUpTokenFail, signUpTokenCheck } =
      await import("./throttle");
    const email = `token-email-${Date.now()}@example.com`;

    expect(signUpTokenCheck(email, "10.1.1.1")).toBeUndefined();
    for (let i = 0; i < 6; i++) {
      recordSignUpTokenFail(email, "10.1.1.1");
    }
    expect(signUpTokenCheck(email, "10.1.1.2")).toContain(
      "Too many failed registration-token attempts",
    );
  });

  it("limits repeated failed registration-token attempts by ip", async () => {
    const { recordSignUpTokenFail, signUpTokenCheck } =
      await import("./throttle");
    const ip = `10.2.2.${Date.now() % 255}`;

    expect(signUpTokenCheck("before@example.com", ip)).toBeUndefined();
    for (let i = 0; i < 21; i++) {
      recordSignUpTokenFail(`token-ip-${i}-${Date.now()}@example.com`, ip);
    }
    expect(signUpTokenCheck("after@example.com", ip)).toContain(
      "Too many failed registration-token attempts",
    );
  });
});
