export {};

let createHostStatusServiceMock: jest.Mock;
let conatMock: jest.Mock;
let queryMock: jest.Mock;
let resolveMembershipForAccountMock: jest.Mock;
let getEffectiveMembershipUsageLimitsMock: jest.Mock;
let getLaunchpadLocalConfigMock: jest.Mock;
let maybeStartLaunchpadOnPremServicesMock: jest.Mock;
let getLaunchpadRestPortMock: jest.Mock;
let registerSelfHostTunnelKeyMock: jest.Mock;
let resolveOnPremHostMock: jest.Mock;

jest.mock("@cocalc/backend/logger", () => {
  const getLogger = jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }));
  return {
    __esModule: true,
    default: getLogger,
    getLogger,
  };
});

jest.mock("@cocalc/backend/conat", () => ({
  __esModule: true,
  conat: (...args: any[]) => conatMock(...args),
}));

jest.mock("@cocalc/conat/project-host/api", () => ({
  __esModule: true,
  createHostStatusService: (...args: any[]) =>
    createHostStatusServiceMock(...args),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    query: (...args: any[]) => queryMock(...args),
  })),
}));

jest.mock("@cocalc/server/launchpad/mode", () => ({
  __esModule: true,
  getLaunchpadLocalConfig: (...args: any[]) =>
    getLaunchpadLocalConfigMock(...args),
}));

jest.mock("@cocalc/server/onprem", () => ({
  __esModule: true,
  resolveOnPremHost: (...args: any[]) => resolveOnPremHostMock(...args),
}));

jest.mock("@cocalc/server/launchpad/onprem-sshd", () => ({
  __esModule: true,
  maybeStartLaunchpadOnPremServices: (...args: any[]) =>
    maybeStartLaunchpadOnPremServicesMock(...args),
  getLaunchpadRestPort: (...args: any[]) => getLaunchpadRestPortMock(...args),
  registerSelfHostTunnelKey: (...args: any[]) =>
    registerSelfHostTunnelKeyMock(...args),
}));

jest.mock("@cocalc/server/accounts/revocation", () => ({
  __esModule: true,
  listAccountRevocationsSince: jest.fn(),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  __esModule: true,
  getConfiguredBayId: jest.fn(() => "bay-0"),
}));

jest.mock("@cocalc/server/account/project-feed", () => ({
  __esModule: true,
  publishProjectAccountFeedEventsBestEffort: jest.fn(),
}));

jest.mock("@cocalc/server/membership/resolve", () => ({
  __esModule: true,
  resolveMembershipForAccount: (...args: any[]) =>
    resolveMembershipForAccountMock(...args),
}));

jest.mock("@cocalc/server/membership/effective-limits", () => ({
  __esModule: true,
  getEffectiveMembershipUsageLimits: (...args: any[]) =>
    getEffectiveMembershipUsageLimitsMock(...args),
}));

jest.mock("@cocalc/server/projects/maintenance-status", () => ({
  __esModule: true,
  ensureProjectMaintenanceStatusTable: jest.fn(async () => undefined),
  recordProjectMaintenanceStatus: jest.fn(async () => true),
  snapshotScheduleRevision: jest.fn(() => "schedule-revision"),
}));

jest.mock("./host-project-ownership", () => ({
  __esModule: true,
  classifyHostProvisionedInventory: jest.fn(),
  shouldDeleteHostProjectUpdate: jest.fn(),
}));

jest.mock("@cocalc/database/postgres/project-events-outbox", () => ({
  __esModule: true,
  appendProjectOutboxEventForProject: jest.fn(),
}));

describe("listHostProjectMaintenanceSchedules", () => {
  beforeEach(() => {
    jest.resetModules();
    createHostStatusServiceMock = jest.fn();
    conatMock = jest.fn(async () => ({ ok: true }));
    queryMock = jest.fn();
    resolveMembershipForAccountMock = jest.fn(async () => ({
      effective_limits: {},
    }));
    getEffectiveMembershipUsageLimitsMock = jest.fn(() => ({
      max_snapshots_per_project: 8,
      max_backups_per_project: 5,
    }));
    getLaunchpadLocalConfigMock = jest.fn(() => ({
      sshd_port: 2201,
      ssh_user: "user",
      rest_port: 9345,
    }));
    maybeStartLaunchpadOnPremServicesMock = jest.fn(async () => undefined);
    getLaunchpadRestPortMock = jest.fn(() => 9345);
    registerSelfHostTunnelKeyMock = jest.fn(async () => ({
      http_tunnel_port: 31001,
      ssh_tunnel_port: 31002,
      tunnel_public_key: "ssh-ed25519 AAAA",
      conat_router_port: 9102,
    }));
    resolveOnPremHostMock = jest.fn(() => "lite4b.cocalc.ai");
    delete process.env.COCALC_DEV_GCP_REVERSE_TUNNEL;
  });

  it("fences maintenance against moves, schedule edits, and newer changes", async () => {
    const { confirmHostProjectMaintenanceAssignment } =
      await import("./host-status");
    const request = {
      host_id: "host-1",
      project_id: "proj-1",
      kind: "snapshot" as const,
      schedule_revision: "schedule-revision",
      observed_change_at: "2026-09-23T21:00:00.000Z",
    };
    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(
      confirmHostProjectMaintenanceAssignment(request),
    ).resolves.toEqual({ valid: false, reason: "assignment_changed" });

    queryMock.mockResolvedValueOnce({
      rows: [
        {
          snapshots: {},
          observed_change_at: new Date(request.observed_change_at),
        },
      ],
    });
    await expect(
      confirmHostProjectMaintenanceAssignment({
        ...request,
        schedule_revision: "old-revision",
      }),
    ).resolves.toEqual({ valid: false, reason: "schedule_changed" });

    queryMock.mockResolvedValueOnce({
      rows: [
        {
          snapshots: {},
          observed_change_at: new Date("2026-09-23T22:00:00.000Z"),
        },
      ],
    });
    await expect(
      confirmHostProjectMaintenanceAssignment(request),
    ).resolves.toEqual({ valid: false, reason: "change_generation_changed" });

    queryMock.mockResolvedValueOnce({
      rows: [
        {
          snapshots: {},
          observed_change_at: new Date(request.observed_change_at),
        },
      ],
    });
    await expect(
      confirmHostProjectMaintenanceAssignment(request),
    ).resolves.toEqual({ valid: true });
    expect(queryMock.mock.calls[0][0]).toContain("host_id=$2");
  });

  it("pages provisioned projects in stable project-id order", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: "host-1" }] })
      .mockResolvedValueOnce({
        rows: [
          {
            project_id: "proj-1",
            last_edited: new Date("2026-04-10T22:00:00.000Z"),
            last_backup: null,
            backup_due_since: new Date("2026-04-10T22:00:00.000Z"),
            snapshots: { daily: 5 },
            backups: { weekly: 2, disabled: true },
            owner_account_id: "owner-1",
          },
        ],
      });

    const { listHostProjectMaintenanceSchedules } =
      await import("./host-status");

    await expect(
      listHostProjectMaintenanceSchedules({
        host_id: "host-1",
        active_days: 2,
        cursor_project_id: "proj-0",
      }),
    ).resolves.toEqual([
      {
        project_id: "proj-1",
        storage_account_id: "owner-1",
        storage_service_class: "free",
        storage_priority: 0,
        last_edited: "2026-04-10T22:00:00.000Z",
        last_backup: null,
        last_snapshot: null,
        last_snapshot_observed_at: null,
        snapshot_reconciled_change_at: null,
        snapshot_schedule_revision: "schedule-revision",
        snapshot_reconciled_schedule_revision: null,
        last_backup_observed_at: null,
        snapshot_retry_at: null,
        backup_retry_at: null,
        snapshot_failures: 0,
        backup_failures: 0,
        backup_due_since: "2026-04-10T22:00:00.000Z",
        snapshots: { daily: 5 },
        backups: { weekly: 2, disabled: true },
        max_snapshots_per_project: 8,
        max_backups_per_project: 5,
      },
    ]);

    expect(queryMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("FROM project_hosts"),
      ["host-1"],
    );
    expect(queryMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("provisioned IS TRUE"),
      ["host-1", "proj-0", 100],
    );
    const maintenanceSql = queryMock.mock.calls[1][0];
    expect(maintenanceSql).toContain("last_backup IS NULL");
    expect(maintenanceSql).toContain("> last_backup");
    expect(maintenanceSql).toContain("backups->>'disabled'");
    expect(maintenanceSql).toContain("project_id > $2::uuid");
    expect(maintenanceSql).toContain("ORDER BY project_id ASC");
    expect(maintenanceSql).toContain("LIMIT $3");
  });

  it("starts the first page with a null UUID cursor", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: "host-1" }] })
      .mockResolvedValueOnce({ rows: [] });
    const { listHostProjectMaintenanceSchedules } =
      await import("./host-status");

    await expect(
      listHostProjectMaintenanceSchedules({ host_id: "host-1" }),
    ).resolves.toEqual([]);
    expect(queryMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("$2::uuid IS NULL"),
      ["host-1", null, 100],
    );
  });

  it("filters a bounded event batch by project id and assigned host", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: "host-1" }] })
      .mockResolvedValueOnce({ rows: [] });
    const { listHostProjectMaintenanceSchedules } =
      await import("./host-status");

    await listHostProjectMaintenanceSchedules({
      host_id: "host-1",
      project_ids: ["proj-1", "proj-2"],
      limit: 50,
    });

    expect(queryMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("project_id = ANY($4::uuid[])"),
      ["host-1", null, 50, ["proj-1", "proj-2"]],
    );
  });

  it("uses the storage payer for priority and the owner for existing limits", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: "host-1" }] })
      .mockResolvedValueOnce({
        rows: [
          {
            project_id: "proj-1",
            owner_account_id: "owner-1",
            usage_account_id: "sponsor-1",
            users: {
              "owner-1": { group: "owner" },
              "sponsor-1": { group: "collaborator" },
            },
          },
        ],
      });
    resolveMembershipForAccountMock.mockImplementation(async (account_id) =>
      account_id === "sponsor-1"
        ? { source: "subscription", subscription_cost: 10 }
        : { source: "free" },
    );
    getEffectiveMembershipUsageLimitsMock.mockImplementation((resolution) =>
      resolution.source === "subscription"
        ? {
            max_snapshots_per_project: 30,
            max_backups_per_project: 10,
            shared_compute_priority: 5,
          }
        : { max_snapshots_per_project: 8, max_backups_per_project: 4 },
    );
    const { listHostProjectMaintenanceSchedules } =
      await import("./host-status");

    const rows = await listHostProjectMaintenanceSchedules({
      host_id: "host-1",
    });

    expect(rows[0]).toMatchObject({
      storage_account_id: "sponsor-1",
      storage_service_class: "paying",
      storage_priority: 5,
      max_snapshots_per_project: 8,
      max_backups_per_project: 4,
    });
    expect(resolveMembershipForAccountMock).toHaveBeenCalledWith("owner-1");
    expect(resolveMembershipForAccountMock).toHaveBeenCalledWith("sponsor-1");
  });

  it("refreshes funding class when a project's storage payer changes", async () => {
    const projectRow = {
      project_id: "proj-1",
      owner_account_id: "owner-1",
      users: {
        "owner-1": { group: "owner" },
        "sponsor-1": { group: "collaborator" },
      },
    };
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: "host-1" }] })
      .mockResolvedValueOnce({
        rows: [{ ...projectRow, usage_account_id: null }],
      })
      .mockResolvedValueOnce({ rows: [{ id: "host-1" }] })
      .mockResolvedValueOnce({
        rows: [{ ...projectRow, usage_account_id: "sponsor-1" }],
      });
    resolveMembershipForAccountMock.mockImplementation(async (account_id) =>
      account_id === "sponsor-1"
        ? { source: "subscription", subscription_cost: 10 }
        : { source: "free" },
    );
    const { listHostProjectMaintenanceSchedules } =
      await import("./host-status");

    const before = await listHostProjectMaintenanceSchedules({
      host_id: "host-1",
    });
    const after = await listHostProjectMaintenanceSchedules({
      host_id: "host-1",
    });

    expect(before[0]).toMatchObject({
      storage_account_id: "owner-1",
      storage_service_class: "free",
    });
    expect(after[0]).toMatchObject({
      storage_account_id: "sponsor-1",
      storage_service_class: "paying",
    });
  });
});

describe("initHostStatusService registerOnPremTunnel", () => {
  beforeEach(() => {
    jest.resetModules();
    createHostStatusServiceMock = jest.fn(({ impl }) => impl);
    conatMock = jest.fn(async () => ({ ok: true }));
    queryMock = jest.fn();
    resolveMembershipForAccountMock = jest.fn(async () => ({
      effective_limits: {},
    }));
    getEffectiveMembershipUsageLimitsMock = jest.fn(() => ({
      max_snapshots_per_project: 8,
      max_backups_per_project: 5,
    }));
    getLaunchpadLocalConfigMock = jest.fn(() => ({
      sshd_port: 2201,
      ssh_user: "user",
      rest_port: 9345,
    }));
    maybeStartLaunchpadOnPremServicesMock = jest.fn(async () => undefined);
    getLaunchpadRestPortMock = jest.fn(() => 9345);
    registerSelfHostTunnelKeyMock = jest.fn(async () => ({
      http_tunnel_port: 31001,
      ssh_tunnel_port: 31002,
      tunnel_public_key: "ssh-ed25519 AAAA",
      conat_router_port: 9102,
    }));
    resolveOnPremHostMock = jest.fn(() => "lite4b.cocalc.ai");
    delete process.env.COCALC_DEV_GCP_REVERSE_TUNNEL;
  });

  it("allows dev-only GCP hosts to register a reverse tunnel", async () => {
    process.env.COCALC_DEV_GCP_REVERSE_TUNNEL = "1";
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            id: "host-gcp",
            metadata: { machine: { cloud: "gcp", metadata: {} } },
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const { initHostStatusService } = await import("./host-status");
    const service: any = await initHostStatusService();
    const result = await service.registerOnPremTunnel({
      host_id: "host-gcp",
      public_key: "ssh-ed25519 AAAA host",
    });

    expect(maybeStartLaunchpadOnPremServicesMock).toHaveBeenCalled();
    expect(registerSelfHostTunnelKeyMock).toHaveBeenCalledWith({
      host_id: "host-gcp",
      public_key: "ssh-ed25519 AAAA host",
    });
    expect(result).toMatchObject({
      sshd_host: "lite4b.cocalc.ai",
      sshd_port: 2201,
      ssh_user: "user",
      http_tunnel_port: 31001,
      ssh_tunnel_port: 31002,
      rest_port: 9345,
      conat_router_port: 9102,
    });
  });
});
