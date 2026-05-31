/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

let isAdminMock: jest.Mock;
let requireDangerousSessionAuthMock: jest.Mock;
let manageApiKeysMock: jest.Mock;
let createRememberMeCookieMock: jest.Mock;
let recordNewAuthSessionMock: jest.Mock;

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: any[]) => isAdminMock(...args),
}));

jest.mock("./dangerous-session-auth", () => ({
  __esModule: true,
  requireDangerousSessionAuth: (...args: any[]) =>
    requireDangerousSessionAuthMock(...args),
}));

jest.mock("@cocalc/server/api/manage", () => ({
  __esModule: true,
  default: (...args: any[]) => manageApiKeysMock(...args),
}));

jest.mock("@cocalc/server/auth/remember-me", () => ({
  __esModule: true,
  createRememberMeCookie: (...args: any[]) =>
    createRememberMeCookieMock(...args),
}));

jest.mock("@cocalc/server/auth/auth-sessions", () => ({
  __esModule: true,
  recordNewAuthSession: (...args: any[]) => recordNewAuthSessionMock(...args),
}));

describe("admin maintenance dangerous-session auth", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
  const SUBJECT_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    jest.resetModules();
    isAdminMock = jest.fn(async () => true);
    requireDangerousSessionAuthMock = jest.fn(async () => {
      throw Object.assign(new Error("fresh auth is required"), {
        code: "fresh_auth_required",
      });
    });
    manageApiKeysMock = jest.fn(async () => []);
    createRememberMeCookieMock = jest.fn(async () => ({
      value: "remember-me-cookie",
      hash: "remember-me-hash",
      expire: new Date("2026-05-24T12:00:00.000Z"),
    }));
    recordNewAuthSessionMock = jest.fn(async () => undefined);
  });

  it("requires centralized recent 2FA fresh auth before creating impersonation grants", async () => {
    const { createImpersonationGrant } = await import("./system");

    await expect(
      createImpersonationGrant({
        account_id: ACCOUNT_ID,
        browser_id: "browser-1",
        subject_account_id: SUBJECT_ACCOUNT_ID,
      }),
    ).rejects.toThrow("fresh auth is required");

    expect(requireDangerousSessionAuthMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      browser_id: "browser-1",
      session_hash: undefined,
      require_second_factor: true,
      allow_actor_impersonation: false,
    });
  });

  it("requires centralized recent 2FA fresh auth before admin-created accounts", async () => {
    const { adminCreateUser } = await import("./system");

    await expect(
      adminCreateUser({
        account_id: ACCOUNT_ID,
        browser_id: "browser-1",
        email: "created@example.com",
      }),
    ).rejects.toThrow("fresh auth is required");

    expect(requireDangerousSessionAuthMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      browser_id: "browser-1",
      session_hash: undefined,
      require_second_factor: true,
      allow_actor_impersonation: false,
    });
  });

  it("requires centralized recent 2FA fresh auth before granting site admin role", async () => {
    const { adminGrantAdminRole } = await import("./system");

    await expect(
      adminGrantAdminRole({
        account_id: ACCOUNT_ID,
        browser_id: "browser-1",
        user_account_id: SUBJECT_ACCOUNT_ID,
        reason: "promotion approved by existing admin",
      }),
    ).rejects.toThrow("fresh auth is required");

    expect(requireDangerousSessionAuthMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      browser_id: "browser-1",
      session_hash: undefined,
      require_second_factor: true,
      allow_actor_impersonation: false,
    });
  });

  it("requires centralized recent 2FA fresh auth before removing site admin role", async () => {
    const { adminRevokeAdminRole } = await import("./system");

    await expect(
      adminRevokeAdminRole({
        account_id: ACCOUNT_ID,
        browser_id: "browser-1",
        user_account_id: SUBJECT_ACCOUNT_ID,
        reason: "employee no longer needs temporary admin access",
      }),
    ).rejects.toThrow("fresh auth is required");

    expect(requireDangerousSessionAuthMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      browser_id: "browser-1",
      session_hash: undefined,
      require_second_factor: true,
      allow_actor_impersonation: false,
    });
  });

  it("requires centralized recent 2FA fresh auth before unlinking a passport login method", async () => {
    const { deletePassport } = await import("./system");

    await expect(
      deletePassport({
        account_id: ACCOUNT_ID,
        browser_id: "browser-1",
        strategy: "github",
        id: "github-user-1",
      }),
    ).rejects.toThrow("fresh auth is required");

    expect(requireDangerousSessionAuthMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      browser_id: "browser-1",
      session_hash: undefined,
      require_second_factor: true,
    });
  });

  it("requires centralized recent 2FA fresh auth before Cloudflare teardown apply", async () => {
    const { startCloudflareTeardownApply } = await import("./system");

    await expect(
      startCloudflareTeardownApply({
        account_id: ACCOUNT_ID,
        browser_id: "browser-1",
        plan_id: "plan-1",
        confirm: "DELETE",
      }),
    ).rejects.toThrow("fresh auth is required");

    expect(requireDangerousSessionAuthMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      browser_id: "browser-1",
      session_hash: undefined,
      require_second_factor: true,
    });
  });

  it("requires centralized recent 2FA fresh auth before Cloudflare bootstrap", async () => {
    const { bootstrapCloudflareConfiguration } = await import("./system");

    await expect(
      bootstrapCloudflareConfiguration({
        account_id: ACCOUNT_ID,
        browser_id: "browser-1",
        domain: "example.com",
        token: "cloudflare-token",
      }),
    ).rejects.toThrow("fresh auth is required");

    expect(requireDangerousSessionAuthMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      browser_id: "browser-1",
      session_hash: undefined,
      require_second_factor: true,
    });
  });

  it("requires recent 2FA fresh auth before setting parallel worker limits", async () => {
    const { setParallelOpsLimit } = await import("./system");

    await expect(
      setParallelOpsLimit({
        account_id: ACCOUNT_ID,
        session_hash: "session-hash",
        worker_kind: "project-rootfs-publish",
        limit_value: 2,
      }),
    ).rejects.toThrow("fresh auth is required");

    expect(requireDangerousSessionAuthMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      browser_id: undefined,
      session_hash: "session-hash",
      require_second_factor: true,
    });
  });

  it("requires recent 2FA fresh auth before reconciling account rehomes", async () => {
    const { reconcileAccountRehome } = await import("./system");

    await expect(
      reconcileAccountRehome({
        account_id: ACCOUNT_ID,
        browser_id: "browser-1",
        op_id: "account-rehome-op",
        source_bay_id: "bay-1",
      }),
    ).rejects.toThrow("fresh auth is required");

    expect(requireDangerousSessionAuthMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      browser_id: "browser-1",
      session_hash: undefined,
      require_second_factor: true,
    });
  });

  it("requires recent 2FA fresh auth before clearing parallel worker limits", async () => {
    const { clearParallelOpsLimit } = await import("./system");

    await expect(
      clearParallelOpsLimit({
        account_id: ACCOUNT_ID,
        browser_id: "browser-1",
        worker_kind: "project-rootfs-publish",
      }),
    ).rejects.toThrow("fresh auth is required");

    expect(requireDangerousSessionAuthMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      browser_id: "browser-1",
      session_hash: undefined,
      require_second_factor: true,
    });
  });

  it("requires recent 2FA fresh auth before Cloudflare R2 bay-backup cleanup", async () => {
    const { startCloudflareR2BayBackupCleanup } = await import("./system");

    await expect(
      startCloudflareR2BayBackupCleanup({
        account_id: ACCOUNT_ID,
        session_hash: "session-hash",
        bucket: "backups",
        confirm: "DELETE",
      }),
    ).rejects.toThrow("fresh auth is required");

    expect(requireDangerousSessionAuthMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      browser_id: undefined,
      session_hash: "session-hash",
      require_second_factor: true,
    });
  });

  it("requires recent 2FA fresh auth before starting Cloudflare R2 audit scans", async () => {
    const { startCloudflareR2Audit } = await import("./system");

    await expect(
      startCloudflareR2Audit({
        account_id: ACCOUNT_ID,
        browser_id: "browser-1",
        bucket: "audit-bucket",
        refresh: true,
      }),
    ).rejects.toThrow("fresh auth is required");

    expect(requireDangerousSessionAuthMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      browser_id: "browser-1",
      session_hash: undefined,
      require_second_factor: true,
    });
  });

  it("requires recent 2FA fresh auth before materialized bay restores", async () => {
    const { runBayRestore } = await import("./system");

    await expect(
      runBayRestore({
        account_id: ACCOUNT_ID,
        session_hash: "session-hash",
        dry_run: false,
      }),
    ).rejects.toThrow("fresh auth is required");

    expect(requireDangerousSessionAuthMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      browser_id: undefined,
      session_hash: "session-hash",
      require_second_factor: true,
    });
  });

  it("requires recent 2FA fresh auth before bay restore tests", async () => {
    const { runBayRestoreTest } = await import("./system");

    await expect(
      runBayRestoreTest({
        account_id: ACCOUNT_ID,
        browser_id: "browser-1",
      }),
    ).rejects.toThrow("fresh auth is required");

    expect(requireDangerousSessionAuthMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      browser_id: "browser-1",
      session_hash: undefined,
      require_second_factor: true,
    });
  });

  it("requires recent 2FA fresh auth before creating account API keys", async () => {
    const { manageApiKeys } = await import("./system");

    await expect(
      manageApiKeys({
        account_id: ACCOUNT_ID,
        browser_id: "browser-1",
        action: "create",
        name: "automation",
        capabilities: ["account:read"],
      }),
    ).rejects.toThrow("fresh auth is required");

    expect(requireDangerousSessionAuthMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      browser_id: "browser-1",
      session_hash: undefined,
      require_second_factor: true,
    });
    expect(manageApiKeysMock).not.toHaveBeenCalled();
  });

  it("requires fresh auth before issuing raw browser sign-in cookies", async () => {
    const { issueBrowserSignInCookie } = await import("./system");

    await expect(
      issueBrowserSignInCookie({
        account_id: ACCOUNT_ID,
        browser_id: "browser-1",
      }),
    ).rejects.toThrow("fresh auth is required");

    expect(requireDangerousSessionAuthMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      browser_id: "browser-1",
      session_hash: undefined,
    });
  });

  it("caps raw browser sign-in cookie lifetime", async () => {
    requireDangerousSessionAuthMock = jest.fn(async () => ({}));
    const { issueBrowserSignInCookie } = await import("./system");

    await expect(
      issueBrowserSignInCookie({
        account_id: ACCOUNT_ID,
        session_hash: "session-hash",
        max_age_ms: 365 * 24 * 60 * 60 * 1000,
      }),
    ).resolves.toMatchObject({
      account_id: ACCOUNT_ID,
      remember_me: "remember-me-cookie",
      max_age_ms: 12 * 3600 * 1000,
    });

    expect(requireDangerousSessionAuthMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      browser_id: undefined,
      session_hash: "session-hash",
    });
    expect(createRememberMeCookieMock).toHaveBeenCalledWith(
      ACCOUNT_ID,
      12 * 3600,
    );
    expect(recordNewAuthSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: ACCOUNT_ID,
        session_hash: "remember-me-hash",
        factor_level: "none",
        fresh_auth_until: null,
        metadata: { issued_by: "issueBrowserSignInCookie" },
      }),
    );
  });

  it("allows listing account API keys without fresh auth", async () => {
    requireDangerousSessionAuthMock = jest.fn(async () => undefined);
    const { manageApiKeys } = await import("./system");

    await expect(
      manageApiKeys({
        account_id: ACCOUNT_ID,
        action: "get",
      }),
    ).resolves.toEqual([]);

    expect(requireDangerousSessionAuthMock).not.toHaveBeenCalled();
    expect(manageApiKeysMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      action: "get",
      name: undefined,
      expire: undefined,
      capabilities: undefined,
      allowed_project_ids: undefined,
      id: undefined,
    });
  });
});
