/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { EventEmitter } from "events";

let connectMock: jest.Mock;
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
});
