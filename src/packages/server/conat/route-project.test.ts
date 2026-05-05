/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

let queryMock: jest.Mock;
let warnMock: jest.Mock;
let debugMock: jest.Mock;
let resolveProjectBayAcrossClusterMock: jest.Mock;
let projectReferenceGetMock: jest.Mock;
let hostConnectionGetMock: jest.Mock;

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    warn: (...args: any[]) => warnMock(...args),
    debug: (...args: any[]) => debugMock(...args),
  })),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    query: (...args: any[]) => queryMock(...args),
  })),
}));

jest.mock("@cocalc/server/inter-bay/directory", () => ({
  __esModule: true,
  resolveProjectBayAcrossCluster: (...args: any[]) =>
    resolveProjectBayAcrossClusterMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  __esModule: true,
  getInterBayBridge: jest.fn(() => ({
    projectReference: jest.fn(() => ({
      get: (...args: any[]) => projectReferenceGetMock(...args),
    })),
    hostConnection: jest.fn(() => ({
      get: (...args: any[]) => hostConnectionGetMock(...args),
    })),
  })),
}));

describe("route-project bay-aware routing", () => {
  const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
  const HOST_ID = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    jest.resetModules();
    jest.useRealTimers();
    queryMock = jest.fn();
    warnMock = jest.fn();
    debugMock = jest.fn();
    resolveProjectBayAcrossClusterMock = jest.fn(async () => null);
    projectReferenceGetMock = jest.fn(async () => null);
    hostConnectionGetMock = jest.fn(async () => null);
  });

  it("routes a project through a host in the same bay and caches the target", async () => {
    queryMock.mockResolvedValue({
      rows: [
        {
          host_id: HOST_ID,
          resolved_host_id: HOST_ID,
          project_owning_bay_id: "bay-0",
          host_bay_id: "bay-0",
          internal_url: "http://host.internal:9000",
          public_url: "https://host.example.com",
          metadata: {
            host_session_id: "session-1",
            machine: {},
          },
        },
      ],
    });

    const { materializeProjectHostTarget, routeProjectSubject } =
      await import("./route-project");

    expect(
      await materializeProjectHostTarget(PROJECT_ID, { fresh: true }),
    ).toEqual({
      address: "http://host.internal:9000",
      host_id: HOST_ID,
      host_session_id: "session-1",
    });
    expect(routeProjectSubject(`project.${PROJECT_ID}.api`)).toEqual({
      address: "http://host.internal:9000",
      host_id: HOST_ID,
      host_session_id: "session-1",
    });
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it("refuses to route a project through a host in a different bay", async () => {
    queryMock.mockResolvedValue({
      rows: [
        {
          host_id: HOST_ID,
          resolved_host_id: HOST_ID,
          project_owning_bay_id: "bay-0",
          host_bay_id: "bay-7",
          internal_url: "http://host.internal:9000",
          public_url: "https://host.example.com",
          metadata: {
            machine: {},
          },
        },
      ],
    });

    const { materializeProjectHostTarget, routeProjectSubject } =
      await import("./route-project");

    await expect(
      materializeProjectHostTarget(PROJECT_ID, { fresh: true }),
    ).resolves.toBeUndefined();
    expect(routeProjectSubject(`project.${PROJECT_ID}`)).toBeUndefined();
    expect(warnMock).toHaveBeenCalledWith(
      "refusing project route with mismatched bay ownership",
      expect.objectContaining({
        project_id: PROJECT_ID,
        host_id: HOST_ID,
        project_bay_id: "bay-0",
        host_bay_id: "bay-7",
      }),
    );
  });

  it("refuses to route a project when the assigned host is no longer visible", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          host_id: HOST_ID,
          resolved_host_id: null,
          project_owning_bay_id: "bay-0",
          host_bay_id: "bay-0",
          internal_url: null,
          public_url: null,
          metadata: null,
        },
      ],
    });

    const { materializeProjectHostTarget, routeProjectSubject } =
      await import("./route-project");

    await expect(
      materializeProjectHostTarget(PROJECT_ID, { fresh: true }),
    ).resolves.toBeUndefined();
    expect(routeProjectSubject(`project.${PROJECT_ID}`)).toBeUndefined();
    expect(warnMock).not.toHaveBeenCalled();
  });

  it("refuses to route a project when the assigned host is not running", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          host_id: HOST_ID,
          resolved_host_id: null,
          project_owning_bay_id: "bay-0",
          host_bay_id: "bay-0",
          internal_url: null,
          public_url: null,
          metadata: null,
        },
      ],
    });

    const { materializeProjectHostTarget, routeProjectSubject } =
      await import("./route-project");

    await expect(
      materializeProjectHostTarget(PROJECT_ID, { fresh: true }),
    ).resolves.toBeUndefined();
    expect(routeProjectSubject(`project.${PROJECT_ID}`)).toBeUndefined();
    expect(warnMock).not.toHaveBeenCalled();
  });

  it("materializes a remote collaborator project through the owning bay host connection", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    resolveProjectBayAcrossClusterMock = jest.fn(async () => ({
      bay_id: "bay-7",
      epoch: 4,
    }));
    projectReferenceGetMock = jest.fn(async () => ({
      project_id: PROJECT_ID,
      host_id: HOST_ID,
    }));
    hostConnectionGetMock = jest.fn(async () => ({
      host_id: HOST_ID,
      connect_url: "https://remote-host.example.com",
      host_session_id: "remote-session",
    }));

    const { materializeRemoteProjectHostTarget, routeProjectSubject } =
      await import("./route-project");

    await expect(
      materializeRemoteProjectHostTarget({
        account_id: "account-1",
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual({
      address: "https://remote-host.example.com",
      host_id: HOST_ID,
      host_session_id: "remote-session",
    });
    expect(resolveProjectBayAcrossClusterMock).toHaveBeenCalledWith(PROJECT_ID);
    expect(projectReferenceGetMock).toHaveBeenCalledWith({
      account_id: "account-1",
      project_id: PROJECT_ID,
    });
    expect(hostConnectionGetMock).toHaveBeenCalledWith({
      account_id: "account-1",
      host_id: HOST_ID,
    });
    expect(routeProjectSubject(`file-server.${PROJECT_ID}.api`)).toEqual({
      address: "https://remote-host.example.com",
      host_id: HOST_ID,
      host_session_id: "remote-session",
    });
  });

  it("routes direct host subjects through a host in the same bay", async () => {
    queryMock.mockResolvedValue({
      rows: [
        {
          resolved_host_id: HOST_ID,
          host_bay_id: "bay-0",
          internal_url: "http://host.internal:9000",
          public_url: "https://host.example.com",
          metadata: {
            host_session_id: "session-2",
            machine: {},
          },
        },
      ],
    });

    const { materializeHostRouteTarget, routeHostSubject } =
      await import("./route-project");

    expect(await materializeHostRouteTarget(HOST_ID, { fresh: true })).toEqual({
      address: "http://host.internal:9000",
      host_id: HOST_ID,
      host_session_id: "session-2",
    });
    expect(routeHostSubject(`project-host.${HOST_ID}.api`)).toEqual({
      address: "http://host.internal:9000",
      host_id: HOST_ID,
      host_session_id: "session-2",
    });
    expect(warnMock).not.toHaveBeenCalled();
  });

  it("refuses to route a direct host subject owned by another bay", async () => {
    queryMock.mockResolvedValue({
      rows: [
        {
          resolved_host_id: HOST_ID,
          host_bay_id: "bay-9",
          internal_url: "http://host.internal:9000",
          public_url: "https://host.example.com",
          metadata: {
            machine: {},
          },
        },
      ],
    });

    const { materializeHostRouteTarget, routeHostSubject } =
      await import("./route-project");

    await expect(
      materializeHostRouteTarget(HOST_ID, { fresh: true }),
    ).resolves.toBeUndefined();
    expect(routeHostSubject(`project-host.${HOST_ID}.api`)).toBeUndefined();
    expect(warnMock).toHaveBeenCalledWith(
      "refusing host route owned by another bay",
      expect.objectContaining({
        host_id: HOST_ID,
        host_bay_id: "bay-9",
        current_bay_id: "bay-0",
      }),
    );
  });

  it("refuses to route a direct host subject when the host is not running", async () => {
    queryMock.mockResolvedValue({
      rows: [],
    });

    const { materializeHostRouteTarget, routeHostSubject } =
      await import("./route-project");

    await expect(
      materializeHostRouteTarget(HOST_ID, { fresh: true }),
    ).resolves.toBeUndefined();
    expect(routeHostSubject(`project-host.${HOST_ID}.api`)).toBeUndefined();
    expect(warnMock).not.toHaveBeenCalled();
  });

  it("durably polls route invalidations and refreshes cached project routes", async () => {
    jest.useFakeTimers();
    let projectFetchCount = 0;
    let invalidationPollCount = 0;
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM project_host_route_invalidations")) {
        invalidationPollCount += 1;
        if (invalidationPollCount === 1) {
          return {
            rows: [{ event_id: 1, project_id: PROJECT_ID, host_id: null }],
          };
        }
        return { rows: [] };
      }
      if (sql.includes("FROM projects")) {
        projectFetchCount += 1;
        return {
          rows: [
            {
              host_id: HOST_ID,
              resolved_host_id: HOST_ID,
              project_owning_bay_id: "bay-0",
              host_bay_id: "bay-0",
              internal_url:
                projectFetchCount === 1
                  ? "http://host-a.internal:9000"
                  : "http://host-b.internal:9000",
              public_url: "https://host.example.com",
              metadata: {
                host_session_id:
                  projectFetchCount === 1 ? "session-a" : "session-b",
                machine: {},
              },
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const {
      listenForUpdates,
      materializeProjectHostTarget,
      routeProjectSubject,
    } = await import("./route-project");

    expect(
      await materializeProjectHostTarget(PROJECT_ID, { fresh: true }),
    ).toEqual({
      address: "http://host-a.internal:9000",
      host_id: HOST_ID,
      host_session_id: "session-a",
    });

    await listenForUpdates();
    await jest.advanceTimersByTimeAsync(1_000);

    expect(routeProjectSubject(`project.${PROJECT_ID}.api`)).toEqual({
      address: "http://host-b.internal:9000",
      host_id: HOST_ID,
      host_session_id: "session-b",
    });
    expect(projectFetchCount).toBe(2);
  });

  it("records route invalidations durably while evicting local host caches", async () => {
    let hostFetchCount = 0;
    queryMock.mockImplementation(async (sql: string, values?: any[]) => {
      if (sql.includes("INSERT INTO project_host_route_invalidations")) {
        expect(values).toEqual([null, HOST_ID]);
        return { rows: [] };
      }
      if (sql.includes("DELETE FROM project_host_route_invalidations")) {
        return { rows: [] };
      }
      if (sql.includes("FROM project_hosts")) {
        hostFetchCount += 1;
        return {
          rows: [
            {
              resolved_host_id: HOST_ID,
              host_bay_id: "bay-0",
              internal_url:
                hostFetchCount === 1
                  ? "http://host-a.internal:9000"
                  : "http://host-b.internal:9000",
              public_url: "https://host.example.com",
              metadata: {
                host_session_id:
                  hostFetchCount === 1 ? "session-a" : "session-b",
                machine: {},
              },
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const {
      materializeHostRouteTarget,
      notifyProjectHostUpdate,
      routeHostSubject,
    } = await import("./route-project");

    expect(await materializeHostRouteTarget(HOST_ID, { fresh: true })).toEqual({
      address: "http://host-a.internal:9000",
      host_id: HOST_ID,
      host_session_id: "session-a",
    });

    await notifyProjectHostUpdate({ host_id: HOST_ID });
    await Promise.resolve();
    await Promise.resolve();

    expect(routeHostSubject(`project-host.${HOST_ID}.api`)).toEqual({
      address: "http://host-b.internal:9000",
      host_id: HOST_ID,
      host_session_id: "session-b",
    });
    expect(hostFetchCount).toBe(2);
  });
});
