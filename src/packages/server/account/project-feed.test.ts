export {};

let connectMock: jest.Mock;
let loadProjectOutboxPayloadMock: jest.Mock;
let computeAccountProjectFeedEventsMock: jest.Mock;
let loadLatestCollaboratorProjectionEventMock: jest.Mock;
let applyProjectEventToAccountCollaboratorIndexMock: jest.Mock;
let publishAccountFeedEventBestEffortMock: jest.Mock;
let dbMock: {
  publishProjectAccountFeedEventsBestEffort?: any;
  publishCollaboratorAccountFeedEventsBestEffort?: any;
};

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({
    connect: connectMock,
  }),
}));

jest.mock("@cocalc/database", () => ({
  db: () => dbMock,
}));

jest.mock("@cocalc/database/postgres/project-events-outbox", () => ({
  loadProjectOutboxPayload: (...args: any[]) =>
    loadProjectOutboxPayloadMock(...args),
}));

jest.mock("@cocalc/database/postgres/account-project-index-projector", () => ({
  computeAccountProjectFeedEvents: (...args: any[]) =>
    computeAccountProjectFeedEventsMock(...args),
}));

jest.mock(
  "@cocalc/database/postgres/account-collaborator-index-projector",
  () => ({
    loadLatestCollaboratorProjectionEvent: (...args: any[]) =>
      loadLatestCollaboratorProjectionEventMock(...args),
    applyProjectEventToAccountCollaboratorIndex: (...args: any[]) =>
      applyProjectEventToAccountCollaboratorIndexMock(...args),
  }),
);

jest.mock("./feed", () => ({
  publishAccountFeedEventBestEffort: (...args: any[]) =>
    publishAccountFeedEventBestEffortMock(...args),
}));

describe("publishProjectAccountFeedEventsBestEffort", () => {
  beforeEach(() => {
    connectMock = jest.fn();
    loadProjectOutboxPayloadMock = jest.fn();
    computeAccountProjectFeedEventsMock = jest.fn();
    loadLatestCollaboratorProjectionEventMock = jest.fn();
    applyProjectEventToAccountCollaboratorIndexMock = jest.fn();
    publishAccountFeedEventBestEffortMock = jest.fn();
    dbMock = {};
  });

  it("loads the latest project payload, computes feed events, and publishes them", async () => {
    const client = {
      query: jest.fn().mockResolvedValue({
        rows: [{ event_id: "event-1" }],
      }),
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
    loadLatestCollaboratorProjectionEventMock.mockResolvedValue({
      event_id: "event-1",
    });
    applyProjectEventToAccountCollaboratorIndexMock.mockResolvedValue({
      feed_events: [
        {
          type: "collaborator.upsert",
          ts: 3,
          account_id: "acct-1",
          collaborator: { account_id: "acct-3" },
        },
      ],
    });

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
    expect(publishAccountFeedEventBestEffortMock).toHaveBeenNthCalledWith(3, {
      account_id: "acct-1",
      event: {
        type: "collaborator.upsert",
        ts: 3,
        account_id: "acct-1",
        collaborator: { account_id: "acct-3" },
      },
    });
    expect(client.release).toHaveBeenCalled();
  });

  it("installs the immediate project feed publisher on the db singleton", async () => {
    const {
      enableDbProjectAccountFeedPublishing,
      publishProjectAccountFeedEventsBestEffort,
    } = await import("./project-feed");

    enableDbProjectAccountFeedPublishing();

    expect(dbMock.publishProjectAccountFeedEventsBestEffort).toBe(
      publishProjectAccountFeedEventsBestEffort,
    );
  });

  it("does not replay collaborator events when the latest outbox event is unrelated", async () => {
    const client = {
      query: jest.fn().mockResolvedValue({
        rows: [{ event_id: "event-2" }],
      }),
      release: jest.fn(),
    };
    connectMock.mockResolvedValue(client);
    loadProjectOutboxPayloadMock.mockResolvedValue({
      project_id: "p1",
      owning_bay_id: "bay-0",
      users_summary: {},
    });
    computeAccountProjectFeedEventsMock.mockResolvedValue([]);
    loadLatestCollaboratorProjectionEventMock.mockResolvedValue({
      event_id: "event-1",
    });

    const { publishProjectAccountFeedEventsBestEffort } =
      await import("./project-feed");

    await publishProjectAccountFeedEventsBestEffort({
      project_id: "p1",
      default_bay_id: "bay-0",
    });

    expect(
      applyProjectEventToAccountCollaboratorIndexMock,
    ).not.toHaveBeenCalled();
  });
});
