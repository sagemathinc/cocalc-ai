export {};

let queryMock: jest.Mock;
let assertProjectCollaboratorAccessAllowRemoteMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: queryMock })),
}));

jest.mock("@cocalc/server/conat/project-remote-access", () => ({
  __esModule: true,
  assertProjectCollaboratorAccessAllowRemote: (...args: any[]) =>
    assertProjectCollaboratorAccessAllowRemoteMock(...args),
}));

describe("savePublicPath local bay access", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
  const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
  const PUBLIC_PATH_ID = "public-path-1";

  beforeEach(() => {
    jest.resetModules();
    queryMock = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ project_id: PROJECT_ID }] })
      .mockResolvedValueOnce({ rowCount: 1 });
    assertProjectCollaboratorAccessAllowRemoteMock = jest.fn(
      async () => undefined,
    );
  });

  it("updates last_edited for collaborators on any bay", async () => {
    const { default: savePublicPath } = await import("./save");
    await expect(
      savePublicPath(PUBLIC_PATH_ID, ACCOUNT_ID),
    ).resolves.toBeUndefined();
    expect(assertProjectCollaboratorAccessAllowRemoteMock).toHaveBeenCalledWith(
      {
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      },
    );
    expect(queryMock).toHaveBeenNthCalledWith(
      2,
      "UPDATE public_paths SET last_edited = NOW() WHERE id=$1",
      [PUBLIC_PATH_ID],
    );
  });
});
