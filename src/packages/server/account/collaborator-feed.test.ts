export {};

let connectMock: jest.Mock;
let refreshProjectedCollaboratorIdentityRowsMock: jest.Mock;
let publishAccountFeedEventBestEffortMock: jest.Mock;
let dbMock: { publishCollaboratorAccountFeedEventsBestEffort?: any };

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({
    connect: connectMock,
  }),
}));

jest.mock("@cocalc/database", () => ({
  db: () => dbMock,
}));

jest.mock("@cocalc/database/postgres/account-collaborator-index", () => ({
  refreshProjectedCollaboratorIdentityRows: (...args: any[]) =>
    refreshProjectedCollaboratorIdentityRowsMock(...args),
}));

jest.mock("./feed", () => ({
  publishAccountFeedEventBestEffort: (...args: any[]) =>
    publishAccountFeedEventBestEffortMock(...args),
}));

describe("publishCollaboratorAccountFeedEventsBestEffort", () => {
  beforeEach(() => {
    connectMock = jest.fn();
    refreshProjectedCollaboratorIdentityRowsMock = jest.fn();
    publishAccountFeedEventBestEffortMock = jest.fn();
    dbMock = {};
  });

  it("refreshes projected collaborator rows and publishes collaborator upserts", async () => {
    const client = {
      release: jest.fn(),
    };
    connectMock.mockResolvedValue(client);
    refreshProjectedCollaboratorIdentityRowsMock.mockResolvedValue({
      updated_rows: [
        {
          account_id: "acct-home",
          collaborator_account_id: "acct-collab",
          first_name: "Collab",
          last_name: "User",
          name: "Collab User",
          last_active: new Date("2026-04-05T00:00:00.000Z"),
          profile: { image: "collab.png" },
          common_project_count: 2,
          updated_at: new Date("2026-04-05T00:01:00.000Z"),
        },
      ],
    });

    const { publishCollaboratorAccountFeedEventsBestEffort } =
      await import("./collaborator-feed");

    await publishCollaboratorAccountFeedEventsBestEffort({
      collaborator_account_id: "acct-collab",
    });

    expect(refreshProjectedCollaboratorIdentityRowsMock).toHaveBeenCalledWith({
      db: client,
      collaborator_account_id: "acct-collab",
    });
    expect(publishAccountFeedEventBestEffortMock).toHaveBeenCalledWith({
      account_id: "acct-home",
      event: {
        type: "collaborator.upsert",
        ts: expect.any(Number),
        account_id: "acct-home",
        collaborator: {
          account_id: "acct-collab",
          first_name: "Collab",
          last_name: "User",
          name: "Collab User",
          last_active: "2026-04-05T00:00:00.000Z",
          profile: { image: "collab.png" },
          common_project_count: 2,
          updated_at: "2026-04-05T00:01:00.000Z",
        },
      },
    });
    expect(client.release).toHaveBeenCalled();
  });

  it("installs the collaborator publisher on the db singleton", async () => {
    const {
      enableDbCollaboratorAccountFeedPublishing,
      publishCollaboratorAccountFeedEventsBestEffort,
    } = await import("./collaborator-feed");

    enableDbCollaboratorAccountFeedPublishing();

    expect(dbMock.publishCollaboratorAccountFeedEventsBestEffort).toBe(
      publishCollaboratorAccountFeedEventsBestEffort,
    );
  });
});
