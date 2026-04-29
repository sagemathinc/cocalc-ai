import type { ProjectStorageHistoryPoint } from "@cocalc/conat/project/storage-info";

const fileServerClientMock = jest.fn();
const fsClientMock = jest.fn();
const dstreamMock = jest.fn();

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

jest.mock("@cocalc/conat/files/fs", () => ({
  fsSubject: ({ project_id }: { project_id: string }) =>
    `fs.project-${project_id}`,
  fsClient: (...args: any[]) => fsClientMock(...args),
}));

jest.mock("@cocalc/conat/sync/dstream", () => ({
  dstream: (...args: any[]) => dstreamMock(...args),
}));

function makeStream(seed: ProjectStorageHistoryPoint[] = []) {
  const points = [...seed];
  return {
    getAll: jest.fn(() => [...points]),
    publish: jest.fn((point) => {
      points.push(point);
    }),
    save: jest.fn(async () => {}),
    config: jest.fn(async () => ({ allow_msg_ttl: true })),
    isClosed: jest.fn(() => false),
    close: jest.fn(),
  };
}

describe("project storage info service", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it("builds overview data and records a local history sample", async () => {
    const stream = makeStream();
    const duMock = jest
      .fn()
      .mockResolvedValueOnce({
        stdout: Buffer.from("120 /root/cache\n120 /root\n"),
        stderr: Buffer.alloc(0),
        code: 0,
      })
      .mockRejectedValueOnce(new Error("not found"));
    dstreamMock.mockResolvedValue(stream);
    fileServerClientMock.mockReturnValue({
      getQuota: jest.fn(async () => ({
        used: 50,
        size: 100,
        qgroupid: "0/2",
        scope: "subvolume",
      })),
    });
    fsClientMock.mockReturnValue({
      du: duMock,
    });

    const { handleProjectStorageOverviewRequest } =
      await import("./storage-info-service");
    const overview = await handleProjectStorageOverviewRequest.call(
      {
        subject: "project.11111111-1111-4111-8111-111111111111.storage-info.-",
      },
      { home: "/root" },
      {} as any,
    );

    expect(overview.quotas[0].used).toBe(50);
    expect(overview.live.bytes).toBe(120);
    expect(overview.retained.bytes).toBe(0);
    expect(overview.visible.map((bucket) => bucket.key)).toEqual(["home"]);
    expect(stream.publish).toHaveBeenCalledTimes(1);
    expect(fsClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ waitForInterest: false }),
    );
    expect(duMock).toHaveBeenCalledWith("/root", {
      options: ["-B", "1", "-x", "-d", "1"],
      timeout: 10_000,
    });
  });

  it("shares concurrent storage breakdown scans for the same path", async () => {
    let resolveScan!: (value: any) => void;
    const scan = new Promise((resolve) => {
      resolveScan = resolve;
    });
    const duMock = jest.fn(() => scan);
    fsClientMock.mockReturnValue({ du: duMock });

    const { handleProjectStorageBreakdownRequest } =
      await import("./storage-info-service");
    const subject =
      "project.11111111-1111-4111-8111-111111111111.storage-info.-";
    const first = handleProjectStorageBreakdownRequest.call(
      { subject },
      { path: "/root" },
      {} as any,
    );
    const second = handleProjectStorageBreakdownRequest.call(
      { subject },
      { path: "/root" },
      {} as any,
    );
    expect(duMock).toHaveBeenCalledTimes(1);
    resolveScan({
      stdout: Buffer.from("20 /root/cache\n120 /root\n"),
      stderr: Buffer.alloc(0),
      code: 0,
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      {
        path: "/root",
        bytes: 120,
        children: [{ bytes: 20, path: "cache" }],
        collected_at: expect.any(String),
      },
      {
        path: "/root",
        bytes: 120,
        children: [{ bytes: 20, path: "cache" }],
        collected_at: expect.any(String),
      },
    ]);
  });

  it("accepts du totals when stderr is only unreadable-directory warnings", async () => {
    const duMock = jest.fn().mockResolvedValue({
      stdout: Buffer.from("20 /root/cache\n120 /root\n"),
      stderr: Buffer.from(
        [
          "/usr/bin/du: cannot read directory '/root/cache/private': Permission denied",
          "/usr/bin/du: cannot access '/root/cache/work': Operation not permitted",
        ].join("\n"),
      ),
      code: 1,
    });
    fsClientMock.mockReturnValue({ du: duMock });

    const { handleProjectStorageBreakdownRequest } =
      await import("./storage-info-service");
    const breakdown = await handleProjectStorageBreakdownRequest.call(
      {
        subject: "project.11111111-1111-4111-8111-111111111111.storage-info.-",
      },
      { path: "/root" },
      {} as any,
    );

    expect(breakdown).toEqual({
      path: "/root",
      bytes: 120,
      children: [{ bytes: 20, path: "cache" }],
      collected_at: expect.any(String),
    });
  });

  it("rewrites host-path du output back to the requested sandbox path", async () => {
    const requestedPath = "/home/user/.local/share/cocalc/rootfs";
    const hostPath =
      "/mnt/cocalc/project-11111111-1111-4111-8111-111111111111/.local/share/cocalc/rootfs";
    const duMock = jest.fn().mockResolvedValue({
      stdout: Buffer.from(
        [`25 ${hostPath}/layer-a`, `125 ${hostPath}`].join("\n"),
      ),
      stderr: Buffer.alloc(0),
      code: 0,
    });
    fsClientMock.mockReturnValue({
      canonicalSyncFsPath: jest.fn(async () => hostPath),
      canonicalSyncIdentityPath: jest.fn(async () => requestedPath),
      du: duMock,
    });

    const { handleProjectStorageBreakdownRequest } =
      await import("./storage-info-service");
    const breakdown = await handleProjectStorageBreakdownRequest.call(
      {
        subject: "project.11111111-1111-4111-8111-111111111111.storage-info.-",
      },
      { path: requestedPath },
      {} as any,
    );

    expect(breakdown).toEqual({
      path: requestedPath,
      bytes: 125,
      children: [{ bytes: 25, path: "layer-a" }],
      collected_at: expect.any(String),
    });
  });

  it("returns direct quota and snapshot usage without scanning storage", async () => {
    fileServerClientMock.mockReturnValue({
      getQuota: jest.fn(async () => ({
        used: 123,
        size: 456,
        qgroupid: "0/9",
        scope: "subvolume",
        warning: "warn",
      })),
      allSnapshotUsage: jest.fn(async () => [
        { name: "a", exclusive: 11 },
        { name: "b", exclusive: 22 },
      ]),
    });

    const { handleProjectDiskQuotaRequest, handleProjectSnapshotUsageRequest } =
      await import("./storage-info-service");
    const subject =
      "project.11111111-1111-4111-8111-111111111111.storage-info.-";

    const quota = await handleProjectDiskQuotaRequest.call(
      { subject },
      undefined,
      {} as any,
    );
    const usage = await handleProjectSnapshotUsageRequest.call(
      { subject },
      undefined,
      {} as any,
    );

    expect(quota.used).toBe(123);
    expect(quota.size).toBe(456);
    expect(usage).toHaveLength(2);
    expect(usage[1].exclusive).toBe(22);
  });

  it("loads filtered local history from the project-host stream", async () => {
    const now = Date.now();
    const stream = makeStream([
      {
        collected_at: new Date(now - 65 * 60_000).toISOString(),
        quota_used_bytes: 10,
      },
      {
        collected_at: new Date(now - 10 * 60_000).toISOString(),
        quota_used_bytes: 20,
      },
      {
        collected_at: new Date(now - 5 * 60_000).toISOString(),
        quota_used_bytes: 30,
      },
    ]);
    dstreamMock.mockResolvedValue(stream);

    const { handleProjectStorageHistoryRequest } =
      await import("./storage-info-service");
    const history = await handleProjectStorageHistoryRequest.call(
      {
        subject: "project.11111111-1111-4111-8111-111111111111.storage-info.-",
      },
      { window_minutes: 60, max_points: 96 },
      {} as any,
    );

    expect(history.point_count).toBe(2);
    expect(history.points.map((point) => point.quota_used_bytes)).toEqual([
      20, 30,
    ]);
  });

  it("rejects invalid storage subjects", async () => {
    const { handleProjectStorageOverviewRequest } =
      await import("./storage-info-service");
    await expect(
      handleProjectStorageOverviewRequest.call(
        { subject: "project.not-a-uuid.storage-info.-" },
        {},
        {} as any,
      ),
    ).rejects.toThrow("invalid project storage subject");
  });
});
