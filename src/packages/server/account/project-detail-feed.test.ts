export {};

let getPoolMock: jest.Mock;
let queryMock: jest.Mock;
let listRecentBrowserSessionAccountIdsMock: jest.Mock;
let publishAccountFeedEventBestEffortMock: jest.Mock;

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: (...args: any[]) => getPoolMock(...args),
}));

jest.mock("@cocalc/server/conat/api/browser-sessions", () => ({
  __esModule: true,
  listRecentBrowserSessionAccountIds: (...args: any[]) =>
    listRecentBrowserSessionAccountIdsMock(...args),
}));

jest.mock("./feed", () => ({
  __esModule: true,
  publishAccountFeedEventBestEffort: (...args: any[]) =>
    publishAccountFeedEventBestEffortMock(...args),
}));

describe("publishProjectDetailInvalidationBestEffort", () => {
  beforeEach(() => {
    jest.resetModules();
    queryMock = jest.fn(async () => ({
      rows: [
        {
          users: {
            "acct-1": { group: "owner" },
            "acct-2": { group: "collaborator" },
            "acct-3": { group: "collaborator" },
          },
        },
      ],
    }));
    getPoolMock = jest.fn(() => ({ query: queryMock }));
    listRecentBrowserSessionAccountIdsMock = jest.fn(() => [
      "acct-2",
      "acct-4",
      "acct-2",
    ]);
    publishAccountFeedEventBestEffortMock = jest.fn(async () => undefined);
  });

  it("publishes only to active collaborators", async () => {
    const { publishProjectDetailInvalidationBestEffort } =
      await import("./project-detail-feed");

    await publishProjectDetailInvalidationBestEffort({
      project_id: "proj-1",
      fields: ["run_quota", "run_quota", " snapshots "],
    });

    expect(queryMock).toHaveBeenCalledWith(
      "SELECT users FROM projects WHERE project_id = $1 AND deleted IS NOT true",
      ["proj-1"],
    );
    expect(publishAccountFeedEventBestEffortMock).toHaveBeenCalledTimes(1);
    expect(publishAccountFeedEventBestEffortMock).toHaveBeenCalledWith({
      account_id: "acct-2",
      event: expect.objectContaining({
        type: "project.detail.invalidate",
        account_id: "acct-2",
        project_id: "proj-1",
        fields: ["run_quota", "snapshots"],
      }),
    });
  });

  it("does nothing when there are no active collaborators", async () => {
    listRecentBrowserSessionAccountIdsMock = jest.fn(() => []);
    const { publishProjectDetailInvalidationBestEffort } =
      await import("./project-detail-feed");

    await publishProjectDetailInvalidationBestEffort({
      project_id: "proj-1",
      fields: ["launcher"],
    });

    expect(queryMock).not.toHaveBeenCalled();
    expect(publishAccountFeedEventBestEffortMock).not.toHaveBeenCalled();
  });
});
