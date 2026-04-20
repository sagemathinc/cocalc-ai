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
let resolveHostBayAcrossClusterMock: jest.Mock;
let projectHostAuthTokenIssueMock: jest.Mock;

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

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: jest.fn(() => "bay-0"),
}));

jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  getInterBayBridge: jest.fn(() => ({
    projectHostAuthToken: jest.fn(() => ({
      issue: (...args: any[]) => projectHostAuthTokenIssueMock(...args),
    })),
  })),
}));

jest.mock("@cocalc/conat/names", () => ({
  inboxPrefix: ({ account_id, hub_id }) =>
    account_id ? `inbox.${account_id}` : `inbox.${hub_id}`,
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

jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveHostBayAcrossCluster: (...args: any[]) =>
    resolveHostBayAcrossClusterMock(...args),
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
    resolveHostBayAcrossClusterMock = jest.fn(async () => null);
    projectHostAuthTokenIssueMock = jest.fn(async () => ({
      token: "remote-account-token",
      expires_at: Date.now() + 60_000,
    }));
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

  it("does not reroute direct host subjects through the generic project router", async () => {
    const central = createFakeClient();
    connectMock.mockImplementationOnce(() => central);
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

    expect(routedResult).toBeUndefined();
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

  it("issues bearer auth for explicit routed host clients during construction", async () => {
    const routed = createFakeClient();
    let authValue: any;
    let authPromise: Promise<void> | undefined;
    connectMock.mockImplementationOnce((opts) => {
      authPromise = Promise.resolve(
        opts.auth((value) => {
          authValue = value;
        }),
      );
      return routed;
    });
    materializeHostRouteTargetMock.mockResolvedValue({
      host_id: "host-3",
      address: "https://host-3.example",
    });

    const { getExplicitHostRoutedClient } = await import("./route-client");

    await expect(
      getExplicitHostRoutedClient({ host_id: "host-3" }),
    ).resolves.toBe(routed);
    await authPromise;

    expect(authValue).toEqual({ bearer: "token-1" });
    expect(connectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        address: "https://host-3.example",
        noCache: true,
        forceNew: true,
      }),
    );
  });

  it("uses account-scoped auth for account-routed project clients", async () => {
    const central = createFakeClient();
    const routed = createFakeClient();
    let authValue: any;
    let authPromise: Promise<void> | undefined;
    connectMock
      .mockImplementationOnce(() => central)
      .mockImplementationOnce((opts) => {
        authPromise = Promise.resolve(
          opts.auth((value) => {
            authValue = value;
          }),
        );
        return routed;
      });
    routeProjectSubjectMock.mockReturnValue({
      host_id: "host-local",
      address: "https://host-local.example",
    });

    const { conatWithProjectRoutingForAccount } =
      await import("./route-client");
    const client = conatWithProjectRoutingForAccount({
      account_id: "account-1",
    }) as any;
    const routedResult = client.routeSubject(
      "file-server.12345678-1234-1234-1234-123456789012.api",
    );

    expect(routedResult?.client).toBe(routed);
    await authPromise;
    expect(issueProjectHostAuthTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: "account",
        account_id: "account-1",
        host_id: "host-local",
      }),
    );
    expect(connectMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        inboxPrefix: "inbox.account-1",
      }),
    );
    expect(authValue).toEqual({ bearer: "token-1" });
  });

  it("asks the owning bay to issue account-scoped auth for remote hosts", async () => {
    const central = createFakeClient();
    const routed = createFakeClient();
    let authValue: any;
    let authPromise: Promise<void> | undefined;
    connectMock
      .mockImplementationOnce(() => central)
      .mockImplementationOnce((opts) => {
        authPromise = Promise.resolve(
          opts.auth((value) => {
            authValue = value;
          }),
        );
        return routed;
      });
    resolveHostBayAcrossClusterMock = jest.fn(async () => ({
      bay_id: "bay-7",
      epoch: 1,
    }));
    routeProjectSubjectMock.mockReturnValue({
      host_id: "host-remote",
      address: "https://host-remote.example",
    });

    const { conatWithProjectRoutingForAccount } =
      await import("./route-client");
    const client = conatWithProjectRoutingForAccount({
      account_id: "account-1",
    }) as any;
    client.routeSubject("file-server.12345678-1234-1234-1234-123456789012.api");

    await authPromise;
    expect(projectHostAuthTokenIssueMock).toHaveBeenCalledWith({
      account_id: "account-1",
      host_id: "host-remote",
    });
    expect(authValue).toEqual({ bearer: "remote-account-token" });
  });

  it("allows explicit host control clients for hosts resolved on another bay", async () => {
    const central = createFakeClient();
    connectMock.mockImplementationOnce(() => central);
    materializeHostRouteTargetMock.mockResolvedValue(undefined);
    resolveHostBayAcrossClusterMock.mockResolvedValue({
      bay_id: "bay-7",
      epoch: 0,
    });

    const { getExplicitHostControlClient } = await import("./route-client");

    await expect(
      getExplicitHostControlClient({ host_id: "host-9" }),
    ).resolves.toBe(central);
  });
});
