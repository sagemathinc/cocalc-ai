/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

let queryMock: jest.Mock;
let warnMock: jest.Mock;
let debugMock: jest.Mock;

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
  getPglitePgClient: jest.fn(),
  isPgliteEnabled: jest.fn(() => false),
}));

describe("route-project bay-aware routing", () => {
  const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
  const HOST_ID = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    jest.resetModules();
    queryMock = jest.fn();
    warnMock = jest.fn();
    debugMock = jest.fn();
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
});
