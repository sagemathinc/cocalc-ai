export {};

let getPoolMock: jest.Mock;
let queryMock: jest.Mock;
let listRecentBrowserSessionAccountIdsMock: jest.Mock;
let listLiveBrowserSessionAccountIdsMock: jest.Mock;
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

jest.mock("@cocalc/server/conat/api/browser-sessions-live", () => ({
  __esModule: true,
  listLiveBrowserSessionAccountIds: (...args: any[]) =>
    listLiveBrowserSessionAccountIdsMock(...args),
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
    listLiveBrowserSessionAccountIdsMock = jest.fn(async () => undefined);
    publishAccountFeedEventBestEffortMock = jest.fn(async () => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("publishes only to active collaborators", async () => {
    const { publishProjectDetailInvalidation } =
      await import("./project-detail-feed");

    await publishProjectDetailInvalidation({
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
    const { publishProjectDetailInvalidation } =
      await import("./project-detail-feed");

    await publishProjectDetailInvalidation({
      project_id: "proj-1",
      fields: ["env"],
    });

    expect(queryMock).not.toHaveBeenCalled();
    expect(publishAccountFeedEventBestEffortMock).not.toHaveBeenCalled();
  });

  it("returns without waiting for the live session lookup", async () => {
    let resolveLive: (ids: string[]) => void = () => {};
    listLiveBrowserSessionAccountIdsMock = jest.fn(
      () =>
        new Promise<string[]>((resolve) => {
          resolveLive = resolve;
        }),
    );
    const { publishProjectDetailInvalidationBestEffort } =
      await import("./project-detail-feed");

    await publishProjectDetailInvalidationBestEffort({
      project_id: "proj-1",
      fields: ["title"],
    });
    expect(publishAccountFeedEventBestEffortMock).not.toHaveBeenCalled();

    resolveLive(["acct-3"]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(publishAccountFeedEventBestEffortMock).toHaveBeenCalledTimes(1);
    expect(publishAccountFeedEventBestEffortMock).toHaveBeenCalledWith(
      expect.objectContaining({ account_id: "acct-3" }),
    );
  });

  it("shares one live session lookup across a burst of changes", async () => {
    let now = 1_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    listLiveBrowserSessionAccountIdsMock = jest.fn(async () => ["acct-2"]);
    const { publishProjectDetailInvalidation } =
      await import("./project-detail-feed");

    await Promise.all([
      publishProjectDetailInvalidation({ project_id: "proj-1", fields: ["a"] }),
      publishProjectDetailInvalidation({ project_id: "proj-1", fields: ["b"] }),
    ]);
    now += 4_000;
    await publishProjectDetailInvalidation({
      project_id: "proj-1",
      fields: ["c"],
    });
    expect(listLiveBrowserSessionAccountIdsMock).toHaveBeenCalledTimes(1);
    expect(publishAccountFeedEventBestEffortMock).toHaveBeenCalledTimes(3);

    now += 2_000;
    await publishProjectDetailInvalidation({
      project_id: "proj-1",
      fields: ["d"],
    });
    expect(listLiveBrowserSessionAccountIdsMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to this hub's sessions when the live lookup fails", async () => {
    listLiveBrowserSessionAccountIdsMock = jest.fn(async () => {
      throw Error("no responders");
    });
    const { publishProjectDetailInvalidation } =
      await import("./project-detail-feed");

    await publishProjectDetailInvalidation({
      project_id: "proj-1",
      fields: ["env"],
    });
    expect(publishAccountFeedEventBestEffortMock).toHaveBeenCalledTimes(1);
    expect(publishAccountFeedEventBestEffortMock).toHaveBeenCalledWith(
      expect.objectContaining({ account_id: "acct-2" }),
    );
  });
});
