const callHub = jest.fn();

jest.mock("@cocalc/backend/logger", () => {
  const factory = () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  });
  return {
    __esModule: true,
    default: factory,
    getLogger: factory,
  };
});

jest.mock("@cocalc/conat/hub/call-hub", () => ({
  __esModule: true,
  default: (...args: any[]) => callHub(...args),
}));

jest.mock("./master-status", () => ({
  getMasterConatClient: jest.fn(() => ({ id: "master-client" })),
}));

jest.mock("./sqlite/hosts", () => ({
  getLocalHostId: jest.fn(() => "11111111-1111-4111-8111-111111111111"),
}));

describe("project-host last edited queue", () => {
  beforeEach(() => {
    jest.resetModules();
    callHub.mockReset();
  });

  it("queues project touches locally and flushes them in the resend loop", async () => {
    const mod = await import("./last-edited");

    await mod.touchProjectLastEdited(
      "22222222-2222-4222-8222-222222222222",
      "browser-touch",
    );
    expect(callHub).not.toHaveBeenCalled();

    await mod.reportPendingProjectTouches();

    expect(callHub).toHaveBeenCalledTimes(1);
    expect(callHub).toHaveBeenCalledWith({
      client: { id: "master-client" },
      host_id: "11111111-1111-4111-8111-111111111111",
      name: "hosts.touchProject",
      args: [{ project_id: "22222222-2222-4222-8222-222222222222" }],
      timeout: 5000,
    });

    await mod.reportPendingProjectTouches();
    expect(callHub).toHaveBeenCalledTimes(1);
  });
});
