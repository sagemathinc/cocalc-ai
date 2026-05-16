/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

let requireFreshAuthForSessionHashMock: jest.Mock;
let getImpersonationSessionBySessionHashMock: jest.Mock;
let hasActiveSecondFactorMock: jest.Mock;

jest.mock("@cocalc/server/auth/auth-sessions", () => ({
  __esModule: true,
  requireFreshAuthForSessionHash: (...args: any[]) =>
    requireFreshAuthForSessionHashMock(...args),
}));

jest.mock("@cocalc/server/auth/impersonation", () => ({
  __esModule: true,
  getImpersonationSessionBySessionHash: (...args: any[]) =>
    getImpersonationSessionBySessionHashMock(...args),
}));

jest.mock("@cocalc/server/auth/two-factor", () => ({
  __esModule: true,
  hasActiveSecondFactor: (...args: any[]) => hasActiveSecondFactorMock(...args),
}));

describe("requireDangerousSessionAuth", () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
  const ACTOR_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
  const SESSION_HASH = "session-hash";
  const PASSWORD_VERIFIED_AT = new Date("2026-05-14T12:00:00.000Z");
  const FACTOR_VERIFIED_AT = new Date("2026-05-14T12:00:01.000Z");

  beforeEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    jest.resetModules();
    requireFreshAuthForSessionHashMock = jest.fn(async () => ({
      account_id: ACCOUNT_ID,
      session_hash: SESSION_HASH,
      fresh_auth_until: new Date(Date.now() + 60_000),
      factor_level: "none",
    }));
    getImpersonationSessionBySessionHashMock = jest.fn(async () => undefined);
    hasActiveSecondFactorMock = jest.fn(async () => true);
  });

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it("requires a signed-in account", async () => {
    const { requireDangerousSessionAuth } =
      await import("./dangerous-session-auth");

    await expect(
      requireDangerousSessionAuth({ session_hash: SESSION_HASH }),
    ).rejects.toThrow("must be signed in");
  });

  it("requires a fresh-auth session hash", async () => {
    const { requireDangerousSessionAuth } =
      await import("./dangerous-session-auth");

    await expect(
      requireDangerousSessionAuth({ account_id: ACCOUNT_ID }),
    ).rejects.toMatchObject({
      code: "fresh_auth_required",
      message: "fresh auth is required",
    });
  });

  it("delegates fresh-auth validation with actor impersonation enabled", async () => {
    const { requireDangerousSessionAuth } =
      await import("./dangerous-session-auth");

    await requireDangerousSessionAuth({
      account_id: ACCOUNT_ID,
      session_hash: SESSION_HASH,
    });

    expect(requireFreshAuthForSessionHashMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      session_hash: SESSION_HASH,
      allow_actor_impersonation: true,
    });
    expect(hasActiveSecondFactorMock).not.toHaveBeenCalled();
  });

  it("resolves a browser session hash when only browser_id is provided", async () => {
    const BROWSER_ID = "browser-1";
    const { recordBrowserAuthSession } =
      await import("@cocalc/server/conat/socketio/browser-auth-sessions");
    recordBrowserAuthSession({
      account_id: ACCOUNT_ID,
      browser_id: BROWSER_ID,
      session_hash: SESSION_HASH,
    });
    const { requireDangerousSessionAuth } =
      await import("./dangerous-session-auth");

    await requireDangerousSessionAuth({
      account_id: ACCOUNT_ID,
      browser_id: BROWSER_ID,
    });

    expect(requireFreshAuthForSessionHashMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      session_hash: SESSION_HASH,
      allow_actor_impersonation: true,
    });
  });

  it("requires the subject account to have 2FA enabled when 2FA is required", async () => {
    hasActiveSecondFactorMock = jest.fn(async () => false);
    const { requireDangerousSessionAuth } =
      await import("./dangerous-session-auth");

    await expect(
      requireDangerousSessionAuth({
        account_id: ACCOUNT_ID,
        session_hash: SESSION_HASH,
        require_second_factor: true,
      }),
    ).rejects.toMatchObject({
      code: "two_factor_required",
      message: "two-factor authentication is required for this operation",
    });
  });

  it("accepts dev CLI fresh auth as a local non-production second factor", async () => {
    process.env.NODE_ENV = "development";
    hasActiveSecondFactorMock = jest.fn(async () => false);
    requireFreshAuthForSessionHashMock = jest.fn(async () => ({
      account_id: ACCOUNT_ID,
      session_hash: SESSION_HASH,
      fresh_auth_until: new Date(Date.now() + 60_000),
      factor_level: "totp",
      metadata: { dev_cli_fresh_auth: true },
    }));
    const { requireDangerousSessionAuth } =
      await import("./dangerous-session-auth");

    await expect(
      requireDangerousSessionAuth({
        account_id: ACCOUNT_ID,
        session_hash: SESSION_HASH,
        require_second_factor: true,
      }),
    ).resolves.toMatchObject({
      account_id: ACCOUNT_ID,
      session_hash: SESSION_HASH,
    });
  });

  it("does not accept dev CLI fresh auth in production", async () => {
    process.env.NODE_ENV = "production";
    hasActiveSecondFactorMock = jest.fn(async () => false);
    requireFreshAuthForSessionHashMock = jest.fn(async () => ({
      account_id: ACCOUNT_ID,
      session_hash: SESSION_HASH,
      fresh_auth_until: new Date(Date.now() + 60_000),
      factor_level: "totp",
      metadata: { dev_cli_fresh_auth: true },
    }));
    const { requireDangerousSessionAuth } =
      await import("./dangerous-session-auth");

    await expect(
      requireDangerousSessionAuth({
        account_id: ACCOUNT_ID,
        session_hash: SESSION_HASH,
        require_second_factor: true,
      }),
    ).rejects.toMatchObject({
      code: "two_factor_required",
    });
  });

  it("requires recent subject 2FA when the account has 2FA enabled", async () => {
    const { requireDangerousSessionAuth } =
      await import("./dangerous-session-auth");

    await expect(
      requireDangerousSessionAuth({
        account_id: ACCOUNT_ID,
        session_hash: SESSION_HASH,
        require_second_factor: true,
      }),
    ).rejects.toMatchObject({
      code: "fresh_auth_required",
      message: "recent two-factor verification is required",
    });
  });

  it("accepts recent subject 2FA", async () => {
    requireFreshAuthForSessionHashMock = jest.fn(async () => ({
      account_id: ACCOUNT_ID,
      session_hash: SESSION_HASH,
      fresh_auth_until: new Date(Date.now() + 60_000),
      factor_level: "totp",
      password_verified_at: PASSWORD_VERIFIED_AT,
      factor_verified_at: FACTOR_VERIFIED_AT,
    }));
    const { requireDangerousSessionAuth } =
      await import("./dangerous-session-auth");

    await expect(
      requireDangerousSessionAuth({
        account_id: ACCOUNT_ID,
        session_hash: SESSION_HASH,
        require_second_factor: true,
      }),
    ).resolves.toMatchObject({
      account_id: ACCOUNT_ID,
      session_hash: SESSION_HASH,
      factor_level: "totp",
    });
  });

  it("rejects stale subject 2FA when fresh auth was later password-only", async () => {
    requireFreshAuthForSessionHashMock = jest.fn(async () => ({
      account_id: ACCOUNT_ID,
      session_hash: SESSION_HASH,
      fresh_auth_until: new Date(Date.now() + 60_000),
      factor_level: "totp",
      password_verified_at: PASSWORD_VERIFIED_AT,
      factor_verified_at: new Date("2026-05-14T11:00:00.000Z"),
    }));
    const { requireDangerousSessionAuth } =
      await import("./dangerous-session-auth");

    await expect(
      requireDangerousSessionAuth({
        account_id: ACCOUNT_ID,
        session_hash: SESSION_HASH,
        require_second_factor: true,
      }),
    ).rejects.toMatchObject({
      code: "fresh_auth_required",
      message: "recent two-factor verification is required",
    });
  });

  it("requires active actor 2FA for an impersonation session", async () => {
    getImpersonationSessionBySessionHashMock = jest.fn(async () => ({
      actor_account_id: ACTOR_ACCOUNT_ID,
      actor_factor_level: "totp",
    }));
    hasActiveSecondFactorMock = jest.fn(async () => false);
    const { requireDangerousSessionAuth } =
      await import("./dangerous-session-auth");

    await expect(
      requireDangerousSessionAuth({
        account_id: ACCOUNT_ID,
        session_hash: SESSION_HASH,
        require_second_factor: true,
      }),
    ).rejects.toMatchObject({
      code: "two_factor_required",
      message: "actor must enable two-factor authentication for this operation",
    });
    expect(hasActiveSecondFactorMock).toHaveBeenCalledWith(ACTOR_ACCOUNT_ID);
  });

  it("requires recent actor 2FA for an impersonation session", async () => {
    getImpersonationSessionBySessionHashMock = jest.fn(async () => ({
      actor_account_id: ACTOR_ACCOUNT_ID,
      actor_factor_level: "none",
    }));
    const { requireDangerousSessionAuth } =
      await import("./dangerous-session-auth");

    await expect(
      requireDangerousSessionAuth({
        account_id: ACCOUNT_ID,
        session_hash: SESSION_HASH,
        require_second_factor: true,
      }),
    ).rejects.toMatchObject({
      code: "fresh_auth_required",
      message: "recent actor two-factor verification is required",
    });
  });

  it("accepts recent actor 2FA for an impersonation session", async () => {
    getImpersonationSessionBySessionHashMock = jest.fn(async () => ({
      actor_account_id: ACTOR_ACCOUNT_ID,
      actor_factor_level: "recovery_code",
      actor_password_verified_at: PASSWORD_VERIFIED_AT,
      actor_factor_verified_at: FACTOR_VERIFIED_AT,
    }));
    const { requireDangerousSessionAuth } =
      await import("./dangerous-session-auth");

    await expect(
      requireDangerousSessionAuth({
        account_id: ACCOUNT_ID,
        session_hash: SESSION_HASH,
        require_second_factor: true,
      }),
    ).resolves.toMatchObject({
      account_id: ACCOUNT_ID,
      session_hash: SESSION_HASH,
    });
  });
});
