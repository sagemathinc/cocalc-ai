/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { EventEmitter } from "events";

let connectMock: jest.Mock;
let materializeHostRouteTargetMock: jest.Mock;
let materializeProjectHostTargetMock: jest.Mock;
let routeHostSubjectMock: jest.Mock;
let routeProjectSubjectMock: jest.Mock;
let listenForUpdatesMock: jest.Mock;
let issueProjectHostAuthTokenMock: jest.Mock;

jest.mock("@cocalc/backend/data", () => ({
  conatPassword: "hub-password",
  conatServer: "https://hub.example",
  getProjectHostAuthTokenPrivateKey: () => "private-key",
}));

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: () => ({
    debug: jest.fn(),
  }),
}));

jest.mock("@cocalc/backend/auth/cookie-names", () => ({
  HUB_PASSWORD_COOKIE_NAME: "hub_cookie",
}));

jest.mock("@cocalc/conat/names", () => ({
  inboxPrefix: ({ hub_id }) => `inbox.${hub_id}`,
}));

jest.mock("@cocalc/conat/auth/project-host-token", () => ({
  issueProjectHostAuthToken: (...args: any[]) =>
    issueProjectHostAuthTokenMock(...args),
}));

jest.mock("@cocalc/conat/core/client", () => ({
  connect: (...args: any[]) => connectMock(...args),
}));

jest.mock("./route-project", () => ({
  materializeHostRouteTarget: (...args: any[]) =>
    materializeHostRouteTargetMock(...args),
  materializeProjectHostTarget: (...args: any[]) =>
    materializeProjectHostTargetMock(...args),
  routeHostSubject: (...args: any[]) => routeHostSubjectMock(...args),
  routeProjectSubject: (...args: any[]) => routeProjectSubjectMock(...args),
  listenForUpdates: (...args: any[]) => listenForUpdatesMock(...args),
}));

function createFakeClient() {
  const emitter = new EventEmitter() as any;
  emitter.conn = new EventEmitter() as any;
  emitter.conn.io = new EventEmitter() as any;
  emitter.conn.connected = false;
  emitter.setRouteSubject = jest.fn((fn) => {
    emitter.routeSubject = fn;
    return emitter;
  });
  emitter.connect = jest.fn(() => {
    emitter.conn.connected = true;
  });
  emitter.close = jest.fn(() => {
    emitter.emit("closed");
  });
  return emitter;
}

describe("server/conat route-client", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.resetModules();
    connectMock = jest.fn();
    materializeHostRouteTargetMock = jest.fn();
    materializeProjectHostTargetMock = jest.fn();
    routeHostSubjectMock = jest.fn();
    routeProjectSubjectMock = jest.fn();
    listenForUpdatesMock = jest.fn(async () => undefined);
    issueProjectHostAuthTokenMock = jest.fn(() => ({
      token: "token-1",
      expires_at: Date.now() + 60_000,
    }));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("reconnects routed host clients after connect_error", async () => {
    const central = createFakeClient();
    const routed = createFakeClient();
    connectMock
      .mockImplementationOnce(() => central)
      .mockImplementationOnce(() => routed);
    routeProjectSubjectMock.mockReturnValue({
      host_id: "host-1",
      address: "https://host-1.example",
    });
    routeHostSubjectMock.mockReturnValue(undefined);

    const { conatWithProjectRouting } = await import("./route-client");
    const client = conatWithProjectRouting() as any;
    const routedResult = client.routeSubject(
      "project.12345678-1234-1234-1234-123456789012.api",
    );

    expect(routedResult?.client).toBe(routed);

    routed.conn.emit("connect_error", new Error("websocket error"));
    jest.advanceTimersByTime(1_000);

    expect(routed.connect).toHaveBeenCalled();
  });

  it("evicts closed routed clients so the next request recreates them", async () => {
    const central = createFakeClient();
    const routed1 = createFakeClient();
    const routed2 = createFakeClient();
    connectMock
      .mockImplementationOnce(() => central)
      .mockImplementationOnce(() => routed1)
      .mockImplementationOnce(() => routed2);
    routeProjectSubjectMock.mockReturnValue({
      host_id: "host-1",
      address: "https://host-1.example",
    });
    routeHostSubjectMock.mockReturnValue(undefined);

    const { conatWithProjectRouting } = await import("./route-client");
    const client = conatWithProjectRouting() as any;
    const first = client.routeSubject(
      "project.12345678-1234-1234-1234-123456789012.api",
    );
    expect(first?.client).toBe(routed1);

    routed1.emit("closed");

    const second = client.routeSubject(
      "project.12345678-1234-1234-1234-123456789012.api",
    );
    expect(second?.client).toBe(routed2);
  });

  it("recreates routed clients when the host session changes", async () => {
    const central = createFakeClient();
    const routed1 = createFakeClient();
    const routed2 = createFakeClient();
    connectMock
      .mockImplementationOnce(() => central)
      .mockImplementationOnce(() => routed1)
      .mockImplementationOnce(() => routed2);
    routeProjectSubjectMock
      .mockReturnValueOnce({
        host_id: "host-1",
        host_session_id: "session-1",
        address: "https://host-1.example",
      })
      .mockReturnValueOnce({
        host_id: "host-1",
        host_session_id: "session-2",
        address: "https://host-1.example",
      });
    routeHostSubjectMock.mockReturnValue(undefined);

    const { conatWithProjectRouting } = await import("./route-client");
    const client = conatWithProjectRouting() as any;

    const first = client.routeSubject(
      "project.12345678-1234-1234-1234-123456789012.api",
    );
    const second = client.routeSubject(
      "project.12345678-1234-1234-1234-123456789012.api",
    );

    expect(first?.client).toBe(routed1);
    expect(second?.client).toBe(routed2);
    expect(routed1.close).toHaveBeenCalled();
  });

  it("routes direct host subjects through explicit host routing", async () => {
    const central = createFakeClient();
    const routed = createFakeClient();
    connectMock
      .mockImplementationOnce(() => central)
      .mockImplementationOnce(() => routed);
    routeHostSubjectMock.mockReturnValue({
      host_id: "host-2",
      address: "https://host-2.example",
    });
    routeProjectSubjectMock.mockReturnValue(undefined);

    const { conatWithProjectRouting } = await import("./route-client");
    const client = conatWithProjectRouting() as any;
    const routedResult = client.routeSubject(
      "project-host.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.api",
    );

    expect(routedResult?.client).toBe(routed);
  });

  it("materializes explicit routed host clients", async () => {
    const routed = createFakeClient();
    connectMock.mockImplementationOnce(() => routed);
    materializeHostRouteTargetMock.mockResolvedValue({
      host_id: "host-3",
      address: "https://host-3.example",
    });

    const { getExplicitHostRoutedClient } = await import("./route-client");

    await expect(
      getExplicitHostRoutedClient({ host_id: "host-3" }),
    ).resolves.toBe(routed);
  });
});
