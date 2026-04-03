export {};

let assertLocalProjectCollaboratorMock: jest.Mock;
let callback2Mock: jest.Mock;
let syncProjectUsersOnHostMock: jest.Mock;

jest.mock("@cocalc/server/conat/project-local-access", () => ({
  __esModule: true,
  assertLocalProjectCollaborator: (...args: any[]) =>
    assertLocalProjectCollaboratorMock(...args),
}));

jest.mock("@cocalc/util/async-utils", () => ({
  __esModule: true,
  callback2: (...args: any[]) => callback2Mock(...args),
}));

jest.mock("@cocalc/server/project-host/control", () => ({
  __esModule: true,
  syncProjectUsersOnHost: (...args: any[]) =>
    syncProjectUsersOnHostMock(...args),
}));

describe("project collaborator write access", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
  const TARGET_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
  const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
  const COURSE_PROJECT_ID = "44444444-4444-4444-8444-444444444444";

  beforeEach(() => {
    jest.resetModules();
    assertLocalProjectCollaboratorMock = jest.fn(async () => undefined);
    callback2Mock = jest.fn(async (fn, opts) => await fn(opts));
    syncProjectUsersOnHostMock = jest.fn(async () => undefined);
  });

  it("rejects add-collaborator writes for wrong-bay projects", async () => {
    assertLocalProjectCollaboratorMock = jest.fn(async () => {
      throw new Error("project belongs to another bay");
    });
    const { add_collaborators_to_projects } = await import("./collab");
    const db = {
      user_is_collaborator: jest.fn(async () => false),
      add_user_to_project: jest.fn(async () => undefined),
      async_query: jest.fn(async () => ({ rows: [] })),
    } as any;
    await expect(
      add_collaborators_to_projects(
        db,
        ACCOUNT_ID,
        [TARGET_ACCOUNT_ID],
        [PROJECT_ID],
      ),
    ).rejects.toThrow(
      `user ${ACCOUNT_ID} does not have write access to project ${PROJECT_ID}`,
    );
    expect(db.add_user_to_project).not.toHaveBeenCalled();
  });

  it("allows course self-add only when the course project is local", async () => {
    assertLocalProjectCollaboratorMock = jest.fn(async ({ project_id }) => {
      if (project_id === PROJECT_ID) {
        throw new Error("project belongs to another bay");
      }
      if (project_id === COURSE_PROJECT_ID) {
        return;
      }
      throw new Error(`unexpected project ${project_id}`);
    });
    const { add_collaborators_to_projects } = await import("./collab");
    const db = {
      user_is_collaborator: jest.fn(async () => false),
      add_user_to_project: jest.fn(async () => undefined),
      async_query: jest.fn(async ({ query, params }) => {
        if (query === "SELECT course FROM projects WHERE project_id=$1") {
          expect(params).toEqual([PROJECT_ID]);
          return { rows: [{ course: { project_id: COURSE_PROJECT_ID } }] };
        }
        throw new Error(`unexpected query: ${query}`);
      }),
    } as any;
    await expect(
      add_collaborators_to_projects(db, ACCOUNT_ID, [ACCOUNT_ID], [PROJECT_ID]),
    ).resolves.toBeUndefined();
    expect(assertLocalProjectCollaboratorMock).toHaveBeenNthCalledWith(1, {
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
    });
    expect(assertLocalProjectCollaboratorMock).toHaveBeenNthCalledWith(2, {
      account_id: ACCOUNT_ID,
      project_id: COURSE_PROJECT_ID,
    });
    expect(db.add_user_to_project).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      account_id: ACCOUNT_ID,
    });
  });
});
