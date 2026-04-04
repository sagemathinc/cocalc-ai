export {};

let assertCollabMock: jest.Mock;
let appendOutboxMock: jest.Mock;
let poolConnectMock: jest.Mock;
let queryMock: jest.Mock;
let releaseMock: jest.Mock;

jest.mock("./util", () => ({
  __esModule: true,
  assertCollab: (...args: any[]) => assertCollabMock(...args),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ connect: poolConnectMock })),
}));

jest.mock("@cocalc/database/postgres/project-events-outbox", () => ({
  __esModule: true,
  appendProjectOutboxEventForProject: (...args: any[]) =>
    appendOutboxMock(...args),
}));

describe("setProjectHidden bay-aware update", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
  const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    jest.resetModules();
    assertCollabMock = jest.fn(async () => undefined);
    appendOutboxMock = jest.fn(async () => "event-id");
    releaseMock = jest.fn();
    queryMock = jest.fn(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rowCount: null };
      }
      return { rowCount: 1 };
    });
    poolConnectMock = jest.fn(async () => ({
      query: queryMock,
      release: releaseMock,
    }));
  });

  it("rejects stale hidden-state updates after local access was checked", async () => {
    queryMock = jest.fn(async (sql: string) => {
      if (sql === "BEGIN" || sql === "ROLLBACK") {
        return { rowCount: null };
      }
      return { rowCount: 0 };
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
    expect(assertCollabMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
    });
    expect(`${queryMock.mock.calls[1]?.[0] ?? ""}`).toContain(
      "COALESCE(owning_bay_id, $4) = $4",
    );
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
    expect(releaseMock).toHaveBeenCalled();
  });
});
