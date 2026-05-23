/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

let isAdminMock: jest.Mock;
let requireDangerousSessionAuthMock: jest.Mock;

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: any[]) => isAdminMock(...args),
}));

jest.mock("./dangerous-session-auth", () => ({
  __esModule: true,
  requireDangerousSessionAuth: (...args: any[]) =>
    requireDangerousSessionAuthMock(...args),
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
});
