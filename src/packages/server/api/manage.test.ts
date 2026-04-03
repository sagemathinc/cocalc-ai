export {};

import base62 from "base62/lib/ascii";

let queryMock: jest.Mock;
let isValidAccountMock: jest.Mock;
let assertLocalProjectCollaboratorMock: jest.Mock;
let getLocalProjectCollaboratorAccessStatusMock: jest.Mock;
let verifyPasswordMock: jest.Mock;
let isBannedMock: jest.Mock;

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
  getLocalProjectCollaboratorAccessStatus: (...args: any[]) =>
    getLocalProjectCollaboratorAccessStatusMock(...args),
}));

jest.mock("@cocalc/backend/auth/password-hash", () => ({
  __esModule: true,
  default: jest.fn(() => "hash"),
  verifyPassword: (...args: any[]) => verifyPasswordMock(...args),
}));

jest.mock("@cocalc/server/accounts/is-banned", () => ({
  __esModule: true,
  default: (...args: any[]) => isBannedMock(...args),
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
    getLocalProjectCollaboratorAccessStatusMock = jest.fn(
      async () => "local-collaborator",
    );
    verifyPasswordMock = jest.fn(() => true);
    isBannedMock = jest.fn(async () => false);
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

  it("rejects project api keys on the wrong bay without deleting them", async () => {
    const secret = `sk-test${base62.encode(1).padStart(6, "0")}`;
    queryMock = jest.fn().mockResolvedValueOnce({
      rows: [
        {
          account_id: ACCOUNT_ID,
          project_id: PROJECT_ID,
          hash: "hash",
          expire: null,
        },
      ],
    });
    getLocalProjectCollaboratorAccessStatusMock = jest.fn(
      async () => "wrong-bay",
    );
    const { getAccountWithApiKey } = await import("./manage");
    await expect(getAccountWithApiKey(secret)).resolves.toBeUndefined();
    expect(getLocalProjectCollaboratorAccessStatusMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
    });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("deletes stale project api keys when creator is no longer a collaborator", async () => {
    const secret = `sk-test${base62.encode(7).padStart(6, "0")}`;
    queryMock = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            account_id: ACCOUNT_ID,
            project_id: PROJECT_ID,
            hash: "hash",
            expire: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 });
    getLocalProjectCollaboratorAccessStatusMock = jest.fn(
      async () => "not-collaborator",
    );
    const { getAccountWithApiKey } = await import("./manage");
    await expect(getAccountWithApiKey(secret)).resolves.toBeUndefined();
    expect(queryMock).toHaveBeenNthCalledWith(
      2,
      "DELETE FROM api_keys WHERE project_id=$1 AND id=$2",
      [PROJECT_ID, 7],
    );
  });
});
