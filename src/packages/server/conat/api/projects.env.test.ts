export {};

let getLocalProjectCollaboratorAccessStatusMock: jest.Mock;
let isAdminMock: jest.Mock;
let getPoolMock: jest.Mock;
let queryMock: jest.Mock;
let assertCollabMock: jest.Mock;
let publishProjectDetailInvalidationBestEffortMock: jest.Mock;
let listProjectSecretsMock: jest.Mock;
let setProjectSecretMock: jest.Mock;
let deleteProjectSecretMock: jest.Mock;
let copyProjectSecretsMock: jest.Mock;

jest.mock("@cocalc/server/conat/project-local-access", () => ({
  __esModule: true,
  PROJECT_COLLABORATOR_REQUIRED_ERROR: "user must be a collaborator on project",
  PROJECT_NOT_FOUND_ERROR: "project not found",
  getLocalProjectCollaboratorAccessStatus: (...args: any[]) =>
    getLocalProjectCollaboratorAccessStatusMock(...args),
}));

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: any[]) => isAdminMock(...args),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: (...args: any[]) => getPoolMock(...args),
}));

jest.mock("./util", () => ({
  __esModule: true,
  assertCollab: (...args: any[]) => assertCollabMock(...args),
}));

jest.mock("@cocalc/server/account/project-detail-feed", () => ({
  __esModule: true,
  publishProjectDetailInvalidationBestEffort: (...args: any[]) =>
    publishProjectDetailInvalidationBestEffortMock(...args),
}));

jest.mock("@cocalc/server/projects/project-secrets", () => ({
  __esModule: true,
  listProjectSecrets: (...args: any[]) => listProjectSecretsMock(...args),
  setProjectSecret: (...args: any[]) => setProjectSecretMock(...args),
  deleteProjectSecret: (...args: any[]) => deleteProjectSecretMock(...args),
  copyProjectSecrets: (...args: any[]) => copyProjectSecretsMock(...args),
}));

describe("project env helpers", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
  const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
  const TARGET_PROJECT_ID = "33333333-3333-4333-8333-333333333333";

  beforeEach(() => {
    jest.resetModules();
    getLocalProjectCollaboratorAccessStatusMock = jest.fn(
      async () => "local-collaborator",
    );
    assertCollabMock = jest.fn(async () => undefined);
    isAdminMock = jest.fn(async () => false);
    queryMock = jest.fn(async () => ({
      rows: [
        {
          launcher: null,
          region: null,
          created: null,
          env: { FOO: "bar", PATH: "/custom/bin:$PATH" },
          rootfs_image: null,
          rootfs_image_id: null,
          snapshots: null,
          backups: null,
          run_quota: null,
          settings: null,
          course: null,
        },
      ],
    }));
    getPoolMock = jest.fn(() => ({
      query: queryMock,
      connect: jest.fn(async () => ({
        query: queryMock,
        release: jest.fn(),
      })),
    }));
    publishProjectDetailInvalidationBestEffortMock = jest.fn(
      async () => undefined,
    );
    listProjectSecretsMock = jest.fn(async () => [
      {
        project_id: PROJECT_ID,
        name: "API_KEY",
        value_bytes: 6,
        created_by: ACCOUNT_ID,
        updated_by: ACCOUNT_ID,
        created_at: new Date("2026-05-13T00:00:00.000Z"),
        updated_at: new Date("2026-05-13T00:00:00.000Z"),
      },
    ]);
    setProjectSecretMock = jest.fn(
      async ({ project_id, name, account_id }) => ({
        project_id,
        name,
        value_bytes: 6,
        created_by: account_id,
        updated_by: account_id,
        created_at: new Date("2026-05-13T00:00:00.000Z"),
        updated_at: new Date("2026-05-13T00:00:00.000Z"),
      }),
    );
    deleteProjectSecretMock = jest.fn(async () => true);
    copyProjectSecretsMock = jest.fn(async () => ({
      copied: ["API_KEY"],
      conflicts: [],
      missing: [],
    }));
  });

  it("returns project env for a collaborator", async () => {
    const { getProjectEnv } = await import("./projects");
    await expect(
      getProjectEnv({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual({ FOO: "bar", PATH: "/custom/bin:$PATH" });
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining("SELECT"), [
      PROJECT_ID,
    ]);
  });

  it("allows admins to read project env without collaborator access", async () => {
    getLocalProjectCollaboratorAccessStatusMock = jest.fn(
      async () => "not-collaborator",
    );
    isAdminMock = jest.fn(async () => true);
    const { getProjectEnv } = await import("./projects");
    await expect(
      getProjectEnv({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual({ FOO: "bar", PATH: "/custom/bin:$PATH" });
    expect(isAdminMock).toHaveBeenCalledWith(ACCOUNT_ID);
  });

  it("updates project env and publishes detail invalidation", async () => {
    queryMock = jest.fn(async () => ({ rows: [] }));
    getPoolMock = jest.fn(() => ({
      query: queryMock,
      connect: jest.fn(async () => ({
        query: queryMock,
        release: jest.fn(),
      })),
    }));
    const { setProjectEnv } = await import("./projects");

    await expect(
      setProjectEnv({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        env: { HELLO: "world" },
      }),
    ).resolves.toBeUndefined();

    expect(assertCollabMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
    });
    expect(queryMock).toHaveBeenCalledWith(
      "UPDATE projects SET env = $2 WHERE project_id = $1",
      [PROJECT_ID, { HELLO: "world" }],
    );
    expect(publishProjectDetailInvalidationBestEffortMock).toHaveBeenCalledWith(
      {
        project_id: PROJECT_ID,
        fields: ["env"],
      },
    );
  });

  it("rejects reserved project env names", async () => {
    const { setProjectEnv } = await import("./projects");

    await expect(
      setProjectEnv({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        env: { COCALC_SECRETS: "/tmp/nope" },
      }),
    ).rejects.toThrow("managed by CoCalc");

    expect(assertCollabMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("lists project secret metadata for collaborators", async () => {
    const { listProjectSecrets } = await import("./projects");

    await expect(
      listProjectSecrets({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        project_id: PROJECT_ID,
        name: "API_KEY",
        value_bytes: 6,
      }),
    ]);

    expect(assertCollabMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
    });
    expect(listProjectSecretsMock).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
    });
  });

  it("sets project secrets and publishes detail invalidation", async () => {
    const { setProjectSecret } = await import("./projects");

    await expect(
      setProjectSecret({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        name: "API_KEY",
        value: "secret",
      }),
    ).resolves.toEqual(expect.objectContaining({ name: "API_KEY" }));

    expect(setProjectSecretMock).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      name: "API_KEY",
      value: "secret",
      account_id: ACCOUNT_ID,
    });
    expect(publishProjectDetailInvalidationBestEffortMock).toHaveBeenCalledWith(
      {
        project_id: PROJECT_ID,
        fields: ["secrets"],
      },
    );
  });

  it("deletes project secrets and publishes detail invalidation", async () => {
    const { deleteProjectSecret } = await import("./projects");

    await expect(
      deleteProjectSecret({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        name: "API_KEY",
      }),
    ).resolves.toEqual({ deleted: true });

    expect(deleteProjectSecretMock).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      name: "API_KEY",
      account_id: ACCOUNT_ID,
    });
    expect(publishProjectDetailInvalidationBestEffortMock).toHaveBeenCalledWith(
      {
        project_id: PROJECT_ID,
        fields: ["secrets"],
      },
    );
  });

  it("copies project secrets between collaborator projects", async () => {
    const { copyProjectSecrets } = await import("./projects");

    await expect(
      copyProjectSecrets({
        account_id: ACCOUNT_ID,
        source_project_id: PROJECT_ID,
        target_project_id: TARGET_PROJECT_ID,
        names: ["API_KEY"],
      }),
    ).resolves.toEqual({
      copied: ["API_KEY"],
      conflicts: [],
      missing: [],
    });

    expect(assertCollabMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
    });
    expect(assertCollabMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: TARGET_PROJECT_ID,
    });
    expect(copyProjectSecretsMock).toHaveBeenCalledWith({
      source_project_id: PROJECT_ID,
      target_project_id: TARGET_PROJECT_ID,
      names: ["API_KEY"],
      overwrite: undefined,
      account_id: ACCOUNT_ID,
    });
    expect(publishProjectDetailInvalidationBestEffortMock).toHaveBeenCalledWith(
      {
        project_id: TARGET_PROJECT_ID,
        fields: ["secrets"],
      },
    );
  });
});
