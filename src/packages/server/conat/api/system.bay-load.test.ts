export {};

let isAdminMock: jest.Mock;
let getSingleBayInfoMock: jest.Mock;
let getPoolMock: jest.Mock;
let queryMock: jest.Mock;
let getParallelOpsStatusMock: jest.Mock;
let getAccountProjectIndexProjectionBacklogStatusMock: jest.Mock;
let getAccountCollaboratorIndexProjectionBacklogStatusMock: jest.Mock;
let getAccountNotificationIndexProjectionBacklogStatusMock: jest.Mock;
let getAccountProjectIndexProjectionMaintenanceStatusMock: jest.Mock;
let getAccountCollaboratorIndexProjectionMaintenanceStatusMock: jest.Mock;
let getAccountNotificationIndexProjectionMaintenanceStatusMock: jest.Mock;
let conatMock: jest.Mock;
let sysApiManyMock: jest.Mock;
let getProjectBackupInfrastructureStatusMock: jest.Mock;

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  getLogger: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
  default: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: any[]) => isAdminMock(...args),
}));

jest.mock("@cocalc/server/bay-directory", () => ({
  __esModule: true,
  getSingleBayInfo: (...args: any[]) => getSingleBayInfoMock(...args),
  listConfiguredBays: jest.fn(),
  resolveAccountHomeBay: jest.fn(),
  resolveHostBay: jest.fn(),
  resolveProjectOwningBay: jest.fn(),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: (...args: any[]) => getPoolMock(...args),
}));

jest.mock("@cocalc/database", () => ({
  __esModule: true,
  db: {},
}));

jest.mock("@cocalc/server/lro/worker-status", () => ({
  __esModule: true,
  getParallelOpsStatus: (...args: any[]) => getParallelOpsStatusMock(...args),
}));

jest.mock("@cocalc/database/postgres/account-project-index-projector", () => ({
  __esModule: true,
  drainAccountProjectIndexProjection: jest.fn(),
  getAccountProjectIndexProjectionBacklogStatus: (...args: any[]) =>
    getAccountProjectIndexProjectionBacklogStatusMock(...args),
}));

jest.mock(
  "@cocalc/database/postgres/account-collaborator-index-projector",
  () => ({
    __esModule: true,
    drainAccountCollaboratorIndexProjection: jest.fn(),
    getAccountCollaboratorIndexProjectionBacklogStatus: (...args: any[]) =>
      getAccountCollaboratorIndexProjectionBacklogStatusMock(...args),
  }),
);

jest.mock(
  "@cocalc/database/postgres/account-notification-index-projector",
  () => ({
    __esModule: true,
    drainAccountNotificationIndexProjection: jest.fn(),
    getAccountNotificationIndexProjectionBacklogStatus: (...args: any[]) =>
      getAccountNotificationIndexProjectionBacklogStatusMock(...args),
  }),
);

jest.mock(
  "@cocalc/server/projections/account-project-index-maintenance",
  () => ({
    __esModule: true,
    getAccountProjectIndexProjectionMaintenanceStatus: (...args: any[]) =>
      getAccountProjectIndexProjectionMaintenanceStatusMock(...args),
  }),
);

jest.mock(
  "@cocalc/server/projections/account-collaborator-index-maintenance",
  () => ({
    __esModule: true,
    getAccountCollaboratorIndexProjectionMaintenanceStatus: (...args: any[]) =>
      getAccountCollaboratorIndexProjectionMaintenanceStatusMock(...args),
  }),
);

jest.mock(
  "@cocalc/server/projections/account-notification-index-maintenance",
  () => ({
    __esModule: true,
    getAccountNotificationIndexProjectionMaintenanceStatus: (...args: any[]) =>
      getAccountNotificationIndexProjectionMaintenanceStatusMock(...args),
  }),
);

jest.mock("@cocalc/backend/conat", () => ({
  __esModule: true,
  conat: (...args: any[]) => conatMock(...args),
}));

jest.mock("@cocalc/conat/core/sys", () => ({
  __esModule: true,
  sysApiMany: (...args: any[]) => sysApiManyMock(...args),
}));

jest.mock("@cocalc/server/project-backup", () => ({
  __esModule: true,
  getProjectBackupInfrastructureStatus: (...args: any[]) =>
    getProjectBackupInfrastructureStatusMock(...args),
}));

describe("getBayLoad", () => {
  beforeEach(() => {
    jest.resetModules();
    isAdminMock = jest.fn(async () => true);
    getSingleBayInfoMock = jest.fn(() => ({
      bay_id: "bay-0",
      label: "bay-0",
      region: null,
      deployment_mode: "single-bay",
      role: "combined",
      is_default: true,
    }));
    queryMock = jest.fn(async () => ({ rows: [{ count: "4" }] }));
    getPoolMock = jest.fn(() => ({ query: queryMock }));
    getParallelOpsStatusMock = jest.fn(async () => [
      {
        worker_kind: "project-backup",
        category: "lro",
        queued_count: 2,
        running_count: 1,
        stale_running_count: 0,
        worker_instances: 1,
      },
      {
        worker_kind: "cloud-vm-work",
        category: "cloud-work",
        queued_count: 0,
        running_count: 3,
        stale_running_count: null,
        worker_instances: 2,
      },
    ]);
    getAccountProjectIndexProjectionBacklogStatusMock = jest.fn(async () => ({
      unpublished_events: 5,
      oldest_unpublished_event_age_ms: 1234,
    }));
    getAccountCollaboratorIndexProjectionBacklogStatusMock = jest.fn(
      async () => ({
        unpublished_events: 0,
        oldest_unpublished_event_age_ms: null,
      }),
    );
    getAccountNotificationIndexProjectionBacklogStatusMock = jest.fn(
      async () => ({
        unpublished_events: 1,
        oldest_unpublished_event_age_ms: 250,
      }),
    );
    getAccountProjectIndexProjectionMaintenanceStatusMock = jest.fn(() => ({
      running: false,
      last_success_at: "2026-04-07T07:00:00.000Z",
    }));
    getAccountCollaboratorIndexProjectionMaintenanceStatusMock = jest.fn(
      () => ({
        running: true,
        last_success_at: "2026-04-07T07:01:00.000Z",
      }),
    );
    getAccountNotificationIndexProjectionMaintenanceStatusMock = jest.fn(
      () => ({
        running: false,
        last_success_at: null,
      }),
    );
    const waitUntilSignedIn = jest.fn(async () => undefined);
    conatMock = jest.fn(() => ({ waitUntilSignedIn }));
    sysApiManyMock = jest.fn(() => ({
      stats: async () => [
        {
          nodeA: {
            socket1: {
              user: { account_id: "acct-1" },
              browser_id: "browser-1",
              connected: Date.now(),
            },
            socket2: {
              user: { account_id: "acct-1" },
              browser_id: "browser-1",
              connected: Date.now(),
            },
            socket3: {
              user: { account_id: "acct-2" },
              browser_id: "browser-9",
              connected: Date.now(),
            },
          },
        },
      ],
    }));
    getProjectBackupInfrastructureStatusMock = jest.fn(async () => ({
      r2: {
        configured: true,
        account_id_configured: true,
        access_key_configured: true,
        secret_key_configured: true,
        bucket_prefix: "lite4-dev",
        total_buckets: 2,
        active_buckets: 1,
        buckets: [
          {
            id: "bucket-1",
            name: "lite4-dev-wnam",
            region: "wnam",
            location: null,
            status: "active",
          },
        ],
      },
      repos: {
        total_repos: 2,
        active_repos: 1,
        assigned_projects: 7,
        repos: [
          {
            id: "repo-1",
            region: "wnam",
            bucket_id: "bucket-1",
            bucket_name: "lite4-dev-wnam",
            root: "rustic/shared-wnam-0001",
            status: "active",
            assigned_project_count: 7,
            created: "2026-04-07T06:00:00.000Z",
            updated: "2026-04-07T07:00:00.000Z",
          },
        ],
      },
      projects: {
        total_projects: 9,
        host_assigned_projects: 8,
        provisioned_projects: 6,
        running_projects: 2,
        repo_assigned_projects: 7,
        repo_unassigned_projects: 1,
        provisioned_up_to_date: 4,
        provisioned_needs_backup: 2,
        never_backed_up: 3,
        latest_last_backup_at: "2026-04-07T07:05:00.000Z",
      },
    }));
  });

  it("returns a current bay load snapshot", async () => {
    const { getBayLoad } = await import("./system");

    await expect(
      getBayLoad({
        account_id: "11111111-1111-4111-8111-111111111111",
      }),
    ).resolves.toMatchObject({
      bay_id: "bay-0",
      browser_control: {
        active_accounts: 2,
        active_browsers: 2,
        active_connections: 3,
      },
      hosts: {
        total_hosts: 4,
      },
      parallel_ops: {
        worker_count: 2,
        queued_total: 2,
        running_total: 4,
        stale_running_total: 0,
        hotspots: [
          expect.objectContaining({
            worker_kind: "cloud-vm-work",
            running_count: 3,
          }),
          expect.objectContaining({
            worker_kind: "project-backup",
            queued_count: 2,
          }),
        ],
      },
      projections: {
        account_project_index: {
          unpublished_events: 5,
          maintenance_running: false,
        },
        account_collaborator_index: {
          unpublished_events: 0,
          maintenance_running: true,
        },
        account_notification_index: {
          unpublished_events: 1,
          maintenance_running: false,
        },
      },
    });

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("FROM project_hosts"),
      ["bay-0"],
    );
  });

  it("rejects unknown bay ids in one-bay mode", async () => {
    const { getBayLoad } = await import("./system");

    await expect(
      getBayLoad({
        account_id: "11111111-1111-4111-8111-111111111111",
        bay_id: "bay-9",
      }),
    ).rejects.toThrow("bay 'bay-9' not found");
  });

  it("returns a current bay backup snapshot", async () => {
    const { getBayBackups } = await import("./system");

    await expect(
      getBayBackups({
        account_id: "11111111-1111-4111-8111-111111111111",
      }),
    ).resolves.toMatchObject({
      bay_id: "bay-0",
      r2: {
        configured: true,
        total_buckets: 2,
        active_buckets: 1,
      },
      repos: {
        total_repos: 2,
        active_repos: 1,
        assigned_projects: 7,
      },
      projects: {
        total_projects: 9,
        provisioned_needs_backup: 2,
        latest_last_backup_at: "2026-04-07T07:05:00.000Z",
      },
      backup_admission: expect.objectContaining({
        worker_kind: "project-backup",
        queued_count: 2,
        running_count: 1,
      }),
      backup_execution: null,
    });

    expect(getProjectBackupInfrastructureStatusMock).toHaveBeenCalledWith({
      bay_id: "bay-0",
    });
  });
});
