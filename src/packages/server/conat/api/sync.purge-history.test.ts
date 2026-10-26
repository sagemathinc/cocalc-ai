export {};

let assertCollabMock: jest.Mock;
let conatMock: jest.Mock;

jest.mock("./util", () => ({
  __esModule: true,
  assertCollab: (...args: any[]) => assertCollabMock(...args),
}));

jest.mock("@cocalc/backend/conat", () => ({
  __esModule: true,
  conat: (...args: any[]) => conatMock(...args),
}));

const PROJECT = "00000000-1000-4000-8000-000000000000";

// The patch stream resets itself atomically (fence, epoch in its metadata,
// history deleted or kept aside; see PersistentStream.resetHistory, tested
// in @cocalc/conat).  Here: what purgeHistory asks of it, and the legacy
// syncstrings record it keeps in step.
function mockClient({
  resetResult,
  syncstringsSettings = { history_epoch: 5 },
}: {
  resetResult: {
    reset: boolean;
    history_epoch: number;
    count: number;
    countExact?: boolean;
  };
  syncstringsSettings?: Record<string, any>;
}) {
  const stream = {
    resetHistory: jest.fn(async () => resetResult),
    close: jest.fn(),
  };
  const syncstrings = {
    get_one: jest.fn(() => ({
      string_id: "sid",
      project_id: PROJECT,
      path: "a.txt",
      doctype: JSON.stringify({ type: "string", patch_format: 0 }),
      settings: syncstringsSettings,
    })),
    set: jest.fn(),
    save: jest.fn(async () => undefined),
    close: jest.fn(),
  };
  conatMock.mockReturnValue({
    sync: {
      astream: jest.fn(() => stream),
      synctable: jest.fn(async () => syncstrings),
    },
  });
  return { stream, syncstrings };
}

describe("sync.purgeHistory", () => {
  beforeEach(() => {
    jest.resetModules();
    assertCollabMock = jest.fn(async () => undefined);
    conatMock = jest.fn();
  });

  it("resets the patch stream's history and records the new epoch", async () => {
    const { stream, syncstrings } = mockClient({
      resetResult: { reset: true, history_epoch: 6, count: 3 },
    });
    const { purgeHistory } = await import("./sync");
    const result = await purgeHistory({
      account_id: "acct-1",
      project_id: PROJECT,
      path: "a.txt",
    });

    expect(assertCollabMock).toHaveBeenCalledWith({
      account_id: "acct-1",
      project_id: PROJECT,
    });
    expect(stream.resetHistory).toHaveBeenCalledTimes(1);
    expect(stream.resetHistory).toHaveBeenCalledWith({
      // an epoch recorded only in syncstrings still counts
      minEpoch: 5,
      settings: {
        history_purged_at: expect.any(Number),
        history_purged_by: "acct-1",
      },
    });
    expect(syncstrings.set).toHaveBeenCalledTimes(1);
    const next = syncstrings.set.mock.calls[0][0];
    expect(next.last_snapshot).toBeNull();
    expect(next.last_seq).toBeNull();
    expect(next.settings.history_epoch).toBe(6);
    expect(next.settings.history_purged_by).toBe("acct-1");
    expect(syncstrings.save).toHaveBeenCalled();
    expect(stream.close).toHaveBeenCalled();
    expect(syncstrings.close).toHaveBeenCalled();
    expect(result).toEqual({ deleted: 3, history_epoch: 6, reset: true });
  });

  it("works when there is no prior history epoch", async () => {
    const { stream } = mockClient({
      resetResult: { reset: true, history_epoch: 1, count: 0 },
      syncstringsSettings: {},
    });
    const { purgeHistory } = await import("./sync");
    const result = await purgeHistory({
      account_id: "acct-1",
      project_id: PROJECT,
      path: "a.txt",
    });
    expect(stream.resetHistory).toHaveBeenCalledWith(
      expect.objectContaining({ minEpoch: 0 }),
    );
    expect(result.history_epoch).toBe(1);
  });

  it("for an oversized patch, resets only if it is still there, keeping the old history", async () => {
    const { stream, syncstrings } = mockClient({
      resetResult: { reset: false, history_epoch: 6, count: 0 },
    });
    const { purgeHistory } = await import("./sync");
    const result = await purgeHistory({
      account_id: "acct-1",
      project_id: PROJECT,
      path: "a.txt",
      oversized_seq: 42,
    });
    expect(stream.resetHistory).toHaveBeenCalledWith(
      expect.objectContaining({ ifOversizedSeq: 42, archive: true }),
    );
    // someone else already reset it: nothing to record
    expect(syncstrings.set).not.toHaveBeenCalled();
    expect(result).toEqual({ deleted: 0, history_epoch: 6, reset: false });
  });

  it("reports a history still being counted as a lower bound, not an exact count", async () => {
    // a stream from before H1c, too long to count yet: count() is the probe
    // sentinel COUNT_PROBE_RECORDS + 1, "more than COUNT_PROBE_RECORDS"
    mockClient({
      resetResult: {
        reset: true,
        history_epoch: 6,
        count: 10_001,
        countExact: false,
      },
    });
    const { purgeHistory } = await import("./sync");
    const result = await purgeHistory({
      account_id: "acct-1",
      project_id: PROJECT,
      path: "a.txt",
    });
    expect(result).toEqual({
      deleted: 10_000,
      deletedExact: false,
      history_epoch: 6,
      reset: true,
    });
  });

  it("rejects a malformed oversized_seq", async () => {
    const { stream } = mockClient({
      resetResult: { reset: true, history_epoch: 6, count: 0 },
    });
    const { purgeHistory } = await import("./sync");
    await expect(
      purgeHistory({
        account_id: "acct-1",
        project_id: PROJECT,
        path: "a.txt",
        oversized_seq: "1" as any,
      }),
    ).rejects.toThrow("oversized_seq");
    expect(stream.resetHistory).not.toHaveBeenCalled();
  });
});
