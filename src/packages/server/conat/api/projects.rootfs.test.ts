export {};

let assertLocalProjectCollaboratorMock: jest.Mock;
let isAdminMock: jest.Mock;
let getPoolMock: jest.Mock;
let queryMock: jest.Mock;

jest.mock("@cocalc/server/conat/project-local-access", () => ({
  __esModule: true,
  assertLocalProjectCollaborator: (...args: any[]) =>
    assertLocalProjectCollaboratorMock(...args),
}));

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: any[]) => isAdminMock(...args),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: (...args: any[]) => getPoolMock(...args),
}));

describe("project rootfs helpers", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
  const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    jest.resetModules();
    assertLocalProjectCollaboratorMock = jest.fn(async () => undefined);
    isAdminMock = jest.fn(async () => false);
    queryMock = jest.fn(async () => ({
      rows: [
        {
          rootfs_image: "buildpack-deps:noble-scm",
          rootfs_image_id: "official-cocalc-base",
        },
      ],
    }));
    getPoolMock = jest.fn(() => ({ query: queryMock }));
  });

  it("returns project rootfs for a collaborator", async () => {
    const { getProjectRootfs } = await import("./projects");
    await expect(
      getProjectRootfs({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual({
      image: "buildpack-deps:noble-scm",
      image_id: "official-cocalc-base",
    });
    expect(queryMock).toHaveBeenCalledWith(
      "SELECT rootfs_image, rootfs_image_id FROM projects WHERE project_id = $1",
      [PROJECT_ID],
    );
  });

  it("allows admins to read project rootfs without collaborator access", async () => {
    assertLocalProjectCollaboratorMock = jest.fn(async () => {
      throw new Error("not a collaborator");
    });
    isAdminMock = jest.fn(async () => true);
    const { getProjectRootfs } = await import("./projects");
    await expect(
      getProjectRootfs({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual({
      image: "buildpack-deps:noble-scm",
      image_id: "official-cocalc-base",
    });
    expect(isAdminMock).toHaveBeenCalledWith(ACCOUNT_ID);
  });

  it("returns null when the project has no configured rootfs image", async () => {
    queryMock = jest.fn(async () => ({
      rows: [{ rootfs_image: null, rootfs_image_id: null }],
    }));
    getPoolMock = jest.fn(() => ({ query: queryMock }));
    const { getProjectRootfs } = await import("./projects");
    await expect(
      getProjectRootfs({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toBeNull();
  });
});
