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
    retryAccountCollaboratorIndexDeadlock: async (fn: () => Promise<any>) =>
      await fn(),
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

  it.each([
    "project.summary_changed",
    "project.state_changed",
    "project.host_changed",
  ])("does not search collaborator history for %s", async (event_type) => {
    const client = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn(),
    };
    client.query.mockResolvedValueOnce({
      rows: [
        {
          event_id: "e1",
          event_type,
          project_id: "p1",
          payload_json: { project_id: "p1", users_summary: {} },
          created_at: new Date(),
        },
      ],
    });
    connectMock.mockResolvedValue(client);
    computeAccountProjectFeedEventsMock.mockResolvedValue([]);
    const { publishProjectAccountFeedEventsBestEffort } =
      await import("./project-feed");
    await publishProjectAccountFeedEventsBestEffort({ project_id: "p1" });
    expect(loadLatestCollaboratorProjectionEventMock).not.toHaveBeenCalled();
    expect(
      applyProjectEventToAccountCollaboratorIndexMock,
    ).not.toHaveBeenCalled();
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
      event_ts: new Date("2026-04-08T22:00:00.000Z"),
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

    const {
      publishProjectAccountFeedEventsBestEffort,
      flushRemoteProjectFeedForwards,
    } = await import("./project-feed");

    await publishProjectAccountFeedEventsBestEffort({
      project_id: "p1",
      default_bay_id: "bay-0",
    });
    await flushRemoteProjectFeedForwards();

    expect(createInterBayAccountProjectFeedClientMock).toHaveBeenCalledWith({
      client: { tag: "fabric" },
      dest_bay: "bay-1",
    });
    expect(remoteUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "project.upsert",
        ts: Date.parse("2026-04-08T22:05:00.000Z"),
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

  it("publishes hard-delete project removes to local and remote home bays", async () => {
    const LOCAL_ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
    const REMOTE_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
    const remoteUpsert = jest.fn(async () => undefined);
    const remoteRemove = jest.fn(async () => undefined);
    isMultiBayClusterMock.mockReturnValue(true);
    getClusterAccountsByIdsMock.mockResolvedValue([
      {
        account_id: LOCAL_ACCOUNT_ID,
        home_bay_id: "bay-0",
      },
      {
        account_id: REMOTE_ACCOUNT_ID,
        home_bay_id: "bay-1",
      },
    ]);
    createInterBayAccountProjectFeedClientMock.mockReturnValue({
      upsert: remoteUpsert,
      remove: remoteRemove,
    });

    const {
      publishProjectRemoveFeedEventsBestEffort,
      flushRemoteProjectFeedForwards,
    } = await import("./project-feed");

    await publishProjectRemoveFeedEventsBestEffort({
      project_id: "33333333-3333-4333-8333-333333333333",
      account_ids: [LOCAL_ACCOUNT_ID, REMOTE_ACCOUNT_ID],
      default_bay_id: "bay-0",
      event_ts: new Date("2026-06-29T00:00:00.000Z"),
    });
    await flushRemoteProjectFeedForwards();

    expect(publishAccountFeedEventBestEffortMock).toHaveBeenCalledWith({
      account_id: LOCAL_ACCOUNT_ID,
      event: {
        type: "project.remove",
        ts: Date.parse("2026-06-29T00:00:00.000Z"),
        account_id: LOCAL_ACCOUNT_ID,
        project_id: "33333333-3333-4333-8333-333333333333",
        reason: "membership_removed",
      },
    });
    expect(createInterBayAccountProjectFeedClientMock).toHaveBeenCalledWith({
      client: { tag: "fabric" },
      dest_bay: "bay-1",
    });
    expect(remoteRemove).toHaveBeenCalledWith({
      type: "project.remove",
      ts: Date.parse("2026-06-29T00:00:00.000Z"),
      account_id: REMOTE_ACCOUNT_ID,
      project_id: "33333333-3333-4333-8333-333333333333",
      reason: "membership_removed",
    });
    expect(remoteUpsert).not.toHaveBeenCalled();
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

  describe("forwarding to other bays", () => {
    const REMOTE_A = "11111111-1111-4111-8111-111111111111";
    const REMOTE_B = "22222222-2222-4222-8222-222222222222";

    // One outbox event per publish call: [latest event, previous event].
    function outboxClient(
      events: { title: string; users: string[]; created_at: string }[],
    ) {
      const query = jest.fn();
      for (let i = 0; i < events.length; i++) {
        const row = (e: (typeof events)[number], id: string) => ({
          event_id: id,
          project_id: "p1",
          owning_bay_id: "bay-0",
          event_type: "project.summary_changed",
          payload_json: {
            project_id: "p1",
            owning_bay_id: "bay-0",
            title: e.title,
            users_summary: Object.fromEntries(
              e.users.map((id) => [id, { group: "collaborator" }]),
            ),
          },
          created_at: new Date(e.created_at),
        });
        query.mockResolvedValueOnce({ rows: [row(events[i], `e${i}`)] });
        query.mockResolvedValueOnce({
          rows: i > 0 ? [row(events[i - 1], `e${i - 1}`)] : [],
        });
      }
      return { query, release: jest.fn() };
    }

    function deferred() {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      return { promise, resolve };
    }

    beforeEach(() => {
      isMultiBayClusterMock.mockReturnValue(true);
      computeAccountProjectFeedEventsMock.mockResolvedValue([]);
      getClusterAccountsByIdsMock.mockImplementation(async (ids: string[]) =>
        ids.map((account_id) => ({ account_id, home_bay_id: "bay-1" })),
      );
    });

    it("returns without waiting for a stalled peer, then delivers in order", async () => {
      const stalled = deferred();
      const sent: string[] = [];
      createInterBayAccountProjectFeedClientMock.mockReturnValue({
        upsert: jest.fn(async (event: any) => {
          sent.push(`upsert:${event.project.title}`);
          if (sent.length === 1) await stalled.promise;
        }),
        remove: jest.fn(async () => undefined),
      });
      connectMock.mockResolvedValue(
        outboxClient([
          {
            title: "one",
            users: [REMOTE_A],
            created_at: "2026-10-05T00:00:01Z",
          },
          {
            title: "two",
            users: [REMOTE_A],
            created_at: "2026-10-05T00:00:02Z",
          },
        ]),
      );
      const {
        publishProjectAccountFeedEventsBestEffort,
        flushRemoteProjectFeedForwards,
      } = await import("./project-feed");

      // Both calls return although the first delivery never completes.
      await publishProjectAccountFeedEventsBestEffort({ project_id: "p1" });
      await publishProjectAccountFeedEventsBestEffort({ project_id: "p1" });
      await new Promise((r) => setTimeout(r, 10));
      expect(sent).toEqual(["upsert:one"]);

      stalled.resolve();
      await flushRemoteProjectFeedForwards();
      expect(sent).toEqual(["upsert:one", "upsert:two"]);
    });

    it("coalesces queued snapshots but still removes accounts that lost access", async () => {
      const stalled = deferred();
      const sent: string[] = [];
      createInterBayAccountProjectFeedClientMock.mockReturnValue({
        upsert: jest.fn(async (event: any) => {
          sent.push(`upsert:${event.project.title}:${event.account_id}`);
          if (sent.length === 1) await stalled.promise;
        }),
        remove: jest.fn(async (event: any) => {
          sent.push(`remove:${event.account_id}`);
        }),
      });
      connectMock.mockResolvedValue(
        outboxClient([
          {
            title: "one",
            users: [REMOTE_A],
            created_at: "2026-10-05T00:00:01Z",
          },
          // B is added, then A is removed, while "one" is still in flight.
          {
            title: "two",
            users: [REMOTE_A, REMOTE_B],
            created_at: "2026-10-05T00:00:02Z",
          },
          {
            title: "three",
            users: [REMOTE_B],
            created_at: "2026-10-05T00:00:03Z",
          },
        ]),
      );
      const {
        publishProjectAccountFeedEventsBestEffort,
        flushRemoteProjectFeedForwards,
      } = await import("./project-feed");

      await publishProjectAccountFeedEventsBestEffort({ project_id: "p1" });
      await publishProjectAccountFeedEventsBestEffort({ project_id: "p1" });
      await publishProjectAccountFeedEventsBestEffort({ project_id: "p1" });
      stalled.resolve();
      await flushRemoteProjectFeedForwards();

      // "two" was superseded before it was sent; A, visible in "two", is
      // still told it lost access.
      expect(sent).toEqual([
        `upsert:one:${REMOTE_A}`,
        `upsert:three:${REMOTE_B}`,
        `remove:${REMOTE_A}`,
      ]);
    });
  });
});
