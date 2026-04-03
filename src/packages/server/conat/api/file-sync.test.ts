export {};

let assertCollabMock: jest.Mock;
let hasLocalProjectCollaboratorAccessMock: jest.Mock;
let fileServerClientMock: jest.Mock;
let conatMock: jest.Mock;
let createSyncMock: jest.Mock;
let getSyncMock: jest.Mock;
let syncCommandMock: jest.Mock;
let getAllSyncsMock: jest.Mock;

jest.mock("./util", () => ({
  __esModule: true,
  assertCollab: (...args: any[]) => assertCollabMock(...args),
}));

jest.mock("@cocalc/server/conat/project-local-access", () => ({
  __esModule: true,
  hasLocalProjectCollaboratorAccess: (...args: any[]) =>
    hasLocalProjectCollaboratorAccessMock(...args),
}));

jest.mock("@cocalc/backend/conat", () => ({
  __esModule: true,
  conat: (...args: any[]) => conatMock(...args),
}));

jest.mock("@cocalc/conat/files/file-server", () => ({
  __esModule: true,
  client: (...args: any[]) => fileServerClientMock(...args),
}));

describe("file sync local bay access", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
  const PROJECT_ID0 = "22222222-2222-4222-8222-222222222222";
  const PROJECT_ID1 = "33333333-3333-4333-8333-333333333333";
  const SRC = `project-${PROJECT_ID0}:src/path`;
  const DEST = `project-${PROJECT_ID1}:dest/path`;

  beforeEach(() => {
    jest.resetModules();
    assertCollabMock = jest.fn(async () => undefined);
    hasLocalProjectCollaboratorAccessMock = jest.fn(async () => false);
    conatMock = jest.fn(() => ({ kind: "conat-client" }));
    createSyncMock = jest.fn(async () => undefined);
    getSyncMock = jest.fn(async () => ({ id: "sync-1" }));
    syncCommandMock = jest.fn(async () => ({
      stdout: "ok",
      stderr: "",
      exit_code: 0,
    }));
    getAllSyncsMock = jest.fn(async () => []);
    fileServerClientMock = jest.fn(() => ({
      createSync: createSyncMock,
      getSync: getSyncMock,
      syncCommand: syncCommandMock,
      getAllSyncs: getAllSyncsMock,
    }));
  });

  it("requires local collaborator access on both projects for create", async () => {
    const fileSync = await import("./file-sync");
    await expect(
      fileSync.create({ account_id: ACCOUNT_ID, src: SRC, dest: DEST }),
    ).resolves.toBeUndefined();
    expect(assertCollabMock).toHaveBeenNthCalledWith(1, {
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID0,
    });
    expect(assertCollabMock).toHaveBeenNthCalledWith(2, {
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID1,
    });
    expect(createSyncMock).toHaveBeenCalledTimes(1);
  });

  it("allows onlyOne operations when one side is local", async () => {
    hasLocalProjectCollaboratorAccessMock = jest
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const fileSync = await import("./file-sync");
    await expect(
      fileSync.command({
        account_id: ACCOUNT_ID,
        src: SRC,
        dest: DEST,
        command: "terminate",
        onlyOne: true,
      } as any),
    ).resolves.toEqual({ stdout: "ok", stderr: "", exit_code: 0 });
    expect(hasLocalProjectCollaboratorAccessMock).toHaveBeenNthCalledWith(1, {
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID0,
    });
    expect(hasLocalProjectCollaboratorAccessMock).toHaveBeenNthCalledWith(2, {
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID1,
    });
  });

  it("rejects onlyOne operations when neither side is local", async () => {
    const fileSync = await import("./file-sync");
    await expect(
      fileSync.command({
        account_id: ACCOUNT_ID,
        src: SRC,
        dest: DEST,
        command: "terminate",
        onlyOne: true,
      } as any),
    ).rejects.toThrow("must be a collaborator on src or dest");
    expect(syncCommandMock).not.toHaveBeenCalled();
  });
});
