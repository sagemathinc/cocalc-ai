const callHubMock = jest.fn();
const getMasterConatClientMock = jest.fn(() => ({ id: "master-client" }));

jest.mock("@cocalc/conat/hub/call-hub", () => ({
  __esModule: true,
  default: (...args: any[]) => callHubMock(...args),
}));

jest.mock("../master-status", () => ({
  getMasterConatClient: () => getMasterConatClientMock(),
}));

describe("wireNotificationsApi", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.PROJECT_HOST_ID = "00000000-1000-4000-8000-000000000123";
  });

  it("forwards codex turn notices through the master host scope", async () => {
    callHubMock.mockResolvedValue({
      kind: "account_notice",
      target_count: 1,
      notification_ids: ["notice-1"],
      targets: [],
    });
    const { hubApi } = await import("@cocalc/lite/hub/api");
    (hubApi as any).notifications = {};
    const { wireNotificationsApi } = await import("./notifications");
    wireNotificationsApi();

    await expect(
      hubApi.notifications.createCodexTurnNotice({
        account_id: "00000000-1000-4000-8000-000000000001",
        source_project_id: "00000000-1000-4000-8000-000000000002",
        source_path: "work/chat.chat",
        thread_id: "thread-1",
        title: "Codex turn finished",
        body_markdown: "done",
      }),
    ).resolves.toMatchObject({
      kind: "account_notice",
    });

    expect(callHubMock).toHaveBeenCalledWith({
      client: { id: "master-client" },
      name: "notifications.createCodexTurnNotice",
      args: [
        {
          account_id: "00000000-1000-4000-8000-000000000001",
          source_project_id: "00000000-1000-4000-8000-000000000002",
          source_path: "work/chat.chat",
          thread_id: "thread-1",
          title: "Codex turn finished",
          body_markdown: "done",
        },
      ],
      host_id: "00000000-1000-4000-8000-000000000123",
    });
  });

  it("forwards fresh-auth status checks through the master host scope", async () => {
    callHubMock.mockResolvedValue({
      challenge_id: "00000000-3000-4000-8000-000000000003",
      state: "pending",
      expires_at: "2099-09-02T01:00:00.000Z",
    });
    const { hubApi } = await import("@cocalc/lite/hub/api");
    (hubApi as any).notifications = {};
    const { wireNotificationsApi } = await import("./notifications");
    wireNotificationsApi();

    const opts = {
      account_id: "00000000-1000-4000-8000-000000000001",
      source_project_id: "00000000-2000-4000-8000-000000000002",
      challenge_id: "00000000-3000-4000-8000-000000000003",
    };
    await expect(
      hubApi.notifications.getCodexFreshAuthActionStatus(opts),
    ).resolves.toMatchObject({ state: "pending" });

    expect(callHubMock).toHaveBeenCalledWith({
      client: { id: "master-client" },
      name: "notifications.getCodexFreshAuthActionStatus",
      args: [opts],
      host_id: "00000000-1000-4000-8000-000000000123",
    });
  });
});
