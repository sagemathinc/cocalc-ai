export {};

let createServiceClientMock: jest.Mock;
let createServiceHandlerMock: jest.Mock;

jest.mock("@cocalc/conat/service/typed", () => ({
  __esModule: true,
  createServiceClient: (...args: any[]) => createServiceClientMock(...args),
  createServiceHandler: (...args: any[]) => createServiceHandlerMock(...args),
}));

describe("host maintenance client", () => {
  beforeEach(() => {
    jest.resetModules();
    // Match the real typed client: its get trap returns a generated RPC method
    // even when a property has been assigned to the proxy target.
    createServiceClientMock = jest.fn(
      () =>
        new Proxy(
          {},
          {
            get: () => jest.fn(),
          },
        ),
    );
    createServiceHandlerMock = jest.fn();
  });

  it("routes maintenance methods through the host-scoped Hub API", async () => {
    const request = jest.fn(async () => ({ data: { valid: true } }));
    const { createHostStatusClient } = await import("./api");
    const status = createHostStatusClient({
      client: { request } as any,
      timeout: 60_000,
    });
    await status.listProjectMaintenanceSchedules({ host_id: "host-1" });
    await status.confirmProjectMaintenanceAssignment({
      host_id: "host-1",
      project_id: "project-1",
      kind: "backup",
      schedule_revision: "revision-1",
      observed_change_at: null,
    });
    await status.reportProjectMaintenance({
      host_id: "host-1",
      project_id: "project-1",
      kind: "backup",
      observed_at: "2026-09-25T00:00:00.000Z",
      outcome: "deferred",
    });
    expect(request).toHaveBeenCalledTimes(3);
    expect(
      request.mock.calls.map(([subject, data]) => [subject, data.name]),
    ).toEqual([
      ["hub.host.host-1.api", "hosts.listProjectMaintenanceSchedules"],
      ["hub.host.host-1.api", "hosts.confirmProjectMaintenanceAssignment"],
      ["hub.host.host-1.api", "hosts.reportProjectMaintenance"],
    ]);
  });
});

describe("createHostControlClient", () => {
  beforeEach(() => {
    jest.resetModules();
    createServiceClientMock = jest.fn(() => ({ kind: "host-control-client" }));
    createServiceHandlerMock = jest.fn(() => ({
      kind: "host-control-service",
    }));
  });

  it("uses request transport when timeout exceeds MAX_INTEREST_TIMEOUT", async () => {
    const { MAX_INTEREST_TIMEOUT } = await import("@cocalc/conat/core/client");
    const { createHostControlClient } = await import("./api");

    createHostControlClient({
      host_id: "host-1",
      client: {} as any,
      timeout: MAX_INTEREST_TIMEOUT + 1,
    });

    expect(createServiceClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        service: "project-host",
        subject: "project-host.host-1.api",
        timeout: MAX_INTEREST_TIMEOUT + 1,
        transport: "request",
      }),
    );
  });

  it("keeps fast-rpc transport for short host control calls", async () => {
    const { MAX_INTEREST_TIMEOUT } = await import("@cocalc/conat/core/client");
    const { createHostControlClient } = await import("./api");

    createHostControlClient({
      host_id: "host-1",
      client: {} as any,
      timeout: MAX_INTEREST_TIMEOUT,
    });

    expect(createServiceClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        service: "project-host",
        subject: "project-host.host-1.api",
        timeout: MAX_INTEREST_TIMEOUT,
        transport: undefined,
      }),
    );
  });
});

describe("createHostControlService", () => {
  beforeEach(() => {
    jest.resetModules();
    createServiceClientMock = jest.fn();
    createServiceHandlerMock = jest.fn(() => ({
      kind: "host-control-service",
    }));
  });

  it("dispatches long-running host control requests concurrently with a bound", async () => {
    const { createHostControlService } = await import("./api");
    const client = {} as any;
    const impl = {} as any;

    createHostControlService({ host_id: "host-1", client, impl });

    expect(createServiceHandlerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        service: "project-host",
        subject: "project-host.host-1.api",
        client,
        impl,
        parallel: true,
        maxParallelHandlers: 64,
      }),
    );
  });
});
