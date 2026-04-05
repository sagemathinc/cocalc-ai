let connectMock: jest.Mock;
let loadProjectOutboxPayloadMock: jest.Mock;
let computeAccountProjectFeedEventsMock: jest.Mock;
let publishAccountFeedEventBestEffortMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({
    connect: connectMock,
  }),
}));

jest.mock("@cocalc/database/postgres/project-events-outbox", () => ({
  loadProjectOutboxPayload: (...args: any[]) =>
    loadProjectOutboxPayloadMock(...args),
}));

jest.mock("@cocalc/database/postgres/account-project-index-projector", () => ({
  computeAccountProjectFeedEvents: (...args: any[]) =>
    computeAccountProjectFeedEventsMock(...args),
}));

jest.mock("./feed", () => ({
  publishAccountFeedEventBestEffort: (...args: any[]) =>
    publishAccountFeedEventBestEffortMock(...args),
}));

describe("publishProjectAccountFeedEventsBestEffort", () => {
  beforeEach(() => {
    connectMock = jest.fn();
    loadProjectOutboxPayloadMock = jest.fn();
    computeAccountProjectFeedEventsMock = jest.fn();
    publishAccountFeedEventBestEffortMock = jest.fn();
  });

  it("loads the latest project payload, computes feed events, and publishes them", async () => {
    const client = {
      release: jest.fn(),
    };
    connectMock.mockResolvedValue(client);
    loadProjectOutboxPayloadMock.mockResolvedValue({
      project_id: "p1",
      owning_bay_id: "bay-0",
      users_summary: {},
    });
    computeAccountProjectFeedEventsMock.mockResolvedValue([
      {
        type: "project.upsert",
        ts: 1,
        account_id: "acct-1",
        project: { project_id: "p1" },
      },
      {
        type: "project.remove",
        ts: 2,
        account_id: "acct-2",
        project_id: "p1",
        reason: "membership_removed",
      },
    ]);

    const { publishProjectAccountFeedEventsBestEffort } =
      await import("./project-feed");

    await publishProjectAccountFeedEventsBestEffort({
      project_id: "p1",
      default_bay_id: "bay-0",
    });

    expect(loadProjectOutboxPayloadMock).toHaveBeenCalledWith({
      db: client,
      project_id: "p1",
      default_bay_id: "bay-0",
    });
    expect(computeAccountProjectFeedEventsMock).toHaveBeenCalledWith({
      db: client,
      bay_id: "bay-0",
      payload: {
        project_id: "p1",
        owning_bay_id: "bay-0",
        users_summary: {},
      },
    });
    expect(publishAccountFeedEventBestEffortMock).toHaveBeenNthCalledWith(1, {
      account_id: "acct-1",
      event: {
        type: "project.upsert",
        ts: 1,
        account_id: "acct-1",
        project: { project_id: "p1" },
      },
    });
    expect(publishAccountFeedEventBestEffortMock).toHaveBeenNthCalledWith(2, {
      account_id: "acct-2",
      event: {
        type: "project.remove",
        ts: 2,
        account_id: "acct-2",
        project_id: "p1",
        reason: "membership_removed",
      },
    });
    expect(client.release).toHaveBeenCalled();
  });
});
