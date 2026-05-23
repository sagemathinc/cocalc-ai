export {};

let assertCollabAllowRemoteProjectAccessMock: jest.Mock;
let appendOutboxMock: jest.Mock;
let publishProjectFeedMock: jest.Mock;
let poolConnectMock: jest.Mock;
let poolQueryMock: jest.Mock;
let queryMock: jest.Mock;
let releaseMock: jest.Mock;

jest.mock("./util", () => ({
  __esModule: true,
  assertCollab: jest.fn(),
  assertCollabAllowRemoteProjectAccess: (...args: any[]) =>
    assertCollabAllowRemoteProjectAccessMock(...args),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ connect: poolConnectMock, query: poolQueryMock })),
}));

jest.mock("@cocalc/database/postgres/project-events-outbox", () => ({
  __esModule: true,
  appendProjectOutboxEventForProject: (...args: any[]) =>
    appendOutboxMock(...args),
}));

jest.mock("@cocalc/server/account/project-feed", () => ({
  __esModule: true,
  publishProjectAccountFeedEventsBestEffort: (...args: any[]) =>
    publishProjectFeedMock(...args),
}));

describe("setProjectHidden bay-aware update", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
  const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
  const PROJECT_ID_2 = "33333333-3333-4333-8333-333333333333";

  beforeEach(() => {
    jest.resetModules();
    assertCollabAllowRemoteProjectAccessMock = jest.fn(async () => undefined);
    appendOutboxMock = jest.fn(async () => "event-id");
    publishProjectFeedMock = jest.fn(async () => undefined);
    poolQueryMock = jest.fn(async (sql: string, params?: any[]) => {
      if (sql.includes("project_id = ANY")) {
        return {
          rows: (params?.[0] ?? []).map((project_id: string) => ({
            project_id,
            bay_id: "bay-0",
          })),
        };
      }
      return { rows: [{ bay_id: "bay-0" }] };
    });
    releaseMock = jest.fn();
    queryMock = jest.fn(async (sql: string, params?: any[]) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rowCount: null };
      }
      if (sql.includes("pg_advisory_xact_lock")) {
        return { rows: [], rowCount: null };
      }
      if (sql.includes("to_regclass")) {
        return { rows: [{ table_name: null }], rowCount: 1 };
      }
      if (sql.includes("UPDATE projects")) {
        return {
          rows: (params?.[0] ?? []).map((project_id: string) => ({
            project_id,
          })),
          rowCount: params?.[0]?.length ?? 0,
        };
      }
      return { rows: [], rowCount: 1 };
    });
    poolConnectMock = jest.fn(async () => ({
      query: queryMock,
      release: releaseMock,
    }));
  });

  it("rejects stale hidden-state updates after the batch update", async () => {
    queryMock = jest.fn(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rowCount: null };
      }
      if (sql.includes("pg_advisory_xact_lock")) {
        return { rows: [], rowCount: null };
      }
      if (sql.includes("to_regclass")) {
        return { rows: [{ table_name: null }], rowCount: 1 };
      }
      if (sql.includes("UPDATE projects")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    });
    poolConnectMock = jest.fn(async () => ({
      query: queryMock,
      release: releaseMock,
    }));
    const { setProjectHidden } = await import("./projects");
    await expect(
      setProjectHidden({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        hide: true,
      }),
    ).rejects.toThrow("user must be a collaborator");
    expect(
      queryMock.mock.calls.some((call) =>
        `${call[0] ?? ""}`.includes("COALESCE(owning_bay_id, $4) = $4"),
      ),
    ).toBe(true);
    expect(appendOutboxMock).not.toHaveBeenCalled();
  });

  it("emits a membership outbox event after updating the hidden flag", async () => {
    const { setProjectHidden } = await import("./projects");
    await expect(
      setProjectHidden({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        hide: true,
      }),
    ).resolves.toBeUndefined();
    expect(appendOutboxMock).toHaveBeenCalledWith({
      db: expect.objectContaining({ query: queryMock }),
      event_type: "project.membership_changed",
      project_id: PROJECT_ID,
      default_bay_id: "bay-0",
    });
    expect(publishProjectFeedMock).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      default_bay_id: "bay-0",
    });
    expect(releaseMock).toHaveBeenCalled();
  });

  it("updates multiple hidden flags in one transaction", async () => {
    const { setProjectsHidden } = await import("./projects");
    await expect(
      setProjectsHidden({
        account_id: ACCOUNT_ID,
        project_ids: [PROJECT_ID, PROJECT_ID_2],
        hide: false,
      }),
    ).resolves.toEqual([
      { project_id: PROJECT_ID, success: true },
      { project_id: PROJECT_ID_2, success: true },
    ]);
    const updateCalls = queryMock.mock.calls.filter((call) =>
      `${call[0] ?? ""}`.includes("UPDATE projects"),
    );
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0][1][0]).toEqual([PROJECT_ID, PROJECT_ID_2]);
    expect(appendOutboxMock).toHaveBeenCalledTimes(2);
    expect(publishProjectFeedMock).toHaveBeenCalledTimes(2);
  });
});
