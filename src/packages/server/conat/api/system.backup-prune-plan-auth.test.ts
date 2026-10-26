/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

const isAdminMock = jest.fn();
const requireDangerousSessionAuthMock = jest.fn();
const runAuditedMock = jest.fn();
const seedManagedMock = jest.fn();
const seedPlanMock = jest.fn();
const hostConnectionMock = jest.fn();
const clusterConfigMock = jest.fn();

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: any[]) => isAdminMock(...args),
}));

jest.mock("./dangerous-session-auth", () => ({
  __esModule: true,
  requireDangerousSessionAuth: (...args: any[]) =>
    requireDangerousSessionAuthMock(...args),
}));

jest.mock("@cocalc/server/project-backup/repo-prune-plan", () => ({
  __esModule: true,
  PRUNE_PLAN_DEFAULT_TIMEOUT_MS: 30 * 60_000,
  PRUNE_PLAN_MAX_TIMEOUT_MS: 120 * 60_000,
  runAuditedProjectBackupRepoPrunePlan: (...args: any[]) =>
    runAuditedMock(...args),
}));

jest.mock("@cocalc/server/project-backup", () => ({
  ...jest.requireActual("@cocalc/server/project-backup"),
  projectBackupReposAreSeedManaged: () => seedManagedMock(),
}));

jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  __esModule: true,
  getInterBayBridge: () => ({
    hostConnection: (...args: any[]) => {
      hostConnectionMock(...args);
      return {
        getSeedProjectBackupRepoPrunePlan: (...a: any[]) => seedPlanMock(...a),
      };
    },
  }),
}));

jest.mock("@cocalc/server/cluster-config", () => ({
  ...jest.requireActual("@cocalc/server/cluster-config"),
  getClusterConfig: () => clusterConfigMock(),
}));

describe("system.getProjectBackupRepoPrunePlan", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
  const REPO_ID = "22222222-2222-4222-8222-222222222222";
  const plan = { repo_id: REPO_ID, dry_run: true };

  beforeEach(() => {
    isAdminMock.mockReset().mockResolvedValue(true);
    requireDangerousSessionAuthMock
      .mockReset()
      .mockResolvedValue({ session_hash: "fresh" });
    runAuditedMock.mockReset().mockResolvedValue(plan);
    seedManagedMock.mockReset().mockReturnValue(false);
    seedPlanMock.mockReset().mockResolvedValue({ ...plan, from: "seed" });
    hostConnectionMock.mockReset();
    clusterConfigMock.mockReset().mockReturnValue({ role: "standalone" });
  });

  const call = async (opts: Record<string, unknown> = {}) => {
    const { getProjectBackupRepoPrunePlan } = await import("./system");
    return await getProjectBackupRepoPrunePlan({
      account_id: ACCOUNT_ID,
      browser_id: "browser-1",
      repo_id: REPO_ID,
      ...opts,
    });
  };

  it("is admin-only", async () => {
    isAdminMock.mockResolvedValue(false);
    await expect(call()).rejects.toThrow("must be an admin");
    expect(runAuditedMock).not.toHaveBeenCalled();
    expect(seedPlanMock).not.toHaveBeenCalled();
  });

  it("requires a recent second factor and no impersonation, also before forwarding", async () => {
    seedManagedMock.mockReturnValue(true);
    clusterConfigMock.mockReturnValue({
      role: "attached",
      seed_bay_id: "seed",
    });
    requireDangerousSessionAuthMock.mockRejectedValue(
      new Error("fresh auth is required"),
    );
    await expect(call()).rejects.toThrow("fresh auth is required");
    expect(requireDangerousSessionAuthMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      browser_id: "browser-1",
      session_hash: undefined,
      require_second_factor: true,
      allow_actor_impersonation: false,
    });
    expect(runAuditedMock).not.toHaveBeenCalled();
    expect(seedPlanMock).not.toHaveBeenCalled();
  });

  it("runs the audited plan on the bay that owns the repositories", async () => {
    await expect(
      call({ max_unused: "0", repoinfo: true, timeout_minutes: 45 }),
    ).resolves.toBe(plan);
    expect(runAuditedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_account_id: ACCOUNT_ID,
        repo_id: REPO_ID,
        max_unused: "0",
        max_repack: null,
        repoinfo: true,
        timeout_ms: 45 * 60_000,
        source_bay_id: expect.any(String),
        bay_id: expect.any(String),
      }),
    );
    expect(seedPlanMock).not.toHaveBeenCalled();
  });

  it("forwards to the seed bay from an attached bay", async () => {
    seedManagedMock.mockReturnValue(true);
    clusterConfigMock.mockReturnValue({
      role: "attached",
      seed_bay_id: "seed",
    });
    await expect(call({ timeout_minutes: 10 })).resolves.toMatchObject({
      from: "seed",
    });
    // Long enough for the plan's own time budget.
    expect(hostConnectionMock).toHaveBeenCalledWith("seed", {
      timeout_ms: 15 * 60_000,
    });
    expect(seedPlanMock).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_account_id: ACCOUNT_ID,
        repo_id: REPO_ID,
        timeout_ms: 10 * 60_000,
        source_bay_id: expect.any(String),
      }),
    );
    expect(runAuditedMock).not.toHaveBeenCalled();
  });
});
