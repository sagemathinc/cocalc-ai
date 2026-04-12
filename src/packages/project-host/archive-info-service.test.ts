const fileServerClientMock = jest.fn();

jest.mock("@cocalc/backend/logger", () => {
  const factory = () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  });
  return {
    __esModule: true,
    default: factory,
    getLogger: factory,
  };
});

jest.mock("./file-server", () => ({
  fileServerClient: (...args: any[]) => fileServerClientMock(...args),
}));

describe("project archive info service", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it("routes backup and snapshot read requests to the local file server", async () => {
    fileServerClientMock.mockReturnValue({
      getBackups: jest.fn(async () => [
        {
          id: "backup-1",
          time: new Date("2026-04-12T20:00:00.000Z"),
          summary: {},
        },
      ]),
      getBackupFiles: jest.fn(async () => [
        { name: "file.txt", isDir: false, mtime: 1, size: 2 },
      ]),
      findBackupFiles: jest.fn(async () => [
        {
          id: "backup-1",
          time: new Date("2026-04-12T20:00:00.000Z"),
          path: "file.txt",
          isDir: false,
          mtime: 1,
          size: 2,
        },
      ]),
      getBackupFileText: jest.fn(async () => ({
        content: "backup",
        truncated: false,
        size: 6,
        mtime: 1,
      })),
      getSnapshotFileText: jest.fn(async () => ({
        content: "snapshot",
        truncated: false,
        size: 8,
        mtime: 2,
      })),
    });

    const {
      handleProjectGetBackupsRequest,
      handleProjectGetBackupFilesRequest,
      handleProjectFindBackupFilesRequest,
      handleProjectGetBackupFileTextRequest,
      handleProjectGetSnapshotFileTextRequest,
    } = await import("./archive-info-service");
    const subject =
      "project.11111111-1111-4111-8111-111111111111.archive-info.-";

    await expect(
      handleProjectGetBackupsRequest.call(
        { subject },
        { indexed_only: true },
        {} as any,
      ),
    ).resolves.toHaveLength(1);
    await expect(
      handleProjectGetBackupFilesRequest.call(
        { subject },
        { id: "backup-1", path: "" },
        {} as any,
      ),
    ).resolves.toEqual([{ name: "file.txt", isDir: false, mtime: 1, size: 2 }]);
    await expect(
      handleProjectFindBackupFilesRequest.call(
        { subject },
        { glob: ["file.txt"] },
        {} as any,
      ),
    ).resolves.toHaveLength(1);
    await expect(
      handleProjectGetBackupFileTextRequest.call(
        { subject },
        { id: "backup-1", path: "file.txt" },
        {} as any,
      ),
    ).resolves.toMatchObject({ content: "backup" });
    await expect(
      handleProjectGetSnapshotFileTextRequest.call(
        { subject },
        { snapshot: "snapshot-1", path: "file.txt" },
        {} as any,
      ),
    ).resolves.toMatchObject({ content: "snapshot" });
  });

  it("rejects invalid archive subjects", async () => {
    const { handleProjectGetBackupsRequest } =
      await import("./archive-info-service");
    await expect(
      handleProjectGetBackupsRequest.call(
        { subject: "project.not-a-uuid.archive-info.-" },
        {},
        {} as any,
      ),
    ).rejects.toThrow("invalid project archive subject");
  });
});
