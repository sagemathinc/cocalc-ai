export {};

let queryMock: jest.Mock;
let loadHostFromRegistryMock: jest.Mock;
let selectActiveHostMock: jest.Mock;
let deleteProjectDataOnHostMock: jest.Mock;
let savePlacementMock: jest.Mock;
let stopProjectOnHostMock: jest.Mock;
let startProjectLroMock: jest.Mock;
let waitForLroCompletionMock: jest.Mock;

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

jest.mock("@cocalc/conat/lro/client", () => ({
  waitForCompletion: (...args: any[]) => waitForLroCompletionMock(...args),
}));

jest.mock("./offline-move-confirmation", () => ({
  makeOfflineMoveConfirmationPayload: jest.fn(),
  offlineMoveConfirmationError: jest.fn((payload) => payload),
}));

jest.mock("@cocalc/server/conat/file-server-client", () => ({
  getProjectFileServerClient: jest.fn(),
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
    waitForLroCompletionMock = jest.fn(async () => {
      throw new Error("timeout waiting for lro completion");
    });
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

  it("rejects a move to a host in another bay", async () => {
    loadHostFromRegistryMock = jest.fn(async (host_id: string) => ({
      id: host_id,
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
    ).rejects.toThrow(
      `project ${PROJECT_ID} belongs to bay bay-0 but host ${DEST_HOST_ID} belongs to bay bay-9`,
    );

    expect(savePlacementMock).not.toHaveBeenCalled();
    expect(deleteProjectDataOnHostMock).not.toHaveBeenCalled();
  });

  it("treats a bay-mismatched current host as having no valid source host", async () => {
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
      exclude_host_id: undefined,
      bay_id: "bay-0",
    });
  });
});
