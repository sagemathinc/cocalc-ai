export {};

let queryMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: queryMock })),
}));

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

describe("project local access", () => {
  beforeEach(() => {
    jest.resetModules();
    queryMock = jest.fn(async () => ({ rows: [] }));
  });

  it("grants local collaborator access", async () => {
    queryMock = jest.fn(async () => ({
      rows: [{ group: "collaborator", owning_bay_id: "bay-0" }],
    }));
    const {
      hasLocalProjectCollaboratorAccess,
      assertLocalProjectCollaborator,
    } = await import("./project-local-access");
    await expect(
      hasLocalProjectCollaboratorAccess({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toBe(true);
    await expect(
      assertLocalProjectCollaborator({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toBeUndefined();
  });

  it("returns false and throws for projects owned by another bay", async () => {
    queryMock = jest.fn(async () => ({
      rows: [{ group: "owner", owning_bay_id: "bay-9" }],
    }));
    const {
      hasLocalProjectCollaboratorAccess,
      assertLocalProjectCollaborator,
      PROJECT_OWNED_BY_ANOTHER_BAY_ERROR,
    } = await import("./project-local-access");
    await expect(
      hasLocalProjectCollaboratorAccess({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toBe(false);
    await expect(
      assertLocalProjectCollaborator({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).rejects.toThrow(PROJECT_OWNED_BY_ANOTHER_BAY_ERROR);
  });

  it("returns false and throws for non-collaborators", async () => {
    queryMock = jest.fn(async () => ({
      rows: [{ group: "viewer", owning_bay_id: "bay-0" }],
    }));
    const {
      hasLocalProjectCollaboratorAccess,
      assertLocalProjectCollaborator,
      PROJECT_COLLABORATOR_REQUIRED_ERROR,
    } = await import("./project-local-access");
    await expect(
      hasLocalProjectCollaboratorAccess({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toBe(false);
    await expect(
      assertLocalProjectCollaborator({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).rejects.toThrow(PROJECT_COLLABORATOR_REQUIRED_ERROR);
  });

  it("throws for missing projects when checking local ownership", async () => {
    queryMock = jest.fn(async () => ({ rows: [] }));
    const { assertLocalProjectOwnership, PROJECT_NOT_FOUND_ERROR } =
      await import("./project-local-access");
    await expect(
      assertLocalProjectOwnership({
        project_id: PROJECT_ID,
      }),
    ).rejects.toThrow(PROJECT_NOT_FOUND_ERROR);
  });
});
