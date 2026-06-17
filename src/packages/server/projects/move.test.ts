export {};

import { EventEmitter } from "node:events";

let queryMock: jest.Mock;
let getExplicitProjectRoutedClientMock: jest.Mock;
let loadHostFromRegistryMock: jest.Mock;
let selectActiveHostMock: jest.Mock;
let deleteProjectDataOnHostMock: jest.Mock;
let savePlacementMock: jest.Mock;
let stopProjectOnHostMock: jest.Mock;
let startProjectLroMock: jest.Mock;
let createBackupLroMock: jest.Mock;
let getLroStreamMock: jest.Mock;
let waitForLroCompletionMock: jest.Mock;
let getLroMock: jest.Mock;
let updateLroMock: jest.Mock;
let assertPortableProjectRootfsMock: jest.Mock;
let resolveHostConnectionMock: jest.Mock;
let getProjectBackupAssignmentStateMock: jest.Mock;
let ensureProjectBackupRepoForRegionMock: jest.Mock;
let resolveProjectBackupRepoAssignmentMock: jest.Mock;
let setProjectBackupRepoIdMock: jest.Mock;
let setProjectBackupRegionMock: jest.Mock;
let purgeProjectBackupsForRepoMock: jest.Mock;
let conatPublishMock: jest.Mock;
let getRoutedHostControlClientMock: jest.Mock;
let invalidateBackupConfigMock: jest.Mock;
let projectLogRows: any[];
let moveCallOrder: string[];

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
  conat: jest.fn(() => ({
    publish: (...args: any[]) => conatPublishMock(...args),
  })),
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

jest.mock("../project-host/client", () => ({
  getRoutedHostControlClient: (...args: any[]) =>
    getRoutedHostControlClientMock(...args),
}));

jest.mock("../conat/api/projects", () => ({
  start: (...args: any[]) => startProjectLroMock(...args),
}));

jest.mock("../conat/api/project-backups", () => ({
  createBackup: (...args: any[]) => createBackupLroMock(...args),
}));

jest.mock("../conat/api/hosts", () => ({
  resolveHostConnection: (...args: any[]) => resolveHostConnectionMock(...args),
}));

jest.mock("@cocalc/server/conat/route-client", () => ({
  getExplicitProjectRoutedClient: (...args: any[]) =>
    getExplicitProjectRoutedClientMock(...args),
}));

jest.mock("@cocalc/conat/lro/client", () => ({
  get: (...args: any[]) => getLroStreamMock(...args),
  waitForCompletion: (...args: any[]) => waitForLroCompletionMock(...args),
}));

jest.mock("@cocalc/server/lro/lro-db", () => ({
  getLro: (...args: any[]) => getLroMock(...args),
  updateLro: (...args: any[]) => updateLroMock(...args),
}));

jest.mock("./offline-move-confirmation", () => ({
  makeOfflineMoveConfirmationPayload: jest.fn(),
  offlineMoveConfirmationError: jest.fn((payload) => payload),
}));

jest.mock("./rootfs-state", () => ({
  assertPortableProjectRootfs: (...args: any[]) =>
    assertPortableProjectRootfsMock(...args),
}));

jest.mock("../project-backup", () => ({
  getProjectBackupAssignmentState: (...args: any[]) =>
    getProjectBackupAssignmentStateMock(...args),
  ensureProjectBackupRepoForRegion: (...args: any[]) =>
    ensureProjectBackupRepoForRegionMock(...args),
  resolveProjectBackupRepoAssignment: (...args: any[]) =>
    resolveProjectBackupRepoAssignmentMock(...args),
  setProjectBackupRepoId: (...args: any[]) =>
    setProjectBackupRepoIdMock(...args),
  setProjectBackupRegion: (...args: any[]) =>
    setProjectBackupRegionMock(...args),
}));

jest.mock("./backup-purge", () => ({
  purgeProjectBackupsForRepo: (...args: any[]) =>
    purgeProjectBackupsForRepoMock(...args),
}));

describe("moveProjectToHost", () => {
  const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
  const SOURCE_HOST_ID = "22222222-2222-4222-8222-222222222222";
  const DEST_HOST_ID = "33333333-3333-4333-8333-333333333333";
  const SOURCE_HOST_NAME = "Source Host";
  const DEST_HOST_NAME = "Destination Host";
  const LEGACY_MOVE_SENTINEL_PATH = ".move-sentinel.json";
  const LEGACY_MOVE_SENTINEL_DIR = ".move-sentinels";
  const MOVE_SENTINEL_PREFIX = ".move-sentinel-";

  const hasMoveSentinel = (files: Map<string, string> | undefined) =>
    !!files &&
    [...files.keys()].some((path) => path.startsWith(MOVE_SENTINEL_PREFIX));

  let postTimeoutState: {
    host_id: string | null;
    project_state: string | null;
  };
  let currentRoutedHostId: string;
  let routedFsByHost: Map<string, Map<string, string>>;
  let hangMoveSentinelReadOnDest: boolean;
  let fsNotInitializedFailuresByHost: Map<string, number>;
  let lroSummaryByOpId: Map<string, any>;

  beforeEach(() => {
    jest.resetModules();
    projectLogRows = [];
    moveCallOrder = [];
    currentRoutedHostId = SOURCE_HOST_ID;
    const sharedFiles = new Map<string, string>();
    routedFsByHost = new Map([
      [SOURCE_HOST_ID, sharedFiles],
      [DEST_HOST_ID, sharedFiles],
    ]);
    hangMoveSentinelReadOnDest = false;
    fsNotInitializedFailuresByHost = new Map();
    lroSummaryByOpId = new Map([
      [
        "55555555-5555-4555-8555-555555555555",
        {
          op_id: "55555555-5555-4555-8555-555555555555",
          scope_type: "project",
          scope_id: PROJECT_ID,
          status: "succeeded",
          result: {
            id: "backup-1",
            time: new Date("2026-04-26T16:00:00.000Z"),
          },
        },
      ],
      [
        "44444444-4444-4444-8444-444444444444",
        {
          op_id: "44444444-4444-4444-8444-444444444444",
          scope_type: "project",
          scope_id: PROJECT_ID,
          status: "succeeded",
          result: {},
        },
      ],
    ]);
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
        sql.includes(
          "SELECT status, deleted, last_seen, name FROM project_hosts",
        )
      ) {
        return {
          rows: [
            {
              status: "off",
              deleted: null,
              last_seen: new Date(),
              name: SOURCE_HOST_NAME,
            },
          ],
        };
      }
      if (sql.includes("SELECT host_id, state->>'state' AS project_state")) {
        return { rows: [postTimeoutState] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    loadHostFromRegistryMock = jest.fn(async (host_id: string) => ({
      id: host_id,
      bay_id: "bay-0",
      name: host_id === SOURCE_HOST_ID ? SOURCE_HOST_NAME : DEST_HOST_NAME,
      region: "us-west1",
    }));
    selectActiveHostMock = jest.fn();
    deleteProjectDataOnHostMock = jest.fn(async () => undefined);
    savePlacementMock = jest.fn(async (_project_id, { host_id }: any) => {
      currentRoutedHostId = host_id;
    });
    stopProjectOnHostMock = jest.fn(async () => {
      moveCallOrder.push("stop-source");
    });
    startProjectLroMock = jest.fn(async () => ({
      op_id: "44444444-4444-4444-8444-444444444444",
      scope_type: "project",
      scope_id: PROJECT_ID,
    }));
    createBackupLroMock = jest.fn(async () => ({
      op_id: "55555555-5555-4555-8555-555555555555",
      scope_type: "project",
      scope_id: PROJECT_ID,
    }));
    getLroStreamMock = jest.fn(async () => {
      throw new Error("test lro stream unavailable");
    });
    waitForLroCompletionMock = jest.fn(async ({ op_id }: any) => {
      if (op_id === "55555555-5555-4555-8555-555555555555") {
        return {
          status: "succeeded",
          result: {
            id: "backup-1",
            time: new Date("2026-04-26T16:00:00.000Z"),
          },
        };
      }
      throw new Error("timeout waiting for lro completion");
    });
    getLroMock = jest.fn(async (op_id: string) => {
      const summary = lroSummaryByOpId.get(op_id);
      if (summary != null) {
        return summary;
      }
      if (op_id.startsWith("start-op-")) {
        return {
          op_id,
          scope_type: "project",
          scope_id: PROJECT_ID,
          status: "succeeded",
          result: {},
        };
      }
      return undefined;
    });
    updateLroMock = jest.fn(async ({ op_id, status, error }: any) => ({
      op_id,
      scope_type: "project",
      scope_id: PROJECT_ID,
      status,
      error,
    }));
    assertPortableProjectRootfsMock = jest.fn(async () => undefined);
    resolveHostConnectionMock = jest.fn(async ({ host_id }: any) => ({
      host_id,
      bay_id: "bay-0",
      name: host_id === SOURCE_HOST_ID ? SOURCE_HOST_NAME : DEST_HOST_NAME,
      region: "us-west1",
      can_place: true,
    }));
    getExplicitProjectRoutedClientMock = jest.fn(async () => ({
      sync: {
        dstream: jest.fn(async () => ({
          getAll: () => [...projectLogRows],
          publish: (row: any) => {
            projectLogRows.push(row);
          },
          save: jest.fn(async () => undefined),
          close: jest.fn(),
        })),
      },
      fs: jest.fn(() => {
        const maybeThrowNotInitialized = () => {
          const remaining =
            fsNotInitializedFailuresByHost.get(currentRoutedHostId) ?? 0;
          if (remaining <= 0) return;
          fsNotInitializedFailuresByHost.set(
            currentRoutedHostId,
            remaining - 1,
          );
          throw new Error("file server not initialized");
        };
        return {
          exists: jest.fn(async (path: string) => {
            maybeThrowNotInitialized();
            if (path === ".") {
              return true;
            }
            return routedFsByHost.get(currentRoutedHostId)?.has(path) ?? false;
          }),
          mkdir: jest.fn(async () => {
            maybeThrowNotInitialized();
          }),
          writeFile: jest.fn(async (path: string, data: any) => {
            maybeThrowNotInitialized();
            if (path.startsWith(MOVE_SENTINEL_PREFIX)) {
              moveCallOrder.push("write-sentinel");
            }
            const files = routedFsByHost.get(currentRoutedHostId);
            if (!files) {
              throw new Error(`missing routed fs host ${currentRoutedHostId}`);
            }
            files.set(path, typeof data === "string" ? data : `${data}`);
          }),
          readFile: jest.fn(async (path: string) => {
            maybeThrowNotInitialized();
            if (
              hangMoveSentinelReadOnDest &&
              currentRoutedHostId === DEST_HOST_ID &&
              path.startsWith(MOVE_SENTINEL_PREFIX)
            ) {
              return await new Promise<string>(() => {});
            }
            const files = routedFsByHost.get(currentRoutedHostId);
            if (!files?.has(path)) {
              throw new Error(
                `ENOENT: no such file or directory, open '${path}'`,
              );
            }
            return files.get(path)!;
          }),
          rm: jest.fn(async (path: string) => {
            maybeThrowNotInitialized();
            const files = routedFsByHost.get(currentRoutedHostId);
            files?.delete(path);
            if (path.endsWith(LEGACY_MOVE_SENTINEL_DIR)) {
              for (const file of [...(files?.keys() ?? [])]) {
                if (file.startsWith(`${path}/`)) {
                  files?.delete(file);
                }
              }
            }
          }),
        };
      }),
    }));
    getProjectBackupAssignmentStateMock = jest.fn(async () => ({
      backup_repo_id: "66666666-6666-4666-8666-666666666666",
      host_id: SOURCE_HOST_ID,
      region: "wnam",
    }));
    ensureProjectBackupRepoForRegionMock = jest.fn(async () => ({
      backup_repo_id: "77777777-7777-4777-8777-777777777777",
    }));
    resolveProjectBackupRepoAssignmentMock = jest.fn(async (opts: any) => ({
      backup_repo_id:
        opts?.backup_repo_id ??
        opts?.preferred_backup_repo_id ??
        "77777777-7777-4777-8777-777777777777",
    }));
    setProjectBackupRepoIdMock = jest.fn(async () => undefined);
    setProjectBackupRegionMock = jest.fn(async () => undefined);
    purgeProjectBackupsForRepoMock = jest.fn(async () => ({
      skipped: false,
      deleted_snapshots: 2,
      deleted_index_snapshots: 1,
    }));
    conatPublishMock = jest.fn(async () => ({ bytes: 0, count: 1 }));
    invalidateBackupConfigMock = jest.fn(async () => ({ ok: true }));
    getRoutedHostControlClientMock = jest.fn(async () => ({
      invalidateBackupConfig: invalidateBackupConfigMock,
    }));
  });

  it("accepts a timed-out destination start wait if the project is already running on the destination host", async () => {
    process.env.COCALC_MOVE_START_DEST_TIMEOUT_MS = "1";
    lroSummaryByOpId.set("44444444-4444-4444-8444-444444444444", {
      op_id: "44444444-4444-4444-8444-444444444444",
      scope_type: "project",
      scope_id: PROJECT_ID,
      status: "running",
      result: {},
    });
    try {
      const { moveProjectToHost } = await import("./move");
      await expect(
        moveProjectToHost({
          project_id: PROJECT_ID,
          dest_host_id: DEST_HOST_ID,
          account_id: "account-id",
          allow_offline: true,
        }),
      ).resolves.toBeUndefined();
    } finally {
      delete process.env.COCALC_MOVE_START_DEST_TIMEOUT_MS;
    }
    expect(savePlacementMock).toHaveBeenCalledTimes(1);
    expect(savePlacementMock).toHaveBeenCalledWith(PROJECT_ID, {
      host_id: DEST_HOST_ID,
    });
    expect(deleteProjectDataOnHostMock).not.toHaveBeenCalled();
  });

  it("writes the move sentinel before stopping an online provisioned source", async () => {
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
        sql.includes(
          "SELECT status, deleted, last_seen, name FROM project_hosts",
        )
      ) {
        return {
          rows: [
            {
              status: "running",
              deleted: null,
              last_seen: new Date(),
              name: SOURCE_HOST_NAME,
            },
          ],
        };
      }
      if (sql.includes("SELECT host_id, state->>'state' AS project_state")) {
        return { rows: [postTimeoutState] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { moveProjectToHost } = await import("./move");
    await expect(
      moveProjectToHost({
        project_id: PROJECT_ID,
        dest_host_id: DEST_HOST_ID,
        account_id: "account-id",
      }),
    ).resolves.toBeUndefined();

    expect(moveCallOrder.slice(0, 2)).toEqual([
      "write-sentinel",
      "stop-source",
    ]);
  });

  it("clears stale destination data before restoring a final backup", async () => {
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
        sql.includes(
          "SELECT status, deleted, last_seen, name FROM project_hosts",
        )
      ) {
        return {
          rows: [
            {
              status: "running",
              deleted: null,
              last_seen: new Date(),
              name: SOURCE_HOST_NAME,
            },
          ],
        };
      }
      if (sql.includes("SELECT host_id, state->>'state' AS project_state")) {
        return { rows: [postTimeoutState] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    waitForLroCompletionMock = jest.fn(async ({ op_id }: any) => {
      if (op_id === "55555555-5555-4555-8555-555555555555") {
        return {
          status: "succeeded",
          result: {
            id: "backup-1",
            time: new Date("2026-04-26T16:00:00.000Z"),
          },
        };
      }
      if (op_id === "44444444-4444-4444-8444-444444444444") {
        return { status: "succeeded" };
      }
      throw new Error(`unexpected op_id ${op_id}`);
    });
    createBackupLroMock = jest.fn(async () => {
      moveCallOrder.push("backup");
      return {
        op_id: "55555555-5555-4555-8555-555555555555",
        scope_type: "project",
        scope_id: PROJECT_ID,
      };
    });
    deleteProjectDataOnHostMock = jest.fn(async () => {
      moveCallOrder.push("clear-dest");
    });
    savePlacementMock = jest.fn(async (_project_id, { host_id }: any) => {
      moveCallOrder.push("placement");
      currentRoutedHostId = host_id;
    });
    startProjectLroMock = jest.fn(async () => {
      moveCallOrder.push("start-dest");
      return {
        op_id: "44444444-4444-4444-8444-444444444444",
        scope_type: "project",
        scope_id: PROJECT_ID,
      };
    });

    const { moveProjectToHost } = await import("./move");
    await expect(
      moveProjectToHost({
        project_id: PROJECT_ID,
        dest_host_id: DEST_HOST_ID,
        account_id: "account-id",
      }),
    ).resolves.toBeUndefined();

    expect(moveCallOrder.indexOf("backup")).toBeGreaterThanOrEqual(0);
    expect(moveCallOrder.indexOf("clear-dest")).toBeGreaterThan(
      moveCallOrder.indexOf("backup"),
    );
    expect(moveCallOrder.indexOf("clear-dest")).toBeLessThan(
      moveCallOrder.indexOf("placement"),
    );
    expect(moveCallOrder.indexOf("placement")).toBeLessThan(
      moveCallOrder.indexOf("start-dest"),
    );
  });

  it("retries when the source project file server is still initializing", async () => {
    fsNotInitializedFailuresByHost.set(SOURCE_HOST_ID, 2);
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
        sql.includes(
          "SELECT status, deleted, last_seen, name FROM project_hosts",
        )
      ) {
        return {
          rows: [
            {
              status: "running",
              deleted: null,
              last_seen: new Date(),
              name: SOURCE_HOST_NAME,
            },
          ],
        };
      }
      if (sql.includes("SELECT host_id, state->>'state' AS project_state")) {
        return { rows: [postTimeoutState] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const { moveProjectToHost } = await import("./move");
    await expect(
      moveProjectToHost({
        project_id: PROJECT_ID,
        dest_host_id: DEST_HOST_ID,
        account_id: "account-id",
        allow_offline: true,
      }),
    ).resolves.toBeUndefined();

    expect(createBackupLroMock).toHaveBeenCalledTimes(1);
    expect(savePlacementMock).toHaveBeenCalledWith(PROJECT_ID, {
      host_id: DEST_HOST_ID,
    });
    expect(hasMoveSentinel(routedFsByHost.get(SOURCE_HOST_ID))).toBe(false);
  });

  it("ignores stale legacy fixed-path move sentinel files", async () => {
    routedFsByHost.get(SOURCE_HOST_ID)?.set(
      LEGACY_MOVE_SENTINEL_PATH,
      `${JSON.stringify({
        version: 1,
        move_log_id: "old-move",
        project_id: PROJECT_ID,
      })}\n`,
    );
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
        sql.includes(
          "SELECT status, deleted, last_seen, name FROM project_hosts",
        )
      ) {
        return {
          rows: [
            {
              status: "running",
              deleted: null,
              last_seen: new Date(),
              name: SOURCE_HOST_NAME,
            },
          ],
        };
      }
      if (sql.includes("SELECT host_id, state->>'state' AS project_state")) {
        return { rows: [postTimeoutState] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { moveProjectToHost } = await import("./move");
    await expect(
      moveProjectToHost({
        project_id: PROJECT_ID,
        dest_host_id: DEST_HOST_ID,
        account_id: "account-id",
        allow_offline: true,
      }),
    ).resolves.toBeUndefined();

    expect(
      routedFsByHost.get(DEST_HOST_ID)?.has(LEGACY_MOVE_SENTINEL_PATH),
    ).toBe(false);
    expect(hasMoveSentinel(routedFsByHost.get(DEST_HOST_ID))).toBe(false);
  });

  it("reverts placement and cleans destination data if the destination never reaches running", async () => {
    process.env.COCALC_MOVE_START_DEST_TIMEOUT_MS = "1";
    postTimeoutState = {
      host_id: DEST_HOST_ID,
      project_state: "starting",
    };
    lroSummaryByOpId.set("44444444-4444-4444-8444-444444444444", {
      op_id: "44444444-4444-4444-8444-444444444444",
      scope_type: "project",
      scope_id: PROJECT_ID,
      status: "running",
      result: {},
    });
    try {
      const { moveProjectToHost } = await import("./move");
      await expect(
        moveProjectToHost({
          project_id: PROJECT_ID,
          dest_host_id: DEST_HOST_ID,
          account_id: "account-id",
          allow_offline: true,
        }),
      ).rejects.toThrow(/destination start wait failed/);
    } finally {
      delete process.env.COCALC_MOVE_START_DEST_TIMEOUT_MS;
    }

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
      can_place: true,
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

  it("rejects a move when destination host placement is denied", async () => {
    resolveHostConnectionMock = jest.fn(async ({ host_id }: any) => ({
      host_id,
      bay_id: "bay-0",
      region: "us-west1",
      can_place: false,
    }));
    const { moveProjectToHost } = await import("./move");
    await expect(
      moveProjectToHost({
        project_id: PROJECT_ID,
        dest_host_id: DEST_HOST_ID,
        account_id: "account-id",
        allow_offline: true,
      }),
    ).rejects.toThrow(/not allowed to place a project on that host/);
    expect(savePlacementMock).not.toHaveBeenCalled();
  });

  it("rejects a cross-region move unless backup-region cutover is requested", async () => {
    const consts = await import("@cocalc/util/consts");
    (consts.parseR2Region as jest.Mock).mockImplementation((value: string) => {
      if (value === "wnam" || value === "weur") return value;
      return null;
    });
    (consts.mapCloudRegionToR2Region as jest.Mock).mockImplementation(
      (value: string) => {
        if (value === "europe-west1") return "weur";
        return "wnam";
      },
    );
    resolveHostConnectionMock = jest.fn(async ({ host_id }: any) => ({
      host_id,
      bay_id: "bay-0",
      name: host_id === SOURCE_HOST_ID ? SOURCE_HOST_NAME : DEST_HOST_NAME,
      region: host_id === DEST_HOST_ID ? "europe-west1" : "us-west1",
      can_place: true,
    }));

    const { moveProjectToHost } = await import("./move");
    await expect(
      moveProjectToHost({
        project_id: PROJECT_ID,
        dest_host_id: DEST_HOST_ID,
        account_id: "account-id",
        allow_offline: true,
      }),
    ).rejects.toThrow(/project region wnam does not match host region weur/);
  });

  it("cuts over the backup region after a successful cross-region restore", async () => {
    const consts = await import("@cocalc/util/consts");
    (consts.parseR2Region as jest.Mock).mockImplementation((value: string) => {
      if (value === "wnam" || value === "weur") return value;
      return null;
    });
    (consts.mapCloudRegionToR2Region as jest.Mock).mockImplementation(
      (value: string) => {
        if (value === "europe-west1") return "weur";
        return "wnam";
      },
    );
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
        sql.includes(
          "SELECT status, deleted, last_seen, name FROM project_hosts",
        )
      ) {
        return {
          rows: [
            {
              status: "running",
              deleted: null,
              last_seen: new Date(),
              name: SOURCE_HOST_NAME,
            },
          ],
        };
      }
      if (sql.includes("SELECT host_id, state->>'state' AS project_state")) {
        return { rows: [postTimeoutState] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    resolveHostConnectionMock = jest.fn(async ({ host_id }: any) => ({
      host_id,
      bay_id: "bay-0",
      name: host_id === SOURCE_HOST_ID ? SOURCE_HOST_NAME : DEST_HOST_NAME,
      region: host_id === DEST_HOST_ID ? "europe-west1" : "us-west1",
      can_place: true,
    }));
    createBackupLroMock = jest
      .fn()
      .mockResolvedValueOnce({
        op_id: "backup-op-final",
        scope_type: "project",
        scope_id: PROJECT_ID,
      })
      .mockResolvedValueOnce({
        op_id: "backup-op-cutover",
        scope_type: "project",
        scope_id: PROJECT_ID,
      });
    lroSummaryByOpId.set("backup-op-final", {
      op_id: "backup-op-final",
      scope_type: "project",
      scope_id: PROJECT_ID,
      status: "succeeded",
      result: {
        id: "backup-for-backup-op-final",
        time: new Date("2026-04-26T16:00:00.000Z"),
      },
    });
    lroSummaryByOpId.set("backup-op-cutover", {
      op_id: "backup-op-cutover",
      scope_type: "project",
      scope_id: PROJECT_ID,
      status: "succeeded",
      result: {
        id: "backup-for-backup-op-cutover",
        time: new Date("2026-04-26T16:00:00.000Z"),
      },
    });
    startProjectLroMock = jest.fn(async () => ({
      op_id: "start-op-cross-region",
      scope_type: "project",
      scope_id: PROJECT_ID,
    }));
    waitForLroCompletionMock = jest.fn(async ({ op_id }: any) => {
      if (op_id === "backup-op-final" || op_id === "backup-op-cutover") {
        return {
          status: "succeeded",
          result: {
            id: `backup-for-${op_id}`,
            time: new Date("2026-04-26T16:00:00.000Z"),
          },
        };
      }
      if (op_id === "start-op-cross-region") {
        return { status: "succeeded" };
      }
      throw new Error(`unexpected op_id ${op_id}`);
    });

    const { moveProjectToHost } = await import("./move");
    await expect(
      moveProjectToHost(
        {
          project_id: PROJECT_ID,
          dest_host_id: DEST_HOST_ID,
          account_id: "account-id",
          backup_region_cutover: true,
        },
        { op_id: "move-op-cross-region" },
      ),
    ).resolves.toBeUndefined();

    expect(resolveProjectBackupRepoAssignmentMock).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      project_region: "weur",
    });
    expect(setProjectBackupRegionMock).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      region: "weur",
    });
    expect(getRoutedHostControlClientMock).toHaveBeenCalledWith({
      host_id: DEST_HOST_ID,
      timeout: expect.any(Number),
    });
    expect(invalidateBackupConfigMock).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
    });
    expect(purgeProjectBackupsForRepoMock).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      backup_repo_id: "66666666-6666-4666-8666-666666666666",
      region: "wnam",
    });
    expect(projectLogRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "project-move:move-op-cross-region:project_moved",
          event: expect.objectContaining({
            event: "project_moved",
            backup_region_cutover: true,
            source_region: "wnam",
            dest_region: "weur",
            previous_backup_repo_id: "66666666-6666-4666-8666-666666666666",
            next_backup_repo_id: "77777777-7777-4777-8777-777777777777",
          }),
        }),
      ]),
    );
  });

  it("extracts destination start failure details from progress summaries", async () => {
    const { __test__ } = await import("./move");
    expect(
      __test__.lroFailureReason({
        status: "failed",
        error: null,
        progress_summary: {
          phase: "failed",
          message: "project start failed",
          detail: {
            error: `backup backup-for-backup-op-final not found for project ${PROJECT_ID}`,
          },
        },
      } as any),
    ).toBe(
      `backup backup-for-backup-op-final not found for project ${PROJECT_ID}`,
    );
  });

  it("retries destination start when the restore backup is not visible yet", async () => {
    process.env.COCALC_MOVE_RESTORE_BACKUP_NOT_FOUND_RETRY_DELAY_MS = "1";
    try {
      const { __test__ } = await import("./move");
      const progress = jest.fn();
      let attempts = 0;
      await expect(
        __test__.retryOnceOnTransientMoveError({
          operation: "start-dest",
          progress,
          run: async () => {
            attempts += 1;
            if (attempts === 1) {
              throw new Error(
                `destination start failed: backup backup-for-backup-op-final not found for project ${PROJECT_ID}`,
              );
            }
            return "started";
          },
        }),
      ).resolves.toBe("started");
      expect(attempts).toBe(2);
      expect(progress).toHaveBeenCalledWith(
        expect.objectContaining({
          step: "start-dest",
          message: "backup is not visible on destination yet; retrying start",
          detail: expect.objectContaining({
            attempt: 1,
            max_retries: 3,
            retry_delay_ms: 1,
          }),
        }),
      );
    } finally {
      delete process.env.COCALC_MOVE_RESTORE_BACKUP_NOT_FOUND_RETRY_DELAY_MS;
    }
  });

  it("reverts backup-repo assignment and placement if destination-region backup cutover fails", async () => {
    const consts = await import("@cocalc/util/consts");
    (consts.parseR2Region as jest.Mock).mockImplementation((value: string) => {
      if (value === "wnam" || value === "weur") return value;
      return null;
    });
    (consts.mapCloudRegionToR2Region as jest.Mock).mockImplementation(
      (value: string) => {
        if (value === "europe-west1") return "weur";
        return "wnam";
      },
    );
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
        sql.includes(
          "SELECT status, deleted, last_seen, name FROM project_hosts",
        )
      ) {
        return {
          rows: [
            {
              status: "running",
              deleted: null,
              last_seen: new Date(),
              name: SOURCE_HOST_NAME,
            },
          ],
        };
      }
      if (sql.includes("SELECT host_id, state->>'state' AS project_state")) {
        return { rows: [{ host_id: DEST_HOST_ID, project_state: "running" }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    resolveHostConnectionMock = jest.fn(async ({ host_id }: any) => ({
      host_id,
      bay_id: "bay-0",
      name: host_id === SOURCE_HOST_ID ? SOURCE_HOST_NAME : DEST_HOST_NAME,
      region: host_id === DEST_HOST_ID ? "europe-west1" : "us-west1",
      can_place: true,
    }));
    createBackupLroMock = jest
      .fn()
      .mockResolvedValueOnce({
        op_id: "backup-op-final",
        scope_type: "project",
        scope_id: PROJECT_ID,
      })
      .mockResolvedValueOnce({
        op_id: "backup-op-cutover",
        scope_type: "project",
        scope_id: PROJECT_ID,
      });
    lroSummaryByOpId.set("backup-op-final", {
      op_id: "backup-op-final",
      scope_type: "project",
      scope_id: PROJECT_ID,
      status: "succeeded",
      result: {
        id: "backup-final",
        time: new Date("2026-04-26T16:00:00.000Z"),
      },
    });
    lroSummaryByOpId.set("backup-op-cutover", {
      op_id: "backup-op-cutover",
      scope_type: "project",
      scope_id: PROJECT_ID,
      status: "failed",
      error: "destination backup failed",
    });
    startProjectLroMock = jest.fn(async () => ({
      op_id: "start-op-cross-region",
      scope_type: "project",
      scope_id: PROJECT_ID,
    }));
    waitForLroCompletionMock = jest.fn(async ({ op_id }: any) => {
      if (op_id === "backup-op-final") {
        return {
          status: "succeeded",
          result: {
            id: "backup-final",
            time: new Date("2026-04-26T16:00:00.000Z"),
          },
        };
      }
      if (op_id === "backup-op-cutover") {
        return {
          status: "failed",
          error: "destination backup failed",
        };
      }
      if (op_id === "start-op-cross-region") {
        return { status: "succeeded" };
      }
      throw new Error(`unexpected op_id ${op_id}`);
    });

    const { moveProjectToHost } = await import("./move");
    await expect(
      moveProjectToHost({
        project_id: PROJECT_ID,
        dest_host_id: DEST_HOST_ID,
        account_id: "account-id",
        backup_region_cutover: true,
      }),
    ).rejects.toThrow(/destination backup failed/);

    expect(resolveProjectBackupRepoAssignmentMock).toHaveBeenNthCalledWith(1, {
      project_id: PROJECT_ID,
      project_region: "weur",
    });
    expect(resolveProjectBackupRepoAssignmentMock).toHaveBeenNthCalledWith(2, {
      project_id: PROJECT_ID,
      backup_repo_id: "66666666-6666-4666-8666-666666666666",
      project_region: "wnam",
    });
    expect(setProjectBackupRegionMock).not.toHaveBeenCalled();
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

  it("does not block move completion on old-region backup purge", async () => {
    const consts = await import("@cocalc/util/consts");
    (consts.parseR2Region as jest.Mock).mockImplementation((value: string) => {
      if (value === "wnam" || value === "weur") return value;
      return null;
    });
    (consts.mapCloudRegionToR2Region as jest.Mock).mockImplementation(
      (value: string) => {
        if (value === "europe-west1") return "weur";
        return "wnam";
      },
    );

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
        sql.includes(
          "SELECT status, deleted, last_seen, name FROM project_hosts",
        )
      ) {
        return {
          rows: [
            {
              status: "running",
              deleted: null,
              last_seen: new Date(),
              name: SOURCE_HOST_NAME,
            },
          ],
        };
      }
      if (sql.includes("SELECT host_id, state->>'state' AS project_state")) {
        return { rows: [postTimeoutState] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    resolveHostConnectionMock = jest.fn(async ({ host_id }: any) => ({
      host_id,
      bay_id: "bay-0",
      name: host_id === SOURCE_HOST_ID ? SOURCE_HOST_NAME : DEST_HOST_NAME,
      region: host_id === DEST_HOST_ID ? "europe-west1" : "us-west1",
      can_place: true,
    }));
    createBackupLroMock = jest
      .fn()
      .mockResolvedValueOnce({
        op_id: "backup-op-final",
        scope_type: "project",
        scope_id: PROJECT_ID,
      })
      .mockResolvedValueOnce({
        op_id: "backup-op-cutover",
        scope_type: "project",
        scope_id: PROJECT_ID,
      });
    lroSummaryByOpId.set("backup-op-final", {
      op_id: "backup-op-final",
      scope_type: "project",
      scope_id: PROJECT_ID,
      status: "succeeded",
      result: {
        id: "backup-for-backup-op-final",
        time: new Date("2026-04-26T16:00:00.000Z"),
      },
    });
    lroSummaryByOpId.set("backup-op-cutover", {
      op_id: "backup-op-cutover",
      scope_type: "project",
      scope_id: PROJECT_ID,
      status: "succeeded",
      result: {
        id: "backup-for-backup-op-cutover",
        time: new Date("2026-04-26T16:00:00.000Z"),
      },
    });
    startProjectLroMock = jest.fn(async () => ({
      op_id: "start-op-cross-region",
      scope_type: "project",
      scope_id: PROJECT_ID,
    }));
    waitForLroCompletionMock = jest.fn(async ({ op_id }: any) => {
      if (op_id === "backup-op-final" || op_id === "backup-op-cutover") {
        return {
          status: "succeeded",
          result: {
            id: `backup-for-${op_id}`,
            time: new Date("2026-04-26T16:00:00.000Z"),
          },
        };
      }
      if (op_id === "start-op-cross-region") {
        return { status: "succeeded" };
      }
      throw new Error(`unexpected op_id ${op_id}`);
    });
    purgeProjectBackupsForRepoMock = jest.fn(() => new Promise(() => {}));

    const { moveProjectToHost } = await import("./move");
    await expect(
      moveProjectToHost(
        {
          project_id: PROJECT_ID,
          dest_host_id: DEST_HOST_ID,
          account_id: "account-id",
          backup_region_cutover: true,
        },
        { op_id: "move-op-cross-region-async-purge" },
      ),
    ).resolves.toBeUndefined();

    expect(purgeProjectBackupsForRepoMock).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      backup_repo_id: "66666666-6666-4666-8666-666666666666",
      region: "wnam",
    });
    expect(projectLogRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "project-move:move-op-cross-region-async-purge:project_moved",
          event: expect.objectContaining({
            event: "project_moved",
            previous_backup_repo_id: "66666666-6666-4666-8666-666666666666",
            next_backup_repo_id: "77777777-7777-4777-8777-777777777777",
            old_backup_purge: expect.objectContaining({
              skipped: true,
              reason: "scheduled asynchronously",
            }),
          }),
        }),
      ]),
    );
  });

  it("fails but preserves the started destination when destination sentinel verification fails", async () => {
    process.env.COCALC_MOVE_SENTINEL_VERIFY_TIMEOUT_MS = "25";
    process.env.COCALC_MOVE_SENTINEL_VERIFY_RETRY_MS = "5";
    const consts = await import("@cocalc/util/consts");
    (consts.parseR2Region as jest.Mock).mockImplementation((value: string) => {
      if (value === "wnam" || value === "weur") return value;
      return null;
    });
    (consts.mapCloudRegionToR2Region as jest.Mock).mockImplementation(
      (value: string) => {
        if (value === "europe-west1") return "weur";
        return "wnam";
      },
    );
    routedFsByHost.set(SOURCE_HOST_ID, new Map<string, string>());
    routedFsByHost.set(DEST_HOST_ID, new Map<string, string>());
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
        sql.includes(
          "SELECT status, deleted, last_seen, name FROM project_hosts",
        )
      ) {
        return {
          rows: [
            {
              status: "running",
              deleted: null,
              last_seen: new Date(),
              name: SOURCE_HOST_NAME,
            },
          ],
        };
      }
      if (sql.includes("SELECT host_id, state->>'state' AS project_state")) {
        return { rows: [{ host_id: DEST_HOST_ID, project_state: "running" }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    resolveHostConnectionMock = jest.fn(async ({ host_id }: any) => ({
      host_id,
      bay_id: "bay-0",
      name: host_id === SOURCE_HOST_ID ? SOURCE_HOST_NAME : DEST_HOST_NAME,
      region: host_id === DEST_HOST_ID ? "europe-west1" : "us-west1",
      can_place: true,
    }));
    createBackupLroMock = jest.fn().mockResolvedValueOnce({
      op_id: "backup-op-final",
      scope_type: "project",
      scope_id: PROJECT_ID,
    });
    lroSummaryByOpId.set("backup-op-final", {
      op_id: "backup-op-final",
      scope_type: "project",
      scope_id: PROJECT_ID,
      status: "succeeded",
      result: {
        id: "backup-final",
        time: new Date("2026-04-26T16:00:00.000Z"),
      },
    });
    startProjectLroMock = jest.fn(async () => ({
      op_id: "start-op-cross-region",
      scope_type: "project",
      scope_id: PROJECT_ID,
    }));
    waitForLroCompletionMock = jest.fn(async ({ op_id }: any) => {
      if (op_id === "backup-op-final") {
        return {
          status: "succeeded",
          result: {
            id: "backup-final",
            time: new Date("2026-04-26T16:00:00.000Z"),
          },
        };
      }
      if (op_id === "start-op-cross-region") {
        return { status: "succeeded" };
      }
      throw new Error(`unexpected op_id ${op_id}`);
    });

    try {
      const { moveProjectToHost } = await import("./move");
      await expect(
        moveProjectToHost({
          project_id: PROJECT_ID,
          dest_host_id: DEST_HOST_ID,
          account_id: "account-id",
          backup_region_cutover: true,
        }),
      ).rejects.toThrow(/destination verification failed/);
    } finally {
      delete process.env.COCALC_MOVE_SENTINEL_VERIFY_TIMEOUT_MS;
      delete process.env.COCALC_MOVE_SENTINEL_VERIFY_RETRY_MS;
    }

    expect(savePlacementMock).toHaveBeenCalledTimes(1);
    expect(savePlacementMock).toHaveBeenNthCalledWith(1, PROJECT_ID, {
      host_id: DEST_HOST_ID,
    });
    expect(deleteProjectDataOnHostMock).toHaveBeenCalledTimes(1);
    expect(deleteProjectDataOnHostMock).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      host_id: DEST_HOST_ID,
    });
    expect(purgeProjectBackupsForRepoMock).not.toHaveBeenCalled();
    expect(hasMoveSentinel(routedFsByHost.get(DEST_HOST_ID))).toBe(false);
  });

  it("fails sentinel verification cleanly if the destination read hangs", async () => {
    process.env.COCALC_MOVE_SENTINEL_VERIFY_TIMEOUT_MS = "40";
    process.env.COCALC_MOVE_SENTINEL_VERIFY_RETRY_MS = "5";
    process.env.COCALC_MOVE_SENTINEL_IO_TIMEOUT_MS = "5";
    hangMoveSentinelReadOnDest = true;
    const consts = await import("@cocalc/util/consts");
    (consts.parseR2Region as jest.Mock).mockImplementation((value: string) => {
      if (value === "wnam" || value === "weur") return value;
      return null;
    });
    (consts.mapCloudRegionToR2Region as jest.Mock).mockImplementation(
      (value: string) => {
        if (value === "europe-west1") return "weur";
        return "wnam";
      },
    );
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
        sql.includes(
          "SELECT status, deleted, last_seen, name FROM project_hosts",
        )
      ) {
        return {
          rows: [
            {
              status: "running",
              deleted: null,
              last_seen: new Date(),
              name: SOURCE_HOST_NAME,
            },
          ],
        };
      }
      if (sql.includes("SELECT host_id, state->>'state' AS project_state")) {
        return { rows: [{ host_id: DEST_HOST_ID, project_state: "running" }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    resolveHostConnectionMock = jest.fn(async ({ host_id }: any) => ({
      host_id,
      bay_id: "bay-0",
      name: host_id === SOURCE_HOST_ID ? SOURCE_HOST_NAME : DEST_HOST_NAME,
      region: host_id === DEST_HOST_ID ? "europe-west1" : "us-west1",
      can_place: true,
    }));
    createBackupLroMock = jest.fn().mockResolvedValueOnce({
      op_id: "backup-op-final-hang",
      scope_type: "project",
      scope_id: PROJECT_ID,
    });
    lroSummaryByOpId.set("backup-op-final-hang", {
      op_id: "backup-op-final-hang",
      scope_type: "project",
      scope_id: PROJECT_ID,
      status: "succeeded",
      result: {
        id: "backup-final-hang",
        time: new Date("2026-04-26T16:00:00.000Z"),
      },
    });
    startProjectLroMock = jest.fn(async () => ({
      op_id: "start-op-cross-region",
      scope_type: "project",
      scope_id: PROJECT_ID,
    }));
    waitForLroCompletionMock = jest.fn(async ({ op_id }: any) => {
      if (op_id === "start-op-cross-region") {
        return { status: "succeeded" };
      }
      throw new Error(`unexpected op_id ${op_id}`);
    });

    try {
      const { moveProjectToHost } = await import("./move");
      await expect(
        moveProjectToHost({
          project_id: PROJECT_ID,
          dest_host_id: DEST_HOST_ID,
          account_id: "account-id",
          backup_region_cutover: true,
        }),
      ).rejects.toThrow(/destination verification failed/);
    } finally {
      delete process.env.COCALC_MOVE_SENTINEL_VERIFY_TIMEOUT_MS;
      delete process.env.COCALC_MOVE_SENTINEL_VERIFY_RETRY_MS;
      delete process.env.COCALC_MOVE_SENTINEL_IO_TIMEOUT_MS;
      hangMoveSentinelReadOnDest = false;
    }

    expect(savePlacementMock).toHaveBeenNthCalledWith(1, PROJECT_ID, {
      host_id: DEST_HOST_ID,
    });
    expect(savePlacementMock).toHaveBeenCalledTimes(1);
    expect(deleteProjectDataOnHostMock).toHaveBeenCalledTimes(1);
    expect(deleteProjectDataOnHostMock).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
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
        sql.includes(
          "SELECT status, deleted, last_seen, name FROM project_hosts",
        )
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
      name: DEST_HOST_NAME,
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
      account_id: "account-id",
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
        sql.includes(
          "SELECT status, deleted, last_seen, name FROM project_hosts",
        )
      ) {
        return {
          rows: [
            {
              status: "running",
              deleted: null,
              last_seen: new Date(),
              name: SOURCE_HOST_NAME,
            },
          ],
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
        sql.includes(
          "SELECT status, deleted, last_seen, name FROM project_hosts",
        )
      ) {
        return {
          rows: [
            {
              status: "running",
              deleted: null,
              last_seen: new Date(),
              name: SOURCE_HOST_NAME,
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    createBackupLroMock = jest
      .fn()
      .mockResolvedValueOnce({
        op_id: "backup-op-1",
        scope_type: "project",
        scope_id: PROJECT_ID,
      })
      .mockResolvedValueOnce({
        op_id: "backup-op-2",
        scope_type: "project",
        scope_id: PROJECT_ID,
      });
    lroSummaryByOpId.set("backup-op-1", {
      op_id: "backup-op-1",
      scope_type: "project",
      scope_id: PROJECT_ID,
      status: "failed",
      error: "Unexpected end of JSON input",
    });
    lroSummaryByOpId.set("backup-op-2", {
      op_id: "backup-op-2",
      scope_type: "project",
      scope_id: PROJECT_ID,
      status: "succeeded",
      result: {
        id: "backup-2",
        time: new Date("2026-04-26T16:00:00.000Z"),
      },
    });
    waitForLroCompletionMock = jest.fn(async ({ op_id }: any) => {
      if (op_id === "backup-op-1") {
        throw new Error("Unexpected end of JSON input");
      }
      if (op_id === "backup-op-2") {
        return {
          status: "succeeded",
          result: {
            id: "backup-2",
            time: new Date("2026-04-26T16:00:00.000Z"),
          },
        };
      }
      throw new Error("timeout waiting for lro completion");
    });

    const { moveProjectToHost } = await import("./move");
    await expect(
      moveProjectToHost({
        project_id: PROJECT_ID,
        dest_host_id: DEST_HOST_ID,
        account_id: "account-id",
        start_dest: false,
      }),
    ).resolves.toBeUndefined();

    expect(createBackupLroMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to db polling when child lro stream init hangs", async () => {
    process.env.COCALC_MOVE_CHILD_LRO_STREAM_OPEN_TIMEOUT_MS = "1";
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
        sql.includes(
          "SELECT status, deleted, last_seen, name FROM project_hosts",
        )
      ) {
        return {
          rows: [
            {
              status: "running",
              deleted: null,
              last_seen: new Date(),
              name: SOURCE_HOST_NAME,
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    getLroStreamMock = jest.fn(() => new Promise(() => {}));

    try {
      const { moveProjectToHost } = await import("./move");
      await expect(
        moveProjectToHost({
          project_id: PROJECT_ID,
          dest_host_id: DEST_HOST_ID,
          account_id: "account-id",
          allow_offline: true,
          start_dest: false,
        }),
      ).resolves.toBeUndefined();
    } finally {
      delete process.env.COCALC_MOVE_CHILD_LRO_STREAM_OPEN_TIMEOUT_MS;
    }

    expect(getLroMock).toHaveBeenCalledWith(
      "55555555-5555-4555-8555-555555555555",
    );
    expect(savePlacementMock).toHaveBeenCalledWith(PROJECT_ID, {
      host_id: DEST_HOST_ID,
    });
  });

  it("cancels the final backup child when the parent move is canceled", async () => {
    process.env.COCALC_MOVE_CHILD_LRO_POLL_INTERVAL_MS = "1";
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
        sql.includes(
          "SELECT status, deleted, last_seen, name FROM project_hosts",
        )
      ) {
        return {
          rows: [
            {
              status: "running",
              deleted: null,
              last_seen: new Date(),
              name: SOURCE_HOST_NAME,
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    let cancelNow = false;
    createBackupLroMock = jest.fn(async () => {
      cancelNow = true;
      return {
        op_id: "backup-op-cancel",
        scope_type: "project",
        scope_id: PROJECT_ID,
      };
    });
    getLroStreamMock = jest.fn(async () => {
      const stream = new EventEmitter() as EventEmitter & {
        getAll: () => any[];
        close: () => void;
      };
      stream.getAll = () => [];
      stream.close = () => {};
      return stream;
    });
    lroSummaryByOpId.set("backup-op-cancel", {
      op_id: "backup-op-cancel",
      scope_type: "project",
      scope_id: PROJECT_ID,
      status: "running",
    });

    try {
      const { moveProjectToHost } = await import("./move");
      await expect(
        moveProjectToHost(
          {
            project_id: PROJECT_ID,
            dest_host_id: DEST_HOST_ID,
            account_id: "account-id",
            start_dest: false,
          },
          {
            shouldCancel: async () => cancelNow,
          },
        ),
      ).rejects.toThrow(/move canceled \(backup\)/);
    } finally {
      delete process.env.COCALC_MOVE_CHILD_LRO_POLL_INTERVAL_MS;
    }

    expect(updateLroMock).toHaveBeenCalledWith({
      op_id: "backup-op-cancel",
      status: "canceled",
      error: "parent move canceled during backup",
    });
  });

  it("retries destination start once after a transient parse failure", async () => {
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
        sql.includes(
          "SELECT status, deleted, last_seen, name FROM project_hosts",
        )
      ) {
        return {
          rows: [
            {
              status: "running",
              deleted: null,
              last_seen: new Date(),
              name: SOURCE_HOST_NAME,
            },
          ],
        };
      }
      if (sql.includes("SELECT host_id, state->>'state' AS project_state")) {
        return { rows: [postTimeoutState] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    startProjectLroMock = jest
      .fn()
      .mockResolvedValueOnce({
        op_id: "start-op-1",
        scope_type: "project",
        scope_id: PROJECT_ID,
      })
      .mockResolvedValueOnce({
        op_id: "start-op-2",
        scope_type: "project",
        scope_id: PROJECT_ID,
      });
    lroSummaryByOpId.set("start-op-1", {
      op_id: "start-op-1",
      scope_type: "project",
      scope_id: PROJECT_ID,
      status: "failed",
      error: "Unexpected end of JSON input",
    });
    lroSummaryByOpId.set("start-op-2", {
      op_id: "start-op-2",
      scope_type: "project",
      scope_id: PROJECT_ID,
      status: "succeeded",
      result: {},
    });
    waitForLroCompletionMock = jest.fn(async ({ op_id }: any) => {
      if (op_id === "55555555-5555-4555-8555-555555555555") {
        return {
          status: "succeeded",
          result: {
            id: "backup-1",
            time: new Date("2026-04-26T16:00:00.000Z"),
          },
        };
      }
      if (op_id === "start-op-1") {
        return {
          status: "failed",
          error: "Unexpected end of JSON input",
        };
      }
      if (op_id === "start-op-2") {
        return { status: "succeeded" };
      }
      throw new Error(`unexpected op_id ${op_id}`);
    });

    const { moveProjectToHost } = await import("./move");
    await expect(
      moveProjectToHost({
        project_id: PROJECT_ID,
        dest_host_id: DEST_HOST_ID,
        account_id: "account-id",
      }),
    ).resolves.toBeUndefined();

    expect(startProjectLroMock).toHaveBeenCalledTimes(2);
  });

  it("fails promptly when destination start child is canceled in db polling", async () => {
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
        sql.includes(
          "SELECT status, deleted, last_seen, name FROM project_hosts",
        )
      ) {
        return {
          rows: [
            {
              status: "running",
              deleted: null,
              last_seen: new Date(),
              name: SOURCE_HOST_NAME,
            },
          ],
        };
      }
      if (sql.includes("SELECT host_id, state->>'state' AS project_state")) {
        return { rows: [{ host_id: DEST_HOST_ID, project_state: "opened" }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    startProjectLroMock = jest.fn(async () => ({
      op_id: "start-op-canceled",
      scope_type: "project",
      scope_id: PROJECT_ID,
    }));
    lroSummaryByOpId.set("start-op-canceled", {
      op_id: "start-op-canceled",
      scope_type: "project",
      scope_id: PROJECT_ID,
      status: "canceled",
      error: "orphaned project start operation",
    });
    waitForLroCompletionMock = jest.fn(async ({ op_id, getSummary }: any) => {
      if (op_id === "55555555-5555-4555-8555-555555555555") {
        return {
          status: "succeeded",
          result: {
            id: "backup-1",
            time: new Date("2026-04-26T16:00:00.000Z"),
          },
        };
      }
      if (op_id === "start-op-canceled") {
        expect(typeof getSummary).toBe("function");
        return await getSummary();
      }
      throw new Error(`unexpected op_id ${op_id}`);
    });

    const { moveProjectToHost } = await import("./move");
    await expect(
      moveProjectToHost({
        project_id: PROJECT_ID,
        dest_host_id: DEST_HOST_ID,
        account_id: "account-id",
      }),
    ).rejects.toThrow(
      /destination start failed: orphaned project start operation/,
    );
  });

  it("continues destination start wait via db polling after child lro stream closes", async () => {
    process.env.COCALC_MOVE_CHILD_LRO_POLL_INTERVAL_MS = "1";
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
        sql.includes(
          "SELECT status, deleted, last_seen, name FROM project_hosts",
        )
      ) {
        return {
          rows: [
            {
              status: "running",
              deleted: null,
              last_seen: new Date(),
              name: SOURCE_HOST_NAME,
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    startProjectLroMock = jest.fn(async () => ({
      op_id: "start-op-stream-closed",
      scope_type: "project",
      scope_id: PROJECT_ID,
    }));
    lroSummaryByOpId.set("start-op-stream-closed", {
      op_id: "start-op-stream-closed",
      scope_type: "project",
      scope_id: PROJECT_ID,
      status: "running",
    });
    let startPolls = 0;
    getLroMock = jest.fn(async (op_id: string) => {
      if (op_id === "start-op-stream-closed") {
        startPolls += 1;
        if (startPolls >= 2) {
          return {
            op_id,
            scope_type: "project",
            scope_id: PROJECT_ID,
            status: "succeeded",
            result: {},
          };
        }
      }
      return lroSummaryByOpId.get(op_id);
    });
    getLroStreamMock = jest.fn(async ({ op_id }: any) => {
      const stream = new EventEmitter() as EventEmitter & {
        getAll: () => any[];
        close: () => void;
      };
      stream.getAll = () => [];
      stream.close = () => {};
      if (op_id === "start-op-stream-closed") {
        setImmediate(() => stream.emit("closed"));
      }
      return stream;
    });

    try {
      const { moveProjectToHost } = await import("./move");
      await expect(
        moveProjectToHost({
          project_id: PROJECT_ID,
          dest_host_id: DEST_HOST_ID,
          account_id: "account-id",
        }),
      ).resolves.toBeUndefined();
    } finally {
      delete process.env.COCALC_MOVE_CHILD_LRO_POLL_INTERVAL_MS;
    }

    expect(startPolls).toBeGreaterThanOrEqual(2);
    expect(savePlacementMock).toHaveBeenCalledWith(PROJECT_ID, {
      host_id: DEST_HOST_ID,
    });
  });

  it("bubbles child backup and destination-start progress into the parent move progress", async () => {
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
        sql.includes(
          "SELECT status, deleted, last_seen, name FROM project_hosts",
        )
      ) {
        return {
          rows: [
            {
              status: "running",
              deleted: null,
              last_seen: new Date(),
              name: SOURCE_HOST_NAME,
            },
          ],
        };
      }
      if (sql.includes("SELECT host_id, state->>'state' AS project_state")) {
        return { rows: [postTimeoutState] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    createBackupLroMock = jest.fn(async () => ({
      op_id: "backup-op-progress",
      scope_type: "project",
      scope_id: PROJECT_ID,
    }));
    lroSummaryByOpId.set("backup-op-progress", {
      op_id: "backup-op-progress",
      scope_type: "project",
      scope_id: PROJECT_ID,
      status: "succeeded",
      result: {
        id: "backup-3",
        time: new Date("2026-04-26T16:00:00.000Z"),
      },
    });
    getLroStreamMock = jest.fn(async ({ op_id }: any) => {
      const stream = new EventEmitter() as EventEmitter & {
        getAll: () => any[];
        close: () => void;
      };
      const events =
        op_id === "backup-op-progress"
          ? [
              {
                type: "progress",
                ts: Date.now(),
                phase: "backup",
                message: "copying backup chunks",
                progress: 37,
                detail: { bytes_done: 37, bytes_total: 100, speed: 12 },
              },
              {
                type: "summary",
                summary: lroSummaryByOpId.get("backup-op-progress"),
              },
            ]
          : op_id === "start-op-progress"
            ? [
                {
                  type: "progress",
                  ts: Date.now(),
                  phase: "cache_rootfs",
                  message: "restoring RootFS image from rustic",
                  progress: 42,
                  detail: { bytes_done: 42, bytes_total: 100, speed: 8 },
                },
                {
                  type: "summary",
                  summary: {
                    op_id: "start-op-progress",
                    scope_type: "project",
                    scope_id: PROJECT_ID,
                    status: "succeeded",
                    result: {},
                  },
                },
              ]
            : [];
      stream.getAll = () => events;
      stream.close = () => {};
      return stream;
    });
    startProjectLroMock = jest.fn(async () => ({
      op_id: "start-op-progress",
      scope_type: "project",
      scope_id: PROJECT_ID,
    }));
    const progressUpdates: any[] = [];

    const { moveProjectToHost } = await import("./move");
    await expect(
      moveProjectToHost(
        {
          project_id: PROJECT_ID,
          dest_host_id: DEST_HOST_ID,
          account_id: "account-id",
        },
        {
          progress: (update) => {
            progressUpdates.push(update);
          },
        },
      ),
    ).resolves.toBeUndefined();

    expect(progressUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          step: "backup",
          progress: 37,
          detail: expect.objectContaining({
            child: expect.objectContaining({
              kind: "project-backup",
              op_id: "backup-op-progress",
              phase: "backup",
              message: "copying backup chunks",
              progress: 37,
              detail: expect.objectContaining({
                bytes_done: 37,
                bytes_total: 100,
              }),
            }),
          }),
        }),
        expect.objectContaining({
          step: "start-dest",
          progress: 42,
          detail: expect.objectContaining({
            dest_host_id: DEST_HOST_ID,
            child: expect.objectContaining({
              kind: "project-start",
              op_id: "start-op-progress",
              phase: "cache_rootfs",
              message: "restoring RootFS image from rustic",
              progress: 42,
              detail: expect.objectContaining({
                bytes_done: 42,
                bytes_total: 100,
              }),
            }),
          }),
        }),
      ]),
    );
    expect(startProjectLroMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: PROJECT_ID,
        restore_backup_id: "backup-3",
      }),
    );
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
        sql.includes(
          "SELECT status, deleted, last_seen, name FROM project_hosts",
        )
      ) {
        return {
          rows: [
            {
              status: "running",
              deleted: null,
              last_seen: new Date(),
              name: SOURCE_HOST_NAME,
            },
          ],
        };
      }
      if (sql.includes("SELECT host_id, state->>'state' AS project_state")) {
        return { rows: [postTimeoutState] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    waitForLroCompletionMock = jest.fn(async ({ op_id }: any) => {
      if (op_id === "55555555-5555-4555-8555-555555555555") {
        return {
          status: "succeeded",
          result: {
            id: "backup-1",
            time: new Date("2026-04-26T16:00:00.000Z"),
          },
        };
      }
      return {
        status: "succeeded",
      };
    });

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
            source_host_name: SOURCE_HOST_NAME,
            dest_host_id: DEST_HOST_ID,
            dest_host_name: DEST_HOST_NAME,
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
            source_host_name: SOURCE_HOST_NAME,
            dest_host_id: DEST_HOST_ID,
            dest_host_name: DEST_HOST_NAME,
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
    expect(getExplicitProjectRoutedClientMock).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      fresh: true,
    });
  });

  it("writes project log entries for move start and failure", async () => {
    process.env.COCALC_MOVE_START_DEST_TIMEOUT_MS = "1";
    lroSummaryByOpId.set("44444444-4444-4444-8444-444444444444", {
      op_id: "44444444-4444-4444-8444-444444444444",
      scope_type: "project",
      scope_id: PROJECT_ID,
      status: "running",
      result: {},
    });
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
        sql.includes(
          "SELECT status, deleted, last_seen, name FROM project_hosts",
        )
      ) {
        return {
          rows: [
            {
              status: "running",
              deleted: null,
              last_seen: new Date(),
              name: SOURCE_HOST_NAME,
            },
          ],
        };
      }
      if (sql.includes("SELECT host_id, state->>'state' AS project_state")) {
        return {
          rows: [{ host_id: DEST_HOST_ID, project_state: "starting" }],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    try {
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
    } finally {
      delete process.env.COCALC_MOVE_START_DEST_TIMEOUT_MS;
    }

    expect(projectLogRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "project-move:move-op-2:project_move_requested",
          event: expect.objectContaining({
            event: "project_move_requested",
            op_id: "move-op-2",
            source_host_id: SOURCE_HOST_ID,
            source_host_name: SOURCE_HOST_NAME,
            dest_host_id: DEST_HOST_ID,
            dest_host_name: DEST_HOST_NAME,
          }),
        }),
        expect.objectContaining({
          id: "project-move:move-op-2:project_move_failed",
          event: expect.objectContaining({
            event: "project_move_failed",
            op_id: "move-op-2",
            source_host_id: SOURCE_HOST_ID,
            source_host_name: SOURCE_HOST_NAME,
            dest_host_id: DEST_HOST_ID,
            dest_host_name: DEST_HOST_NAME,
            error: expect.stringContaining("destination start wait failed"),
          }),
        }),
      ]),
    );
  });
});
