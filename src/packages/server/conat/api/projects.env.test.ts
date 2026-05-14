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
let generateProjectSshKeySecretLocalMock: jest.Mock;
let exportProjectSecretsForCopyMock: jest.Mock;
let importProjectSecretsForCopyMock: jest.Mock;
let resolveProjectBayMock: jest.Mock;
let interBayProjectSecretsMock: {
  list: jest.Mock;
  set: jest.Mock;
  delete: jest.Mock;
  copy: jest.Mock;
  exportForCopy: jest.Mock;
  importForCopy: jest.Mock;
  generateSshKeySecret: jest.Mock;
};

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

jest.mock("@cocalc/server/bay-config", () => ({
  __esModule: true,
  getConfiguredBayId: () => "bay-0",
}));

jest.mock("@cocalc/server/inter-bay/directory", () => ({
  __esModule: true,
  resolveProjectBay: (...args: any[]) => resolveProjectBayMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  __esModule: true,
  getInterBayBridge: () => ({
    projectSecrets: () => interBayProjectSecretsMock,
  }),
}));

jest.mock("@cocalc/server/projects/project-secrets", () => ({
  __esModule: true,
  listProjectSecrets: (...args: any[]) => listProjectSecretsMock(...args),
  setProjectSecret: (...args: any[]) => setProjectSecretMock(...args),
  deleteProjectSecret: (...args: any[]) => deleteProjectSecretMock(...args),
  copyProjectSecrets: (...args: any[]) => copyProjectSecretsMock(...args),
  exportProjectSecretsForCopy: (...args: any[]) =>
    exportProjectSecretsForCopyMock(...args),
  importProjectSecretsForCopy: (...args: any[]) =>
    importProjectSecretsForCopyMock(...args),
}));

jest.mock("@cocalc/server/projects/project-secret-ssh-key", () => ({
  __esModule: true,
  generateProjectSshKeySecretLocal: (...args: any[]) =>
    generateProjectSshKeySecretLocalMock(...args),
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
    generateProjectSshKeySecretLocalMock = jest.fn(
      async ({ project_id, secret_name }) => ({
        secret: {
          project_id,
          name: secret_name ?? "SSH_PRIVATE_KEY",
          value_bytes: 411,
          created_by: ACCOUNT_ID,
          updated_by: ACCOUNT_ID,
          created_at: new Date("2026-05-13T00:00:00.000Z"),
          updated_at: new Date("2026-05-13T00:00:00.000Z"),
        },
        secret_name: secret_name ?? "SSH_PRIVATE_KEY",
        public_key: "ssh-ed25519 AAAATEST cocalc-project:test",
        setup: {
          ok: true,
          private_key_path: ".ssh/id_ed25519",
          public_key_path: ".ssh/id_ed25519.pub",
          symlink_target: "/run/secrets/cocalc/SSH_PRIVATE_KEY",
        },
        restart_required: true,
      }),
    );
    exportProjectSecretsForCopyMock = jest.fn(async () => ({
      secrets: { API_KEY: "secret" },
      missing: [],
    }));
    importProjectSecretsForCopyMock = jest.fn(async () => ({
      copied: ["API_KEY"],
      conflicts: [],
      missing: [],
    }));
    resolveProjectBayMock = jest.fn(async () => ({
      bay_id: "bay-0",
      epoch: 1,
    }));
    interBayProjectSecretsMock = {
      list: jest.fn(async () => [
        {
          project_id: PROJECT_ID,
          name: "API_KEY",
          value_bytes: 6,
          created_by: ACCOUNT_ID,
          updated_by: ACCOUNT_ID,
          created_at: new Date("2026-05-13T00:00:00.000Z"),
          updated_at: new Date("2026-05-13T00:00:00.000Z"),
        },
      ]),
      set: jest.fn(async ({ project_id, name, account_id }) => ({
        project_id,
        name,
        value_bytes: 6,
        created_by: account_id,
        updated_by: account_id,
        created_at: new Date("2026-05-13T00:00:00.000Z"),
        updated_at: new Date("2026-05-13T00:00:00.000Z"),
      })),
      delete: jest.fn(async () => ({ deleted: true })),
      copy: jest.fn(async () => ({
        copied: ["API_KEY"],
        conflicts: [],
        missing: [],
      })),
      exportForCopy: jest.fn(async () => ({
        secrets: { API_KEY: "secret" },
        missing: [],
      })),
      importForCopy: jest.fn(async () => ({
        copied: ["API_KEY"],
        conflicts: [],
        missing: [],
      })),
      generateSshKeySecret: jest.fn(async () => ({
        secret: {
          project_id: PROJECT_ID,
          name: "SSH_PRIVATE_KEY",
          value_bytes: 411,
          created_by: ACCOUNT_ID,
          updated_by: ACCOUNT_ID,
          created_at: new Date("2026-05-13T00:00:00.000Z"),
          updated_at: new Date("2026-05-13T00:00:00.000Z"),
        },
        secret_name: "SSH_PRIVATE_KEY",
        public_key: "ssh-ed25519 AAAATEST cocalc-project:test",
        setup: {
          ok: true,
          private_key_path: ".ssh/id_ed25519",
          public_key_path: ".ssh/id_ed25519.pub",
          symlink_target: "/run/secrets/cocalc/SSH_PRIVATE_KEY",
        },
        restart_required: true,
      })),
    };
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

  it("routes project secret reads to the owning bay", async () => {
    resolveProjectBayMock = jest.fn(async () => ({
      bay_id: "bay-7",
      epoch: 3,
    }));
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
      }),
    ]);

    expect(assertCollabMock).not.toHaveBeenCalled();
    expect(listProjectSecretsMock).not.toHaveBeenCalled();
    expect(interBayProjectSecretsMock.list).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      epoch: 3,
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

  it("routes same-bay remote project secret copies to that bay", async () => {
    resolveProjectBayMock = jest.fn(async (project_id) => ({
      bay_id: "bay-7",
      epoch: project_id === PROJECT_ID ? 3 : 4,
    }));
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

    expect(copyProjectSecretsMock).not.toHaveBeenCalled();
    expect(interBayProjectSecretsMock.copy).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      source_project_id: PROJECT_ID,
      target_project_id: TARGET_PROJECT_ID,
      names: ["API_KEY"],
      overwrite: undefined,
      source_epoch: 3,
      target_epoch: 4,
    });
  });

  it("exports from source bay and imports into target bay for cross-bay secret copies", async () => {
    resolveProjectBayMock = jest.fn(async (project_id) => ({
      bay_id: project_id === PROJECT_ID ? "bay-7" : "bay-8",
      epoch: project_id === PROJECT_ID ? 3 : 4,
    }));
    const { copyProjectSecrets } = await import("./projects");

    await expect(
      copyProjectSecrets({
        account_id: ACCOUNT_ID,
        source_project_id: PROJECT_ID,
        target_project_id: TARGET_PROJECT_ID,
        names: ["API_KEY"],
        overwrite: true,
      }),
    ).resolves.toEqual({
      copied: ["API_KEY"],
      conflicts: [],
      missing: [],
    });

    expect(interBayProjectSecretsMock.exportForCopy).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      names: ["API_KEY"],
      epoch: 3,
    });
    expect(interBayProjectSecretsMock.importForCopy).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: TARGET_PROJECT_ID,
      secrets: { API_KEY: "secret" },
      overwrite: true,
      epoch: 4,
    });
  });

  it("generates an SSH key secret on the owning bay", async () => {
    const { generateProjectSshKeySecret } = await import("./projects");

    await expect(
      generateProjectSshKeySecret({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        secret_name: "SSH_PRIVATE_KEY",
        public_key: "ssh-ed25519 AAAATEST cocalc-project:test",
        restart_required: true,
      }),
    );

    expect(assertCollabMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
    });
    expect(generateProjectSshKeySecretLocalMock).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      account_id: ACCOUNT_ID,
      secret_name: undefined,
    });
    expect(publishProjectDetailInvalidationBestEffortMock).toHaveBeenCalledWith(
      {
        project_id: PROJECT_ID,
        fields: ["secrets"],
      },
    );
  });

  it("routes SSH key secret generation to the owning bay", async () => {
    resolveProjectBayMock = jest.fn(async () => ({
      bay_id: "bay-7",
      epoch: 3,
    }));
    const { generateProjectSshKeySecret } = await import("./projects");

    await expect(
      generateProjectSshKeySecret({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        secret_name: "SSH_PRIVATE_KEY",
      }),
    );

    expect(assertCollabMock).not.toHaveBeenCalled();
    expect(generateProjectSshKeySecretLocalMock).not.toHaveBeenCalled();
    expect(
      interBayProjectSecretsMock.generateSshKeySecret,
    ).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      secret_name: undefined,
      epoch: 3,
    });
  });
});
