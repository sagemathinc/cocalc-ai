const dkvMock = jest.fn();
const dstreamMock = jest.fn();
const getRowMock = jest.fn();

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

jest.mock("@cocalc/conat/sync/dkv", () => ({
  dkv: (...args: any[]) => dkvMock(...args),
}));

jest.mock("@cocalc/conat/sync/dstream", () => ({
  dstream: (...args: any[]) => dstreamMock(...args),
}));

jest.mock("@cocalc/lite/hub/sqlite/database", () => ({
  getRow: (...args: any[]) => getRowMock(...args),
}));

function makeStore(seed: Record<string, any> = {}) {
  const rows = { ...seed };
  return {
    get: jest.fn((key: string) => rows[key]),
    getAll: jest.fn(() => ({ ...rows })),
    set: jest.fn((key: string, value: any) => {
      rows[key] = value;
    }),
    delete: jest.fn((key: string) => {
      delete rows[key];
    }),
    isClosed: jest.fn(() => false),
    close: jest.fn(),
  };
}

function makeStream(seed: any[] = []) {
  const rows = [...seed];
  return {
    getAll: jest.fn(() => [...rows]),
    publish: jest.fn((value: any) => {
      rows.push(value);
    }),
    times: jest.fn(() => rows.map((row) => new Date(row.time ?? Date.now()))),
    config: jest.fn(async () => ({ allow_msg_ttl: true })),
    isClosed: jest.fn(() => false),
    close: jest.fn(),
  };
}

describe("project document activity service", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    getRowMock.mockReturnValue({
      users: {
        "00000000-0000-4000-8000-000000000001": { group: "owner" },
      },
    });
  });

  it("records and lists recent document activity", async () => {
    const store = makeStore();
    const events = makeStream();
    dkvMock.mockResolvedValue(store);
    dstreamMock.mockResolvedValue(events);

    const { handleMarkFileRequest, handleListRecentRequest } =
      await import("./document-activity-service");
    const subject =
      "services.account-00000000-0000-4000-8000-000000000001._.11111111-1111-4111-8111-111111111111._.document-activity";

    await handleMarkFileRequest.call(
      { subject },
      { path: "a.txt", action: "open" },
      {} as any,
    );

    const rows = await handleListRecentRequest.call(
      { subject },
      { limit: 10, max_age_s: 3600 },
      {} as any,
    );

    expect(store.set).toHaveBeenCalled();
    expect(events.publish).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].project_id).toBe("11111111-1111-4111-8111-111111111111");
    expect(rows[0].path).toBe("a.txt");
    expect(rows[0].recent_account_ids).toEqual([
      "00000000-0000-4000-8000-000000000001",
    ]);
  });

  it("returns access times from the local activity stream", async () => {
    const store = makeStore();
    const events = makeStream([
      {
        time: "2026-04-12T10:00:00.000Z",
        account_id: "00000000-0000-4000-8000-000000000002",
        path: "a.txt",
        action: "open",
      },
      {
        time: "2026-04-12T11:00:00.000Z",
        account_id: "00000000-0000-4000-8000-000000000001",
        path: "a.txt",
        action: "edit",
      },
      {
        time: "2026-04-12T12:00:00.000Z",
        account_id: "00000000-0000-4000-8000-000000000001",
        path: "a.txt",
        action: "open",
      },
    ]);
    dkvMock.mockResolvedValue(store);
    dstreamMock.mockResolvedValue(events);

    const { handleGetFileUseTimesRequest } =
      await import("./document-activity-service");
    const subject =
      "services.account-00000000-0000-4000-8000-000000000001._.11111111-1111-4111-8111-111111111111._.document-activity";

    const resp = await handleGetFileUseTimesRequest.call(
      { subject },
      {
        path: "a.txt",
        target_account_id: "00000000-0000-4000-8000-000000000001",
        access_times: true,
        edit_times: false,
        limit: 10,
      },
      {} as any,
    );

    expect(resp.access_times).toEqual([
      Date.parse("2026-04-12T12:00:00.000Z"),
      Date.parse("2026-04-12T11:00:00.000Z"),
    ]);
  });

  it("rejects invalid document activity subjects", async () => {
    const store = makeStore();
    const events = makeStream();
    dkvMock.mockResolvedValue(store);
    dstreamMock.mockResolvedValue(events);

    const { handleMarkFileRequest } =
      await import("./document-activity-service");
    await expect(
      handleMarkFileRequest.call(
        { subject: "services.account-not-a-uuid._.bad._.document-activity" },
        { path: "a.txt", action: "open" },
        {} as any,
      ),
    ).rejects.toThrow("invalid project document activity subject");
  });
});
