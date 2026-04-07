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

describe("project course info helpers", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
  const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    jest.resetModules();
    assertLocalProjectCollaboratorMock = jest.fn(async () => undefined);
    isAdminMock = jest.fn(async () => false);
    queryMock = jest.fn(async () => ({
      rows: [
        {
          course: {
            type: "student",
            project_id: "33333333-3333-4333-8333-333333333333",
            path: ".course/main.course",
          },
        },
      ],
    }));
    getPoolMock = jest.fn(() => ({ query: queryMock }));
  });

  it("returns project course info for a collaborator", async () => {
    const { getProjectCourseInfo } = await import("./projects");
    await expect(
      getProjectCourseInfo({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual({
      type: "student",
      project_id: "33333333-3333-4333-8333-333333333333",
      path: ".course/main.course",
    });
    expect(queryMock).toHaveBeenCalledWith(
      "SELECT course FROM projects WHERE project_id = $1",
      [PROJECT_ID],
    );
  });

  it("allows admins to read project course info without collaborator access", async () => {
    assertLocalProjectCollaboratorMock = jest.fn(async () => {
      throw new Error("not a collaborator");
    });
    isAdminMock = jest.fn(async () => true);
    const { getProjectCourseInfo } = await import("./projects");
    await expect(
      getProjectCourseInfo({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual({
      type: "student",
      project_id: "33333333-3333-4333-8333-333333333333",
      path: ".course/main.course",
    });
    expect(isAdminMock).toHaveBeenCalledWith(ACCOUNT_ID);
  });
});
