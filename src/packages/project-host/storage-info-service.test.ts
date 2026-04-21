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
    const dustMock = jest
      .fn()
      .mockResolvedValueOnce({
        stdout: Buffer.from(
          JSON.stringify({
            size: "120b",
            name: "/root",
            children: [{ size: "20b", name: "/root/cache" }],
          }),
        ),
        stderr: Buffer.alloc(0),
        code: 0,
      })
      .mockResolvedValueOnce({
        stdout: Buffer.from(
          JSON.stringify({
            size: "5b",
            name: "/scratch",
            children: [],
          }),
        ),
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
      allSnapshotUsage: jest.fn(async () => [{ exclusive: 8_000_000 }]),
    });
    fsClientMock.mockReturnValue({
      dust: dustMock,
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
    expect(overview.visible.map((bucket) => bucket.key)).toEqual([
      "home",
      "scratch",
    ]);
    expect(overview.counted[0]?.key).toBe("snapshots");
    expect(stream.publish).toHaveBeenCalledTimes(1);
    expect(fsClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ waitForInterest: false }),
    );
    expect(dustMock).toHaveBeenCalledWith("/root", {
      options: ["-j", "-x", "-T", "2", "-d", "1", "-s", "-o", "b", "-P"],
      timeout: 10_000,
    });
  });

  it("shares concurrent storage breakdown scans for the same path", async () => {
    let resolveScan!: (value: any) => void;
    const scan = new Promise((resolve) => {
      resolveScan = resolve;
    });
    const dustMock = jest.fn(() => scan);
    fsClientMock.mockReturnValue({ dust: dustMock });

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
    expect(dustMock).toHaveBeenCalledTimes(1);
    resolveScan({
      stdout: Buffer.from(
        JSON.stringify({
          size: "120b",
          name: "/root",
          children: [{ size: "20b", name: "/root/cache" }],
        }),
      ),
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
