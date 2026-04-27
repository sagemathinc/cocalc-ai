export {};

let queryMock: jest.Mock;
let dstreamMock: jest.Mock;
let loadHostFromRegistryMock: jest.Mock;
let selectActiveHostMock: jest.Mock;
let deleteProjectDataOnHostMock: jest.Mock;
let savePlacementMock: jest.Mock;
let stopProjectOnHostMock: jest.Mock;
let startProjectLroMock: jest.Mock;
let waitForLroCompletionMock: jest.Mock;
let assertPortableProjectRootfsMock: jest.Mock;
let resolveHostConnectionMock: jest.Mock;
let getProjectFileServerClientMock: jest.Mock;
let projectLogRows: any[];

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: queryMock })),
}));

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

jest.mock("@cocalc/backend/conat", () => ({
  conat: jest.fn(() => ({})),
}));

jest.mock("@cocalc/backend/conat/sync", () => ({
  dstream: (...args: any[]) => dstreamMock(...args),
}));

jest.mock("@cocalc/util/consts", () => ({
  DEFAULT_R2_REGION: "wnam",
  mapCloudRegionToR2Region: jest.fn(() => "wnam"),
  parseR2Region: jest.fn(() => "wnam"),
}));

jest.mock("../project-host/control", () => ({
  loadHostFromRegistry: (...args: any[]) => loadHostFromRegistryMock(...args),
  selectActiveHost: (...args: any[]) => selectActiveHostMock(...args),
  deleteProjectDataOnHost: (...args: any[]) =>
    deleteProjectDataOnHostMock(...args),
  savePlacement: (...args: any[]) => savePlacementMock(...args),
  stopProjectOnHost: (...args: any[]) => stopProjectOnHostMock(...args),
}));

jest.mock("../conat/api/projects", () => ({
  start: (...args: any[]) => startProjectLroMock(...args),
}));

jest.mock("../conat/api/hosts", () => ({
  resolveHostConnection: (...args: any[]) => resolveHostConnectionMock(...args),
}));

jest.mock("@cocalc/conat/lro/client", () => ({
  waitForCompletion: (...args: any[]) => waitForLroCompletionMock(...args),
}));

jest.mock("./offline-move-confirmation", () => ({
  makeOfflineMoveConfirmationPayload: jest.fn(),
  offlineMoveConfirmationError: jest.fn((payload) => payload),
}));

jest.mock("@cocalc/server/conat/file-server-client", () => ({
  getProjectFileServerClient: (...args: any[]) =>
    getProjectFileServerClientMock(...args),
}));

jest.mock("./rootfs-state", () => ({
  assertPortableProjectRootfs: (...args: any[]) =>
    assertPortableProjectRootfsMock(...args),
}));

describe("moveProjectToHost", () => {
  const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
  const SOURCE_HOST_ID = "22222222-2222-4222-8222-222222222222";
  const DEST_HOST_ID = "33333333-3333-4333-8333-333333333333";

  let postTimeoutState: {
    host_id: string | null;
    project_state: string | null;
  };

  beforeEach(() => {
    jest.resetModules();
    projectLogRows = [];
    postTimeoutState = {
      host_id: DEST_HOST_ID,
      project_state: "running",
    };
    queryMock = jest.fn(async (sql: string) => {
      if (
        sql.includes("COALESCE(projects.owning_bay_id, $2)") &&
        sql.includes("COALESCE(project_hosts.bay_id, $2)")
      ) {
        return {
          rows: [
            {
              project_id: PROJECT_ID,
              host_id: SOURCE_HOST_ID,
              region: "wnam",
              project_state: "opened",
              provisioned: false,
              last_backup: null,
              last_edited: null,
              project_owning_bay_id: "bay-0",
              host_bay_id: "bay-0",
            },
          ],
        };
      }
      if (
        sql.includes("SELECT status, deleted, last_seen FROM project_hosts")
      ) {
        return {
          rows: [{ status: "off", deleted: null, last_seen: new Date() }],
        };
      }
      if (sql.includes("SELECT host_id, state->>'state' AS project_state")) {
        return { rows: [postTimeoutState] };
      }
      if (
        sql.includes("SELECT status, deleted, last_seen FROM project_hosts")
      ) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    loadHostFromRegistryMock = jest.fn(async (host_id: string) => ({
      id: host_id,
      bay_id: "bay-0",
      region: "us-west1",
    }));
    selectActiveHostMock = jest.fn();
    deleteProjectDataOnHostMock = jest.fn(async () => undefined);
    savePlacementMock = jest.fn(async () => undefined);
    stopProjectOnHostMock = jest.fn(async () => undefined);
    startProjectLroMock = jest.fn(async () => ({
      op_id: "44444444-4444-4444-8444-444444444444",
      scope_type: "project",
      scope_id: PROJECT_ID,
    }));
    getProjectFileServerClientMock = jest.fn(async () => ({
      createBackup: jest.fn(async () => ({
        id: "backup-1",
        time: new Date("2026-04-26T16:00:00.000Z"),
      })),
    }));
    waitForLroCompletionMock = jest.fn(async () => {
      throw new Error("timeout waiting for lro completion");
    });
    assertPortableProjectRootfsMock = jest.fn(async () => undefined);
    resolveHostConnectionMock = jest.fn(async ({ host_id }: any) => ({
      host_id,
      bay_id: "bay-0",
      region: "us-west1",
    }));
    dstreamMock = jest.fn(async () => ({
      getAll: () => [...projectLogRows],
      publish: (row: any) => {
        projectLogRows.push(row);
      },
      save: jest.fn(async () => undefined),
      close: jest.fn(),
    }));
  });

  it("accepts a timed-out destination start wait if the project is already running on the destination host", async () => {
    const { moveProjectToHost } = await import("./move");
    await expect(
      moveProjectToHost({
        project_id: PROJECT_ID,
        dest_host_id: DEST_HOST_ID,
        account_id: "account-id",
        allow_offline: true,
      }),
    ).resolves.toBeUndefined();

    expect(waitForLroCompletionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        timeout_ms: 5 * 60 * 1000,
      }),
    );
    expect(savePlacementMock).toHaveBeenCalledTimes(1);
    expect(savePlacementMock).toHaveBeenCalledWith(PROJECT_ID, {
      host_id: DEST_HOST_ID,
    });
    expect(deleteProjectDataOnHostMock).not.toHaveBeenCalled();
  });

  it("reverts placement and cleans destination data if the destination never reaches running", async () => {
    postTimeoutState = {
      host_id: DEST_HOST_ID,
      project_state: "starting",
    };
    const { moveProjectToHost } = await import("./move");
    await expect(
      moveProjectToHost({
        project_id: PROJECT_ID,
        dest_host_id: DEST_HOST_ID,
        account_id: "account-id",
        allow_offline: true,
      }),
    ).rejects.toThrow(/destination start wait failed/);

    expect(savePlacementMock).toHaveBeenNthCalledWith(1, PROJECT_ID, {
      host_id: DEST_HOST_ID,
    });
    expect(savePlacementMock).toHaveBeenNthCalledWith(2, PROJECT_ID, {
      host_id: SOURCE_HOST_ID,
    });
    expect(deleteProjectDataOnHostMock).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      host_id: DEST_HOST_ID,
    });
  });

  it("allows a move to a host in another bay", async () => {
    resolveHostConnectionMock = jest.fn(async ({ host_id }: any) => ({
      host_id,
      bay_id: host_id === DEST_HOST_ID ? "bay-9" : "bay-0",
      region: "us-west1",
    }));
    const { moveProjectToHost } = await import("./move");
    await expect(
      moveProjectToHost({
        project_id: PROJECT_ID,
        dest_host_id: DEST_HOST_ID,
        account_id: "account-id",
        allow_offline: true,
      }),
    ).resolves.toBeUndefined();

    expect(resolveHostConnectionMock).toHaveBeenCalledWith({
      account_id: "account-id",
      host_id: DEST_HOST_ID,
    });
    expect(savePlacementMock).toHaveBeenCalledWith(PROJECT_ID, {
      host_id: DEST_HOST_ID,
    });
  });

  it("keeps a remote current host as the source placement", async () => {
    queryMock = jest.fn(async (sql: string) => {
      if (
        sql.includes(
          "SELECT\n        projects.project_id,\n        projects.host_id,",
        )
      ) {
        return {
          rows: [
            {
              project_id: PROJECT_ID,
              host_id: SOURCE_HOST_ID,
              region: "wnam",
              project_state: "opened",
              provisioned: false,
              last_backup: null,
              last_edited: null,
              project_owning_bay_id: "bay-0",
              host_bay_id: "bay-9",
            },
          ],
        };
      }
      if (
        sql.includes("SELECT status, deleted, last_seen FROM project_hosts")
      ) {
        return { rows: [] };
      }
      if (sql.includes("SELECT host_id, state->>'state' AS project_state")) {
        return { rows: [postTimeoutState] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    selectActiveHostMock = jest.fn(async () => ({
      id: DEST_HOST_ID,
      bay_id: "bay-0",
      region: "us-west1",
    }));

    const { moveProjectToHost } = await import("./move");
    await expect(
      moveProjectToHost({
        project_id: PROJECT_ID,
        account_id: "account-id",
        allow_offline: true,
      }),
    ).resolves.toBeUndefined();

    expect(selectActiveHostMock).toHaveBeenCalledWith({
      exclude_host_id: SOURCE_HOST_ID,
      bay_id: "bay-0",
    });
    expect(deleteProjectDataOnHostMock).not.toHaveBeenCalled();
  });

  it("rejects move before touching placement when the project RootFS is not portable", async () => {
    assertPortableProjectRootfsMock.mockRejectedValue(
      new Error(
        "cannot move project while its RootFS is still backed by unsealed OCI image 'docker.io/ubuntu:26.04'",
      ),
    );
    const { moveProjectToHost } = await import("./move");
    await expect(
      moveProjectToHost({
        project_id: PROJECT_ID,
        dest_host_id: DEST_HOST_ID,
        account_id: "account-id",
        allow_offline: true,
      }),
    ).rejects.toThrow(/unsealed OCI image/);

    expect(assertPortableProjectRootfsMock).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      operation: "move",
    });
    expect(savePlacementMock).not.toHaveBeenCalled();
    expect(stopProjectOnHostMock).not.toHaveBeenCalled();
    expect(deleteProjectDataOnHostMock).not.toHaveBeenCalled();
  });

  it("retries stopping the source project once after a transient parse failure", async () => {
    queryMock = jest.fn(async (sql: string) => {
      if (
        sql.includes("COALESCE(projects.owning_bay_id, $2)") &&
        sql.includes("COALESCE(project_hosts.bay_id, $2)")
      ) {
        return {
          rows: [
            {
              project_id: PROJECT_ID,
              host_id: SOURCE_HOST_ID,
              region: "wnam",
              project_state: "running",
              provisioned: false,
              last_backup: null,
              last_edited: null,
              project_owning_bay_id: "bay-0",
              host_bay_id: "bay-0",
            },
          ],
        };
      }
      if (
        sql.includes("SELECT status, deleted, last_seen FROM project_hosts")
      ) {
        return {
          rows: [{ status: "running", deleted: null, last_seen: new Date() }],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    stopProjectOnHostMock = jest
      .fn()
      .mockRejectedValueOnce(new Error("Unexpected end of JSON input"))
      .mockResolvedValue(undefined);

    const { moveProjectToHost } = await import("./move");
    await expect(
      moveProjectToHost({
        project_id: PROJECT_ID,
        dest_host_id: DEST_HOST_ID,
        account_id: "account-id",
        start_dest: false,
      }),
    ).resolves.toBeUndefined();

    expect(stopProjectOnHostMock).toHaveBeenCalledTimes(2);
  });

  it("retries the final backup once after a transient parse failure", async () => {
    queryMock = jest.fn(async (sql: string) => {
      if (
        sql.includes("COALESCE(projects.owning_bay_id, $2)") &&
        sql.includes("COALESCE(project_hosts.bay_id, $2)")
      ) {
        return {
          rows: [
            {
              project_id: PROJECT_ID,
              host_id: SOURCE_HOST_ID,
              region: "wnam",
              project_state: "running",
              provisioned: true,
              last_backup: null,
              last_edited: null,
              project_owning_bay_id: "bay-0",
              host_bay_id: "bay-0",
            },
          ],
        };
      }
      if (
        sql.includes("SELECT status, deleted, last_seen FROM project_hosts")
      ) {
        return {
          rows: [{ status: "running", deleted: null, last_seen: new Date() }],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const createBackupMock = jest
      .fn()
      .mockRejectedValueOnce(new Error("Unexpected end of JSON input"))
      .mockResolvedValue({
        id: "backup-2",
        time: new Date("2026-04-26T16:00:00.000Z"),
      });
    getProjectFileServerClientMock = jest.fn(async () => ({
      createBackup: createBackupMock,
    }));

    const { moveProjectToHost } = await import("./move");
    await expect(
      moveProjectToHost({
        project_id: PROJECT_ID,
        dest_host_id: DEST_HOST_ID,
        account_id: "account-id",
        start_dest: false,
      }),
    ).resolves.toBeUndefined();

    expect(createBackupMock).toHaveBeenCalledTimes(2);
  });

  it("writes project log entries for move start and success", async () => {
    queryMock = jest.fn(async (sql: string) => {
      if (
        sql.includes("COALESCE(projects.owning_bay_id, $2)") &&
        sql.includes("COALESCE(project_hosts.bay_id, $2)")
      ) {
        return {
          rows: [
            {
              project_id: PROJECT_ID,
              host_id: SOURCE_HOST_ID,
              region: "wnam",
              project_state: "running",
              provisioned: true,
              last_backup: null,
              last_edited: null,
              project_owning_bay_id: "bay-0",
              host_bay_id: "bay-0",
            },
          ],
        };
      }
      if (
        sql.includes("SELECT status, deleted, last_seen FROM project_hosts")
      ) {
        return {
          rows: [{ status: "running", deleted: null, last_seen: new Date() }],
        };
      }
      if (sql.includes("SELECT host_id, state->>'state' AS project_state")) {
        return { rows: [postTimeoutState] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    waitForLroCompletionMock = jest.fn(async () => ({
      status: "succeeded",
    }));

    const { moveProjectToHost } = await import("./move");
    await expect(
      moveProjectToHost(
        {
          project_id: PROJECT_ID,
          dest_host_id: DEST_HOST_ID,
          account_id: "account-id",
        },
        { op_id: "move-op-1" },
      ),
    ).resolves.toBeUndefined();

    expect(projectLogRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "project-move:move-op-1:project_move_requested",
          project_id: PROJECT_ID,
          account_id: "account-id",
          event: expect.objectContaining({
            event: "project_move_requested",
            op_id: "move-op-1",
            source_host_id: SOURCE_HOST_ID,
            dest_host_id: DEST_HOST_ID,
          }),
        }),
        expect.objectContaining({
          id: "project-move:move-op-1:project_moved",
          project_id: PROJECT_ID,
          account_id: "account-id",
          event: expect.objectContaining({
            event: "project_moved",
            op_id: "move-op-1",
            source_host_id: SOURCE_HOST_ID,
            dest_host_id: DEST_HOST_ID,
          }),
        }),
      ]),
    );
    expect(
      projectLogRows.filter(
        ({ id }: { id: string }) =>
          id === "project-move:move-op-1:project_move_requested",
      ),
    ).toHaveLength(1);
  });

  it("writes project log entries for move start and failure", async () => {
    queryMock = jest.fn(async (sql: string) => {
      if (
        sql.includes("COALESCE(projects.owning_bay_id, $2)") &&
        sql.includes("COALESCE(project_hosts.bay_id, $2)")
      ) {
        return {
          rows: [
            {
              project_id: PROJECT_ID,
              host_id: SOURCE_HOST_ID,
              region: "wnam",
              project_state: "running",
              provisioned: true,
              last_backup: null,
              last_edited: null,
              project_owning_bay_id: "bay-0",
              host_bay_id: "bay-0",
            },
          ],
        };
      }
      if (
        sql.includes("SELECT status, deleted, last_seen FROM project_hosts")
      ) {
        return {
          rows: [{ status: "running", deleted: null, last_seen: new Date() }],
        };
      }
      if (sql.includes("SELECT host_id, state->>'state' AS project_state")) {
        return {
          rows: [{ host_id: DEST_HOST_ID, project_state: "starting" }],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { moveProjectToHost } = await import("./move");
    await expect(
      moveProjectToHost(
        {
          project_id: PROJECT_ID,
          dest_host_id: DEST_HOST_ID,
          account_id: "account-id",
        },
        { op_id: "move-op-2" },
      ),
    ).rejects.toThrow(/destination start wait failed/);

    expect(projectLogRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "project-move:move-op-2:project_move_requested",
          event: expect.objectContaining({
            event: "project_move_requested",
            op_id: "move-op-2",
            source_host_id: SOURCE_HOST_ID,
            dest_host_id: DEST_HOST_ID,
          }),
        }),
        expect.objectContaining({
          id: "project-move:move-op-2:project_move_failed",
          event: expect.objectContaining({
            event: "project_move_failed",
            op_id: "move-op-2",
            source_host_id: SOURCE_HOST_ID,
            dest_host_id: DEST_HOST_ID,
            error: expect.stringContaining("destination start wait failed"),
          }),
        }),
      ]),
    );
  });
});
