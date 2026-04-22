export {};

let queryMock: jest.Mock;
let addUserToProjectMock: jest.Mock;
let getOneProjectMock: jest.Mock;
let getProjectMock: jest.Mock;
let startProjectMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: queryMock })),
}));

jest.mock("@cocalc/server/projects/add-user-to-project", () => ({
  __esModule: true,
  default: (...args: any[]) => addUserToProjectMock(...args),
}));

jest.mock("@cocalc/server/projects/get-one", () => ({
  __esModule: true,
  default: (...args: any[]) => getOneProjectMock(...args),
}));

jest.mock("@cocalc/server/projects/control", () => ({
  getProject: (...args: any[]) => getProjectMock(...args),
}));

jest.mock("@cocalc/backend/logger", () => ({
  getLogger: () => ({
    debug: jest.fn(),
    error: jest.fn(),
  }),
}));

describe("accountCreationActions", () => {
  beforeEach(() => {
    jest.resetModules();
    queryMock = jest.fn(async () => ({ rows: [] }));
    addUserToProjectMock = jest.fn(async () => undefined);
    getOneProjectMock = jest.fn(async () => ({ project_id: "project-1" }));
    startProjectMock = jest.fn(async () => undefined);
    getProjectMock = jest.fn(() => ({ start: startProjectMock }));
  });

  it("does not auto-create or start a first project when the account has no invite actions", async () => {
    const accountCreationActions = (await import("./account-creation-actions"))
      .default;

    await accountCreationActions({
      email_address: "new-user@test.local",
      account_id: "11111111-1111-4111-8111-111111111111",
    });

    expect(queryMock).toHaveBeenCalledWith(
      "SELECT action FROM account_creation_actions WHERE email_address=$1 AND expire > NOW()",
      ["new-user@test.local"],
    );
    expect(addUserToProjectMock).not.toHaveBeenCalled();
    expect(getOneProjectMock).not.toHaveBeenCalled();
    expect(getProjectMock).not.toHaveBeenCalled();
    expect(startProjectMock).not.toHaveBeenCalled();
  });
});
