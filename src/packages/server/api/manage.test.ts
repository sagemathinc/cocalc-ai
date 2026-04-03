export {};

let queryMock: jest.Mock;
let isValidAccountMock: jest.Mock;
let assertLocalProjectCollaboratorMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: queryMock })),
}));

jest.mock("@cocalc/server/accounts/is-valid-account", () => ({
  __esModule: true,
  default: (...args: any[]) => isValidAccountMock(...args),
}));

jest.mock("@cocalc/server/conat/project-local-access", () => ({
  __esModule: true,
  assertLocalProjectCollaborator: (...args: any[]) =>
    assertLocalProjectCollaboratorMock(...args),
}));

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  getLogger: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

describe("manageApiKeys local bay access", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
  const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    jest.resetModules();
    queryMock = jest.fn(async () => ({ rows: [] }));
    isValidAccountMock = jest.fn(async () => true);
    assertLocalProjectCollaboratorMock = jest.fn(async () => undefined);
  });

  it("rejects project-scoped api key management for wrong-bay projects", async () => {
    assertLocalProjectCollaboratorMock = jest.fn(async () => {
      throw new Error("project belongs to another bay");
    });
    const { default: manageApiKeys } = await import("./manage");
    await expect(
      manageApiKeys({
        account_id: ACCOUNT_ID,
        action: "get",
        project_id: PROJECT_ID,
      }),
    ).rejects.toThrow("project belongs to another bay");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("allows account-wide api key management without project bay checks", async () => {
    const { default: manageApiKeys } = await import("./manage");
    await expect(
      manageApiKeys({
        account_id: ACCOUNT_ID,
        action: "get",
      }),
    ).resolves.toEqual([]);
    expect(assertLocalProjectCollaboratorMock).not.toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("allows project-scoped api key management for local collaborators", async () => {
    const { default: manageApiKeys } = await import("./manage");
    await expect(
      manageApiKeys({
        account_id: ACCOUNT_ID,
        action: "get",
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual([]);
    expect(assertLocalProjectCollaboratorMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
    });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});
