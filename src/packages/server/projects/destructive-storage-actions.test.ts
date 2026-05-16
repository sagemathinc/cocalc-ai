export {};

let isAdminMock: jest.Mock;
let assertProjectCollaboratorAccessAllowRemoteMock: jest.Mock;

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: any[]) => isAdminMock(...args),
}));

jest.mock("@cocalc/server/conat/project-remote-access", () => ({
  __esModule: true,
  assertProjectCollaboratorAccessAllowRemote: (...args: any[]) =>
    assertProjectCollaboratorAccessAllowRemoteMock(...args),
}));

describe("assertCanPerformDestructiveStorageAction", () => {
  const account_id = "11111111-1111-4111-8111-111111111111";
  const project_id = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    jest.resetModules();
    isAdminMock = jest.fn(async () => false);
    assertProjectCollaboratorAccessAllowRemoteMock = jest.fn(async () => ({
      project_id,
      title: "Project",
      host_id: null,
      owning_bay_id: "bay-0",
      users: {
        [account_id]: { group: "collaborator" },
      },
      allow_collaborator_destructive_storage_actions: null,
    }));
  });

  it("allows owners", async () => {
    assertProjectCollaboratorAccessAllowRemoteMock = jest.fn(async () => ({
      project_id,
      title: "Project",
      host_id: null,
      owning_bay_id: "bay-0",
      users: {
        [account_id]: { group: "owner" },
      },
      allow_collaborator_destructive_storage_actions: false,
    }));
    const { assertCanPerformDestructiveStorageAction } =
      await import("./destructive-storage-actions");
    await expect(
      assertCanPerformDestructiveStorageAction({
        account_id,
        project_id,
        action: "delete snapshots",
      }),
    ).resolves.toBeUndefined();
  });

  it("allows administrators without requiring project collaborator access", async () => {
    isAdminMock = jest.fn(async () => true);
    const { assertCanPerformDestructiveStorageAction } =
      await import("./destructive-storage-actions");
    await expect(
      assertCanPerformDestructiveStorageAction({
        account_id,
        project_id,
        action: "delete snapshots",
      }),
    ).resolves.toBeUndefined();
    expect(
      assertProjectCollaboratorAccessAllowRemoteMock,
    ).not.toHaveBeenCalled();
  });

  it("allows collaborators when owners opt in", async () => {
    assertProjectCollaboratorAccessAllowRemoteMock = jest.fn(async () => ({
      project_id,
      title: "Project",
      host_id: null,
      owning_bay_id: "bay-0",
      users: {
        [account_id]: { group: "collaborator" },
      },
      allow_collaborator_destructive_storage_actions: true,
    }));
    const { assertCanPerformDestructiveStorageAction } =
      await import("./destructive-storage-actions");
    await expect(
      assertCanPerformDestructiveStorageAction({
        account_id,
        project_id,
        action: "delete snapshots",
      }),
    ).resolves.toBeUndefined();
  });

  it("blocks collaborators by default", async () => {
    const { assertCanPerformDestructiveStorageAction } =
      await import("./destructive-storage-actions");
    await expect(
      assertCanPerformDestructiveStorageAction({
        account_id,
        project_id,
        action: "delete snapshots",
      }),
    ).rejects.toThrow(
      "Only project owners can delete snapshots unless the owner allows collaborators to manage storage history.",
    );
  });
});
