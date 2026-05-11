export {};

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const BACKUP_REPO_ID = "22222222-2222-4222-8222-222222222222";

const clientQueryMock = jest.fn();
const clientReleaseMock = jest.fn();
const poolQueryMock = jest.fn();
const connectMock = jest.fn(async () => ({
  query: clientQueryMock,
  release: clientReleaseMock,
}));
const userIsInGroupMock = jest.fn();
const getProjectMock = jest.fn();
const stopMock = jest.fn();
const loggerDebugMock = jest.fn();
const loggerWarnMock = jest.fn();
const appendProjectOutboxEventForProjectMock = jest.fn();
const assertProjectNotRehomingMock = jest.fn();
const publishProjectAccountFeedEventsBestEffortMock = jest.fn();
const releaseProjectBackupRepoAssignmentMock = jest.fn();
const resolveProjectBackupRepoAssignmentMock = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    connect: connectMock,
    query: poolQueryMock,
  })),
}));

jest.mock("@cocalc/server/accounts/is-in-group", () => ({
  __esModule: true,
  default: (...args: any[]) => userIsInGroupMock(...args),
}));

jest.mock("@cocalc/server/projects/control", () => ({
  getProject: (...args: any[]) => getProjectMock(...args),
}));

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  getLogger: jest.fn(() => ({
    debug: loggerDebugMock,
    warn: loggerWarnMock,
  })),
}));

jest.mock("@cocalc/database/postgres/project-events-outbox", () => ({
  appendProjectOutboxEventForProject: (...args: any[]) =>
    appendProjectOutboxEventForProjectMock(...args),
}));

jest.mock("@cocalc/database/postgres/project-rehome-fence", () => ({
  assertProjectNotRehoming: (...args: any[]) =>
    assertProjectNotRehomingMock(...args),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: jest.fn(() => "bay-1"),
}));

jest.mock("@cocalc/server/account/project-feed", () => ({
  publishProjectAccountFeedEventsBestEffort: (...args: any[]) =>
    publishProjectAccountFeedEventsBestEffortMock(...args),
}));

jest.mock("@cocalc/server/project-backup", () => ({
  releaseProjectBackupRepoAssignment: (...args: any[]) =>
    releaseProjectBackupRepoAssignmentMock(...args),
  resolveProjectBackupRepoAssignment: (...args: any[]) =>
    resolveProjectBackupRepoAssignmentMock(...args),
}));

import { setProjectDeleted } from "./delete";

describe("projects/delete", () => {
  let returnedBackupRepoId: string | null;
  let returnedRegion: string | null;
  let failCommit: boolean;

  beforeEach(() => {
    returnedBackupRepoId = BACKUP_REPO_ID;
    returnedRegion = "wnam";
    failCommit = false;

    jest.clearAllMocks();

    connectMock.mockResolvedValue({
      query: clientQueryMock,
      release: clientReleaseMock,
    });
    getProjectMock.mockReturnValue({
      stop: stopMock,
    });
    stopMock.mockResolvedValue(undefined);
    userIsInGroupMock.mockResolvedValue(false);
    appendProjectOutboxEventForProjectMock.mockResolvedValue(undefined);
    assertProjectNotRehomingMock.mockResolvedValue(undefined);
    publishProjectAccountFeedEventsBestEffortMock.mockResolvedValue(undefined);
    releaseProjectBackupRepoAssignmentMock.mockResolvedValue(undefined);
    resolveProjectBackupRepoAssignmentMock.mockResolvedValue(undefined);
    poolQueryMock.mockResolvedValue({ rows: [] });

    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql === "BEGIN" || sql === "ROLLBACK") {
        return { rows: [] };
      }
      if (sql === "COMMIT") {
        if (failCommit) {
          throw new Error("commit failed");
        }
        return { rows: [] };
      }
      if (
        sql ===
        "UPDATE projects SET deleted=$2 WHERE project_id=$1 RETURNING backup_repo_id, region"
      ) {
        return {
          rowCount: 1,
          rows: [
            {
              backup_repo_id: returnedBackupRepoId,
              region: returnedRegion,
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
  });

  it("releases the shard assignment on soft delete", async () => {
    await setProjectDeleted({
      project_id: PROJECT_ID,
      deleted: true,
      skipPermissionCheck: true,
    });

    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(assertProjectNotRehomingMock).toHaveBeenCalledWith({
      db: expect.anything(),
      project_id: PROJECT_ID,
      action: "delete project",
    });
    expect(releaseProjectBackupRepoAssignmentMock).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
    });
    expect(resolveProjectBackupRepoAssignmentMock).not.toHaveBeenCalled();
    expect(appendProjectOutboxEventForProjectMock).toHaveBeenCalledWith({
      db: expect.anything(),
      event_type: "project.deleted",
      project_id: PROJECT_ID,
      default_bay_id: "bay-1",
    });
    expect(publishProjectAccountFeedEventsBestEffortMock).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      default_bay_id: "bay-1",
    });
  });

  it("restores the shard assignment on undelete using the cached repo id", async () => {
    returnedRegion = null;

    await setProjectDeleted({
      project_id: PROJECT_ID,
      deleted: false,
      skipPermissionCheck: true,
    });

    expect(stopMock).not.toHaveBeenCalled();
    expect(releaseProjectBackupRepoAssignmentMock).not.toHaveBeenCalled();
    expect(resolveProjectBackupRepoAssignmentMock).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      project_region: null,
      backup_repo_id: BACKUP_REPO_ID,
    });
    expect(appendProjectOutboxEventForProjectMock).toHaveBeenCalledWith({
      db: expect.anything(),
      event_type: "project.summary_changed",
      project_id: PROJECT_ID,
      default_bay_id: "bay-1",
    });
  });

  it("does not touch the shard assignment if delete rollback happens before commit", async () => {
    failCommit = true;

    await expect(
      setProjectDeleted({
        project_id: PROJECT_ID,
        deleted: true,
        skipPermissionCheck: true,
      }),
    ).rejects.toThrow("commit failed");

    expect(releaseProjectBackupRepoAssignmentMock).not.toHaveBeenCalled();
    expect(resolveProjectBackupRepoAssignmentMock).not.toHaveBeenCalled();
    expect(
      publishProjectAccountFeedEventsBestEffortMock,
    ).not.toHaveBeenCalled();
  });

  it("does not fail soft delete if post-commit shard assignment release fails", async () => {
    releaseProjectBackupRepoAssignmentMock.mockRejectedValueOnce(
      new Error("release timeout"),
    );

    await setProjectDeleted({
      project_id: PROJECT_ID,
      deleted: true,
      skipPermissionCheck: true,
    });

    expect(releaseProjectBackupRepoAssignmentMock).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
    });
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "failed to release backup shard assignment after project delete",
      {
        project_id: PROJECT_ID,
        err: "Error: release timeout",
      },
    );
    expect(publishProjectAccountFeedEventsBestEffortMock).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      default_bay_id: "bay-1",
    });
  });
});
