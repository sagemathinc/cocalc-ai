export {};

let requireAuthMock: jest.Mock;
let assertPermissionMock: jest.Mock;
let snapshotLimitMock: jest.Mock;
let backupLimitMock: jest.Mock;
let publishMock: jest.Mock;
let capabilityMock: jest.Mock;
let clientQueryMock: jest.Mock;
let releaseMock: jest.Mock;
let storedValue: any;

jest.mock("./project-dangerous-auth", () => ({
  __esModule: true,
  requireDangerousProjectMutationAuth: (...args: any[]) =>
    requireAuthMock(...args),
}));

jest.mock("@cocalc/server/projects/destructive-storage-actions", () => ({
  __esModule: true,
  assertCanPerformDestructiveStorageAction: (...args: any[]) =>
    assertPermissionMock(...args),
}));

jest.mock("@cocalc/server/membership/project-limits", () => ({
  __esModule: true,
  getProjectSnapshotLimit: (...args: any[]) => snapshotLimitMock(...args),
  getProjectBackupLimit: (...args: any[]) => backupLimitMock(...args),
}));

jest.mock("@cocalc/server/account/project-detail-feed", () => ({
  __esModule: true,
  publishProjectDetailInvalidationBestEffort: (...args: any[]) =>
    publishMock(...args),
}));

jest.mock("@cocalc/server/launchpad/project-runtime", () => ({
  __esModule: true,
  assertProjectRuntimeCapability: (...args: any[]) => capabilityMock(...args),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({
    connect: async () => ({
      query: (...args: any[]) => clientQueryMock(...args),
      release: (...args: any[]) => releaseMock(...args),
    }),
  }),
}));

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

describe("project schedule setters", () => {
  beforeEach(() => {
    jest.resetModules();
    storedValue = null;
    requireAuthMock = jest.fn(async () => undefined);
    assertPermissionMock = jest.fn(async () => undefined);
    snapshotLimitMock = jest.fn(async () => 100);
    backupLimitMock = jest.fn(async () => 10);
    publishMock = jest.fn(async () => undefined);
    capabilityMock = jest.fn();
    releaseMock = jest.fn();
    clientQueryMock = jest.fn(async (sql: string, params?: any[]) => {
      if (sql.startsWith("SELECT")) {
        return { rows: [{ schedule: storedValue }] };
      }
      if (sql.startsWith("UPDATE")) {
        return { rows: [{ schedule: JSON.parse(params![1]) }] };
      }
      return { rows: [] };
    });
  });

  it("disables backups with fresh auth and the storage-history permission", async () => {
    storedValue = { daily: 2, weekly: 3, monthly: 4, frequent: 0 };
    const { setProjectBackupSchedule } = await import("./project-schedules");
    const result = await setProjectBackupSchedule({
      account_id: ACCOUNT_ID,
      browser_id: "browser-1",
      session_hash: "session-1",
      project_id: PROJECT_ID,
      schedule: { disabled: true },
    });
    expect(result).toEqual({
      frequent: 0,
      daily: 2,
      weekly: 3,
      monthly: 4,
      disabled: true,
    });
    expect(requireAuthMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      browser_id: "browser-1",
      session_hash: "session-1",
    });
    expect(assertPermissionMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      action: "change backup schedules",
    });
    expect(capabilityMock).toHaveBeenCalledWith("backups");
    const update = clientQueryMock.mock.calls.find(([sql]) =>
      sql.startsWith("UPDATE"),
    );
    expect(update[0]).toContain("SET backups = $2::JSONB");
    expect(clientQueryMock.mock.calls.map(([sql]) => sql)).toContain("COMMIT");
    expect(publishMock).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      fields: ["backups"],
    });
    expect(releaseMock).toHaveBeenCalled();
  });

  it("refuses without fresh auth before reading or writing anything", async () => {
    requireAuthMock.mockRejectedValue(new Error("fresh auth required"));
    const { setProjectSnapshotSchedule } = await import("./project-schedules");
    await expect(
      setProjectSnapshotSchedule({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        schedule: { disabled: true },
      }),
    ).rejects.toThrow("fresh auth required");
    expect(assertPermissionMock).not.toHaveBeenCalled();
    expect(clientQueryMock).not.toHaveBeenCalled();
  });

  it("refuses a collaborator the dialog would refuse", async () => {
    assertPermissionMock.mockRejectedValue(
      new Error(
        "Only project owners can change snapshot schedules unless the owner allows collaborators to manage storage history.",
      ),
    );
    const { setProjectSnapshotSchedule } = await import("./project-schedules");
    await expect(
      setProjectSnapshotSchedule({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        schedule: { disabled: true },
      }),
    ).rejects.toThrow("Only project owners can change snapshot schedules");
    expect(clientQueryMock).not.toHaveBeenCalled();
  });

  it("refuses a schedule over the project limit and rolls back", async () => {
    backupLimitMock.mockResolvedValue(5);
    const { setProjectBackupSchedule } = await import("./project-schedules");
    await expect(
      setProjectBackupSchedule({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        schedule: { daily: 3, weekly: 3 },
      }),
    ).rejects.toThrow("automatic backups total 10 exceeds project limit 5");
    const sqls = clientQueryMock.mock.calls.map(([sql]) => sql);
    expect(sqls).toContain("ROLLBACK");
    expect(sqls.some((sql) => sql.startsWith("UPDATE"))).toBe(false);
  });

  it("ignores a caller-supplied kind", async () => {
    const { setProjectSnapshotSchedule } = await import("./project-schedules");
    await setProjectSnapshotSchedule({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      schedule: { daily: 1 },
      kind: "backups",
    } as any);
    const update = clientQueryMock.mock.calls.find(([sql]) =>
      sql.startsWith("UPDATE"),
    );
    expect(update[0]).toContain("SET snapshots = $2::JSONB");
  });

  it("reports a missing project", async () => {
    clientQueryMock.mockImplementation(async (sql: string) =>
      sql.startsWith("SELECT") ? { rows: [] } : { rows: [] },
    );
    const { setProjectSnapshotSchedule } = await import("./project-schedules");
    await expect(
      setProjectSnapshotSchedule({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        schedule: { disabled: true },
      }),
    ).rejects.toThrow("project not found");
  });
});

describe("mergeProjectScheduleUpdate", () => {
  it("fills defaults, keeps stored counts, applies the update", async () => {
    const { mergeProjectScheduleUpdate } = await import("./project-schedules");
    expect(
      mergeProjectScheduleUpdate({
        kind: "snapshots",
        stored: { daily: 3, disabled: true, junk: 1 } as any,
        update: { weekly: 1 },
      }),
    ).toEqual({
      frequent: 4,
      daily: 3,
      weekly: 1,
      monthly: 2,
      disabled: true,
    });
    expect(
      mergeProjectScheduleUpdate({
        kind: "snapshots",
        stored: { disabled: true },
        update: { disabled: false },
      }).disabled,
    ).toBe(false);
  });

  it("keeps backups without a frequent tier", async () => {
    const { mergeProjectScheduleUpdate } = await import("./project-schedules");
    expect(
      mergeProjectScheduleUpdate({
        kind: "backups",
        stored: { frequent: 9 } as any,
        update: {},
      }).frequent,
    ).toBe(0);
    expect(() =>
      mergeProjectScheduleUpdate({
        kind: "backups",
        stored: null,
        update: { frequent: 2 },
      }),
    ).toThrow("backups have no frequent tier");
  });

  it.each([
    [{ daily: -1 }, "daily must be a non-negative integer"],
    [{ weekly: 1.5 }, "weekly must be a non-negative integer"],
    [{ monthly: "3" }, "monthly must be a non-negative integer"],
    [{ disabled: "yes" }, "disabled must be a boolean"],
    [{ hourly: 1 }, "unknown snapshot schedule field: hourly"],
  ])("refuses %j", async (update, message) => {
    const { mergeProjectScheduleUpdate } = await import("./project-schedules");
    expect(() =>
      mergeProjectScheduleUpdate({
        kind: "snapshots",
        stored: null,
        update: update as any,
      }),
    ).toThrow(message);
  });

  it("counts only enabled schedules against the limit", async () => {
    const { projectScheduleTotal } = await import("./project-schedules");
    const schedule = { frequent: 4, daily: 1, weekly: 2, monthly: 3 };
    expect(projectScheduleTotal("snapshots", schedule)).toBe(10);
    expect(projectScheduleTotal("backups", schedule)).toBe(6);
    expect(
      projectScheduleTotal("snapshots", { ...schedule, disabled: true }),
    ).toBe(0);
  });
});
