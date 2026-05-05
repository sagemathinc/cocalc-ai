export {};

let createServiceClientMock: jest.Mock;

jest.mock("@cocalc/conat/service/typed", () => ({
  __esModule: true,
  createServiceClient: (...args: any[]) => createServiceClientMock(...args),
  createServiceHandler: jest.fn(),
}));

describe("createHostControlClient", () => {
  beforeEach(() => {
    jest.resetModules();
    createServiceClientMock = jest.fn(() => ({ kind: "host-control-client" }));
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
