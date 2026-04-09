export {};

let connectMock: jest.Mock;
let loadProjectOutboxPayloadMock: jest.Mock;
let computeAccountProjectFeedEventsMock: jest.Mock;
let loadLatestCollaboratorProjectionEventMock: jest.Mock;
let applyProjectEventToAccountCollaboratorIndexMock: jest.Mock;
let publishAccountFeedEventBestEffortMock: jest.Mock;
let getClusterAccountsByIdsMock: jest.Mock;
let createInterBayAccountProjectFeedClientMock: jest.Mock;
let getInterBayFabricClientMock: jest.Mock;
let isMultiBayClusterMock: jest.Mock;
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

jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountsByIds: (...args: any[]) =>
    getClusterAccountsByIdsMock(...args),
}));

jest.mock("@cocalc/conat/inter-bay/api", () => ({
  createInterBayAccountProjectFeedClient: (...args: any[]) =>
    createInterBayAccountProjectFeedClientMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: (...args: any[]) =>
    getInterBayFabricClientMock(...args),
}));

jest.mock("@cocalc/server/cluster-config", () => ({
  isMultiBayCluster: (...args: any[]) => isMultiBayClusterMock(...args),
}));

describe("publishProjectAccountFeedEventsBestEffort", () => {
  beforeEach(() => {
    connectMock = jest.fn();
    loadProjectOutboxPayloadMock = jest.fn();
    computeAccountProjectFeedEventsMock = jest.fn();
    loadLatestCollaboratorProjectionEventMock = jest.fn();
    applyProjectEventToAccountCollaboratorIndexMock = jest.fn();
    publishAccountFeedEventBestEffortMock = jest.fn();
    getClusterAccountsByIdsMock = jest.fn(async () => []);
    createInterBayAccountProjectFeedClientMock = jest.fn();
    getInterBayFabricClientMock = jest.fn(() => ({ tag: "fabric" }));
    isMultiBayClusterMock = jest.fn(() => false);
    dbMock = {};
  });

  it("loads the latest project payload, computes feed events, and publishes them", async () => {
    const client = {
      query: jest
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              event_id: "event-1",
              project_id: "p1",
              owning_bay_id: "bay-0",
              event_type: "project.membership_changed",
              payload_json: {
                project_id: "p1",
                owning_bay_id: "bay-0",
                users_summary: {},
              },
              created_at: new Date("2026-04-08T22:00:00.000Z"),
              published_at: null,
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [{ event_id: "event-1" }],
        }),
      release: jest.fn(),
    };
    connectMock.mockResolvedValue(client);
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

    expect(loadProjectOutboxPayloadMock).not.toHaveBeenCalled();
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

  it("forwards remote-home project upserts to the account's bay", async () => {
    const REMOTE_ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
    const remoteUpsert = jest.fn(async () => undefined);
    const remoteRemove = jest.fn(async () => undefined);
    const client = {
      query: jest
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              event_id: "event-2",
              project_id: "p1",
              owning_bay_id: "bay-0",
              event_type: "project.membership_changed",
              payload_json: {
                project_id: "p1",
                owning_bay_id: "bay-0",
                host_id: null,
                title: "Remote Project",
                description: "shared",
                name: null,
                theme: null,
                users_summary: {
                  [REMOTE_ACCOUNT_ID]: { group: "collaborator" },
                },
                state_summary: {},
                last_activity_by_account: {},
                created_at: null,
                last_edited_at: null,
                deleted: false,
              },
              created_at: new Date("2026-04-08T22:05:00.000Z"),
              published_at: null,
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [{ event_id: "event-2" }],
        }),
      release: jest.fn(),
    };
    connectMock.mockResolvedValue(client);
    computeAccountProjectFeedEventsMock.mockResolvedValue([]);
    loadLatestCollaboratorProjectionEventMock.mockResolvedValue(null);
    isMultiBayClusterMock.mockReturnValue(true);
    getClusterAccountsByIdsMock.mockResolvedValue([
      {
        account_id: REMOTE_ACCOUNT_ID,
        home_bay_id: "bay-1",
      },
    ]);
    createInterBayAccountProjectFeedClientMock.mockReturnValue({
      upsert: remoteUpsert,
      remove: remoteRemove,
    });

    const { publishProjectAccountFeedEventsBestEffort } =
      await import("./project-feed");

    await publishProjectAccountFeedEventsBestEffort({
      project_id: "p1",
      default_bay_id: "bay-0",
    });

    expect(createInterBayAccountProjectFeedClientMock).toHaveBeenCalledWith({
      client: { tag: "fabric" },
      dest_bay: "bay-1",
    });
    expect(remoteUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "project.upsert",
        account_id: REMOTE_ACCOUNT_ID,
        project: expect.objectContaining({
          project_id: "p1",
          title: "Remote Project",
          owning_bay_id: "bay-0",
        }),
      }),
    );
    expect(remoteRemove).not.toHaveBeenCalled();
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
