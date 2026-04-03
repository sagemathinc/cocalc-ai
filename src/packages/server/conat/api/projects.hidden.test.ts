export {};

let assertCollabMock: jest.Mock;
let queryMock: jest.Mock;

jest.mock("./util", () => ({
  __esModule: true,
  assertCollab: (...args: any[]) => assertCollabMock(...args),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: queryMock })),
}));

describe("setProjectHidden bay-aware update", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
  const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    jest.resetModules();
    assertCollabMock = jest.fn(async () => undefined);
    queryMock = jest.fn(async () => ({ rowCount: 1 }));
  });

  it("rejects stale hidden-state updates after local access was checked", async () => {
    queryMock = jest.fn(async () => ({ rowCount: 0 }));
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
    expect(`${queryMock.mock.calls[0]?.[0] ?? ""}`).toContain(
      "COALESCE(owning_bay_id, $4) = $4",
    );
  });
});
