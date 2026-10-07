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

  it("filters recent activity by wildcard filename search", async () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    const store = makeStore({
      "notes/a.txt": {
        path: "notes/a.txt",
        last_accessed: recent,
        recent_accounts: {
          "00000000-0000-4000-8000-000000000001": recent,
        },
      },
      "notes/b.ipynb": {
        path: "notes/b.ipynb",
        last_accessed: recent,
        recent_accounts: {
          "00000000-0000-4000-8000-000000000001": recent,
        },
      },
    });
    const events = makeStream();
    dkvMock.mockResolvedValue(store);
    dstreamMock.mockResolvedValue(events);

    const { handleListRecentRequest } =
      await import("./document-activity-service");
    const subject =
      "services.account-00000000-0000-4000-8000-000000000001._.11111111-1111-4111-8111-111111111111._.document-activity";

    const rows = await handleListRecentRequest.call(
      { subject },
      { limit: 10, max_age_s: 90 * 24 * 60 * 60, search: "%.ipynb" },
      {} as any,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].path).toBe("notes/b.ipynb");
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

  it("binds the local conat client when registering the service", async () => {
    const store = makeStore();
    const events = makeStream();
    dkvMock.mockResolvedValue(store);
    dstreamMock.mockResolvedValue(events);

    const registered: Record<string, any> = {};
    const client = {
      service: jest.fn(async (_subject: string, api: Record<string, any>) => {
        Object.assign(registered, api);
        return { close: jest.fn() };
      }),
    } as any;

    const { initProjectDocumentActivityService } =
      await import("./document-activity-service");
    await initProjectDocumentActivityService(client);

    await registered.markFile.call(
      {
        subject:
          "services.account-00000000-0000-4000-8000-000000000001._.11111111-1111-4111-8111-111111111111._.document-activity",
      },
      { path: "a.txt", action: "open" },
    );

    expect(dkvMock).toHaveBeenCalledWith(
      expect.objectContaining({
        client,
        project_id: "11111111-1111-4111-8111-111111111111",
      }),
    );
  });
});

describe("notebook usage export", () => {
  const teacher = "00000000-0000-4000-8000-000000000001";
  const student = "00000000-0000-4000-8000-000000000002";
  const project_id = "11111111-1111-4111-8111-111111111111";
  const path = "lectures/example.ipynb";
  const patchName = "patchflow/lectures/.example.ipynb.sage-jupyter2";
  const editTime = "2026-10-01T10:00:00.000Z";
  let streams: Map<string, ReturnType<typeof makeStream>>;

  beforeEach(() => {
    jest.resetModules();
    jest.resetAllMocks();
    streams = new Map();
    dkvMock.mockResolvedValue(makeStore());
    dstreamMock.mockImplementation(async ({ project_id, name }) => {
      const key = `${project_id}:${name}`;
      if (!streams.has(key)) streams.set(key, makeStream());
      return streams.get(key);
    });
    getRowMock.mockReturnValue({
      users: {
        [teacher]: { group: "owner" },
        [student]: { group: "collaborator" },
      },
    });
  });

  async function service() {
    const api = await import("@cocalc/conat/project/document-activity");
    const { initProjectDocumentActivityService } =
      await import("./document-activity-service");
    let handlers: Record<string, any>;
    const client = {
      service: jest.fn(async (_subject, methods) => {
        handlers = methods;
        return { close: jest.fn() };
      }),
      request: jest.fn(async (subject, [name, args]) => ({
        data: await handlers[name].apply({ subject }, args),
      })),
    } as any;
    await initProjectDocumentActivityService(client);
    return { ...api, client };
  }

  it("records visible-path access and exports the notebook sync document's edits", async () => {
    const { client, markFile, getFileUseTimes } = await service();
    streams.set(`${project_id}:${patchName}`, makeStream([{ time: editTime }]));
    await markFile({
      client,
      account_id: student,
      project_id,
      path,
      action: "open",
    });
    await markFile({
      client,
      account_id: student,
      project_id,
      path,
      action: "edit",
    });
    await markFile({
      client,
      account_id: teacher,
      project_id,
      path,
      action: "open",
    });
    await markFile({
      client,
      account_id: student,
      project_id,
      path: "other.ipynb",
      action: "open",
    });
    await markFile({
      client,
      account_id: student,
      project_id: "22222222-2222-4222-8222-222222222222",
      path,
      action: "open",
    });
    const result = await getFileUseTimes({
      client,
      account_id: teacher,
      project_id,
      path,
      target_account_id: student,
      access_times: true,
      edit_times: true,
    });
    expect(result.target_account_id).toBe(student);
    expect(result.access_times).toHaveLength(2);
    expect(result.access_times!.every(Number.isFinite)).toBe(true);
    expect(result.edit_times).toEqual([Date.parse(editTime)]);
    expect(dstreamMock).toHaveBeenCalledWith(
      expect.objectContaining({ client, project_id, name: patchName }),
    );
    expect(
      streams.get(`${project_id}:${patchName}`)!.close,
    ).toHaveBeenCalledTimes(1);
    expect(
      streams.get(`${project_id}:project-document-activity-events`)!.close,
    ).not.toHaveBeenCalled();
    const limited = await getFileUseTimes({
      client,
      account_id: teacher,
      project_id,
      path,
      target_account_id: student,
      access_times: true,
      edit_times: false,
      limit: 1,
    });
    expect(limited.access_times).toHaveLength(1);
    expect(limited.edit_times).toBeUndefined();
  });

  it.each([
    ["example.ipynb", "patchflow/.example.ipynb.sage-jupyter2"],
    ["lectures/.example.ipynb.sage-jupyter2", patchName],
    ["notes.txt", "patchflow/notes.txt"],
  ])(
    "resolves edit storage for %s without double wrapping",
    async (path, name) => {
      const { client, getFileUseTimes } = await service();
      streams.set(`${project_id}:${name}`, makeStream([{ time: editTime }]));
      const result = await getFileUseTimes({
        client,
        account_id: teacher,
        project_id,
        path,
        access_times: false,
        edit_times: true,
      });
      expect(result.edit_times).toEqual([Date.parse(editTime)]);
      expect(result.access_times).toBeUndefined();
      // The home-relative and absolute spellings are both read.
      expect(dstreamMock).toHaveBeenCalledTimes(2);
      expect(dstreamMock).toHaveBeenCalledWith(
        expect.objectContaining({ name }),
      );
    },
  );

  it("matches browser-recorded absolute paths when asked with relative ones", async () => {
    // Browsers record activity and open notebooks as /home/user/...; the
    // course export asks with home-relative paths (support #20952/#20955).
    const { client, markFile, getFileUseTimes } = await service();
    const absolute = `/home/user/${path}`;
    streams.set(
      `${project_id}:patchflow//home/user/lectures/.example.ipynb.sage-jupyter2`,
      makeStream([{ time: editTime }]),
    );
    await markFile({
      client,
      account_id: student,
      project_id,
      path: absolute,
      action: "open",
    });
    const relative = await getFileUseTimes({
      client,
      account_id: teacher,
      project_id,
      path,
      target_account_id: student,
      access_times: true,
      edit_times: true,
    });
    expect(relative.access_times).toHaveLength(1);
    expect(relative.edit_times).toEqual([Date.parse(editTime)]);
    const viaAbsolute = await getFileUseTimes({
      client,
      account_id: teacher,
      project_id,
      path: absolute,
      target_account_id: student,
      access_times: true,
      edit_times: true,
    });
    expect(viaAbsolute.access_times).toHaveLength(1);
    expect(viaAbsolute.edit_times).toEqual([Date.parse(editTime)]);
  });

  it("reads only the canonical absolute history when it exists", async () => {
    const { client, getFileUseTimes } = await service();
    const absoluteName =
      "patchflow//home/user/lectures/.example.ipynb.sage-jupyter2";
    streams.set(`${project_id}:${patchName}`, makeStream([{ time: editTime }]));
    streams.set(
      `${project_id}:${absoluteName}`,
      makeStream([{ time: editTime }, { time: editTime }]),
    );
    const result = await getFileUseTimes({
      client,
      account_id: teacher,
      project_id,
      path: "./lectures//example.ipynb",
      edit_times: true,
      access_times: false,
    });
    expect(result.edit_times).toEqual([Date.parse(editTime)]);
    expect(dstreamMock).toHaveBeenCalledTimes(1);
    expect(dstreamMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: absoluteName }),
    );
  });

  it("does not invent history for an unrecorded file", async () => {
    const { client, getFileUseTimes } = await service();
    const result = await getFileUseTimes({
      client,
      account_id: teacher,
      project_id,
      path,
      access_times: true,
      edit_times: true,
    });
    expect(result.access_times).toEqual([]);
    expect(result.edit_times).toEqual([]);
  });

  it("does not relabel document-wide patch times as target-account edits", async () => {
    const { client, getFileUseTimes } = await service();
    streams.set(`${project_id}:${patchName}`, makeStream([{ time: editTime }]));
    const first = await getFileUseTimes({
      client,
      account_id: teacher,
      project_id,
      path,
      target_account_id: student,
      edit_times: true,
    });
    const second = await getFileUseTimes({
      client,
      account_id: teacher,
      project_id,
      path,
      target_account_id: teacher,
      edit_times: true,
    });
    expect(first.edit_times).toEqual([Date.parse(editTime)]);
    expect(second.edit_times).toEqual(first.edit_times);
  });

  it("propagates patch-open failures instead of reporting empty history", async () => {
    const { client, getFileUseTimes } = await service();
    dstreamMock.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(
      getFileUseTimes({
        client,
        account_id: teacher,
        project_id,
        path,
        access_times: false,
        edit_times: true,
      }),
    ).rejects.toThrow("storage unavailable");
  });

  it("closes the patch reader even if reading timestamps fails", async () => {
    const { client, getFileUseTimes } = await service();
    const patches = makeStream();
    patches.times.mockImplementation(() => {
      throw new Error("history unavailable");
    });
    streams.set(`${project_id}:${patchName}`, patches);
    await expect(
      getFileUseTimes({
        client,
        account_id: teacher,
        project_id,
        path,
        access_times: false,
        edit_times: true,
      }),
    ).rejects.toThrow("history unavailable");
    expect(patches.close).toHaveBeenCalledTimes(1);
  });

  it("retains the collaborator check before opening any storage", async () => {
    const { client, getFileUseTimes } = await service();
    getRowMock.mockReturnValue({ users: {} });
    await expect(
      getFileUseTimes({
        client,
        account_id: teacher,
        project_id,
        path,
        edit_times: true,
      }),
    ).rejects.toThrow("is not a collaborator");
    expect(dstreamMock).not.toHaveBeenCalled();
    expect(dkvMock).not.toHaveBeenCalled();
  });

  it("recovers recording after a failed recent-store initialization", async () => {
    const { client, markFile, getFileUseTimes } = await service();
    dkvMock.mockRejectedValueOnce(new Error("store unavailable"));
    const opts = {
      client,
      account_id: student,
      project_id,
      path,
      action: "open" as const,
    };
    await expect(markFile(opts)).rejects.toThrow("store unavailable");
    await expect(markFile(opts)).resolves.toBeUndefined();
    const result = await getFileUseTimes({
      client,
      account_id: teacher,
      project_id,
      path,
      target_account_id: student,
    });
    expect(result.access_times).toHaveLength(1);
    expect(dkvMock).toHaveBeenCalledTimes(2);
  });

  it("recovers recording after a failed access-stream initialization without waiting for throttle", async () => {
    const { client, markFile, getFileUseTimes } = await service();
    dstreamMock.mockRejectedValueOnce(new Error("stream unavailable"));
    const opts = {
      client,
      account_id: student,
      project_id,
      path,
      action: "open" as const,
    };
    await expect(markFile(opts)).rejects.toThrow("stream unavailable");
    await expect(markFile(opts)).resolves.toBeUndefined();
    const result = await getFileUseTimes({
      client,
      account_id: teacher,
      project_id,
      path,
      target_account_id: student,
    });
    expect(result.access_times).toHaveLength(1);
    expect(dstreamMock).toHaveBeenCalledTimes(2);
  });

  it("closes a stream whose setup failed, then retries on the next export", async () => {
    const { client, getFileUseTimes } = await service();
    const failed = makeStream();
    failed.config.mockRejectedValueOnce(new Error("config unavailable"));
    dstreamMock.mockResolvedValueOnce(failed);
    const opts = {
      client,
      account_id: teacher,
      project_id,
      path,
      access_times: true,
      edit_times: false,
    };
    await expect(getFileUseTimes(opts)).rejects.toThrow("config unavailable");
    expect(failed.close).toHaveBeenCalledTimes(1);
    await expect(getFileUseTimes(opts)).resolves.toMatchObject({
      access_times: [],
    });
    expect(dstreamMock).toHaveBeenCalledTimes(2);
  });

  it("does not throttle a failed publish and still throttles successful duplicates", async () => {
    const { client, markFile, getFileUseTimes } = await service();
    const events = makeStream();
    events.publish.mockImplementationOnce(() => {
      throw new Error("publish unavailable");
    });
    streams.set(`${project_id}:project-document-activity-events`, events);
    const opts = {
      client,
      account_id: student,
      project_id,
      path,
      action: "open" as const,
    };
    await expect(markFile(opts)).rejects.toThrow("publish unavailable");
    await markFile(opts);
    await markFile(opts);
    const result = await getFileUseTimes({
      client,
      account_id: teacher,
      project_id,
      path,
      target_account_id: student,
    });
    expect(result.access_times).toHaveLength(1);
    expect(events.publish).toHaveBeenCalledTimes(2);
  });

  it("shares stream initialization and throttles concurrent duplicate marks", async () => {
    const { client, markFile } = await service();
    const events = makeStream();
    let ready!: (value: typeof events) => void;
    let started!: () => void;
    const initializing = new Promise<void>((resolve) => {
      started = resolve;
    });
    dstreamMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          ready = resolve;
          started();
        }),
    );
    const opts = {
      client,
      account_id: student,
      project_id,
      path,
      action: "open" as const,
    };
    const first = markFile(opts);
    const second = markFile(opts);
    // Wait for the async store lookup to reach access-stream initialization.
    await initializing;
    ready(events);
    await first;
    await second;
    expect(dkvMock).toHaveBeenCalledTimes(1);
    expect(dstreamMock).toHaveBeenCalledTimes(1);
    expect(events.publish).toHaveBeenCalledTimes(1);
  });
});
