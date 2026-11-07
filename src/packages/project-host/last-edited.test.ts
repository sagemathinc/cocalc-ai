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
      { account_id: "33333333-3333-4333-8333-333333333333" },
    );
    expect(callHub).not.toHaveBeenCalled();

    await mod.reportPendingProjectTouches();

    expect(callHub).toHaveBeenCalledTimes(1);
    expect(callHub).toHaveBeenCalledWith({
      client: { id: "master-client" },
      host_id: "11111111-1111-4111-8111-111111111111",
      name: "hosts.touchProject",
      args: [
        {
          project_id: "22222222-2222-4222-8222-222222222222",
          account_ids: ["33333333-3333-4333-8333-333333333333"],
        },
      ],
      timeout: 5000,
    });

    await mod.reportPendingProjectTouches();
    expect(callHub).toHaveBeenCalledTimes(1);
  });

  it("flushes agent-turn activity as last_edited-only touches; summary requests merge", async () => {
    const mod = await import("./last-edited");
    const project_id = "22222222-2222-4222-8222-222222222222";
    mod.touchProjectActivity(project_id, { summary: true });
    mod.touchProjectActivity(project_id);
    await mod.reportPendingProjectTouches();
    expect(callHub).toHaveBeenCalledTimes(1);
    expect(callHub).toHaveBeenCalledWith({
      client: { id: "master-client" },
      host_id: "11111111-1111-4111-8111-111111111111",
      name: "hosts.touchProjectActivity",
      args: [{ project_id, summary: true }],
      timeout: 5000,
    });
    await mod.reportPendingProjectTouches();
    expect(callHub).toHaveBeenCalledTimes(1);
  });

  it("a real touch for the same project wins over an activity touch", async () => {
    const mod = await import("./last-edited");
    const project_id = "22222222-2222-4222-8222-222222222222";
    mod.touchProjectActivity(project_id, { summary: true });
    await mod.touchProjectLastEdited(project_id, "browser-touch");
    await mod.reportPendingProjectTouches();
    expect(callHub.mock.calls.map((call) => call[0].name)).toEqual([
      "hosts.touchProject",
    ]);
    await mod.reportPendingProjectTouches();
    expect(callHub).toHaveBeenCalledTimes(1);
  });

  it("keeps an activity touch whose flush failed and sends it next time", async () => {
    const mod = await import("./last-edited");
    const project_id = "22222222-2222-4222-8222-222222222222";
    mod.touchProjectActivity(project_id, { summary: true });
    callHub.mockRejectedValueOnce(new Error("hub unavailable"));
    await mod.reportPendingProjectTouches();
    await mod.reportPendingProjectTouches();
    expect(callHub).toHaveBeenCalledTimes(2);
    expect(callHub.mock.calls[1][0]).toMatchObject({
      name: "hosts.touchProjectActivity",
      args: [{ project_id, summary: true }],
    });
  });

  it("notifies maintenance only after the bay confirms a change", async () => {
    const mod = await import("./last-edited");
    const listener = jest.fn();
    const unsubscribe = mod.onProjectChangeReported(listener);
    mod.markProjectLastChanged("22222222-2222-4222-8222-222222222222", 4);
    callHub.mockRejectedValueOnce(new Error("hub unavailable"));

    await mod.reportPendingProjectTouches();
    expect(listener).not.toHaveBeenCalled();

    await mod.reportPendingProjectTouches();
    expect(listener).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
    );
    unsubscribe();
  });
});
