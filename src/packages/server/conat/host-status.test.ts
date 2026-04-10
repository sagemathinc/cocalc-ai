export {};

let queryMock: jest.Mock;

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

jest.mock("@cocalc/backend/conat", () => ({
  __esModule: true,
  conat: jest.fn(),
}));

jest.mock("@cocalc/conat/project-host/api", () => ({
  __esModule: true,
  createHostStatusService: jest.fn(),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    query: (...args: any[]) => queryMock(...args),
  })),
}));

jest.mock("@cocalc/server/launchpad/mode", () => ({
  __esModule: true,
  getLaunchpadLocalConfig: jest.fn(),
}));

jest.mock("@cocalc/server/onprem", () => ({
  __esModule: true,
  resolveOnPremHost: jest.fn(),
}));

jest.mock("@cocalc/server/launchpad/onprem-sshd", () => ({
  __esModule: true,
  maybeStartLaunchpadOnPremServices: jest.fn(),
  getLaunchpadRestPort: jest.fn(),
  registerSelfHostTunnelKey: jest.fn(),
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
    queryMock = jest.fn();
  });

  it("lists only provisioned active projects for the host and maps timestamps", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: "host-1" }] })
      .mockResolvedValueOnce({
        rows: [
          {
            project_id: "proj-1",
            last_edited: new Date("2026-04-10T22:00:00.000Z"),
            snapshots: { daily: 5 },
            backups: { weekly: 2, disabled: true },
          },
        ],
      });

    const { listHostProjectMaintenanceSchedules } =
      await import("./host-status");

    await expect(
      listHostProjectMaintenanceSchedules({
        host_id: "host-1",
        active_days: 2,
      }),
    ).resolves.toEqual([
      {
        project_id: "proj-1",
        last_edited: "2026-04-10T22:00:00.000Z",
        snapshots: { daily: 5 },
        backups: { weekly: 2, disabled: true },
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
      ["host-1", 2],
    );
  });
});
