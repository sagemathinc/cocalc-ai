export {};

let queryMock: jest.Mock;
let assertLocalProjectCollaboratorMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: queryMock })),
}));

jest.mock("@cocalc/server/conat/project-local-access", () => ({
  __esModule: true,
  assertLocalProjectCollaborator: (...args: any[]) =>
    assertLocalProjectCollaboratorMock(...args),
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
    assertLocalProjectCollaboratorMock = jest.fn(async () => undefined);
  });

  it("rejects public-path saves for projects owned by another bay", async () => {
    assertLocalProjectCollaboratorMock = jest.fn(async () => {
      throw new Error("project belongs to another bay");
    });
    const { default: savePublicPath } = await import("./save");
    await expect(savePublicPath(PUBLIC_PATH_ID, ACCOUNT_ID)).rejects.toThrow(
      "project belongs to another bay",
    );
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("updates last_edited for local projects", async () => {
    const { default: savePublicPath } = await import("./save");
    await expect(
      savePublicPath(PUBLIC_PATH_ID, ACCOUNT_ID),
    ).resolves.toBeUndefined();
    expect(assertLocalProjectCollaboratorMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
    });
    expect(queryMock).toHaveBeenNthCalledWith(
      2,
      "UPDATE public_paths SET last_edited = NOW() WHERE id=$1",
      [PUBLIC_PATH_ID],
    );
  });
});
