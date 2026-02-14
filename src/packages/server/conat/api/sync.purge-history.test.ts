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

describe("sync.purgeHistory", () => {
  beforeEach(() => {
    jest.resetModules();
    assertCollabMock = jest.fn(async () => undefined);
    conatMock = jest.fn();
  });

  it("deletes patch stream, fences writes, and bumps history_epoch", async () => {
    const deleteMock = jest.fn(async () => ({ seqs: [1, 2, 3] }));
    const configMock = jest.fn(async () => ({ required_headers: {} }));
    const closeStreamMock = jest.fn();
    const stream = {
      delete: deleteMock,
      config: configMock,
      close: closeStreamMock,
    };

    const setMock = jest.fn();
    const saveMock = jest.fn(async () => undefined);
    const closeSyncstringsMock = jest.fn();
    const syncstrings = {
      get_one: jest.fn(() => ({
        string_id: "sid",
        project_id: "00000000-1000-4000-8000-000000000000",
        path: "a.txt",
        doctype: JSON.stringify({ type: "string", patch_format: 0 }),
        settings: { history_epoch: 5 },
      })),
      set: setMock,
      save: saveMock,
      close: closeSyncstringsMock,
    };

    const client = {
      sync: {
        astream: jest.fn(() => stream),
        synctable: jest.fn(async () => syncstrings),
      },
    };
    conatMock.mockReturnValue(client);

    const { purgeHistory } = await import("./sync");
    const result = await purgeHistory({
      account_id: "acct-1",
      project_id: "00000000-1000-4000-8000-000000000000",
      path: "a.txt",
    });

    expect(assertCollabMock).toHaveBeenCalledWith({
      account_id: "acct-1",
      project_id: "00000000-1000-4000-8000-000000000000",
    });
    expect(configMock).toHaveBeenCalledWith({
      required_headers: { history_epoch: 6 },
    });
    expect(deleteMock).toHaveBeenCalledWith({ all: true });

    expect(setMock).toHaveBeenCalledTimes(1);
    const next = setMock.mock.calls[0][0];
    expect(next.last_snapshot).toBeNull();
    expect(next.last_seq).toBeNull();
    expect(next.settings.history_epoch).toBe(6);
    expect(next.settings.history_purged_by).toBe("acct-1");
    expect(saveMock).toHaveBeenCalled();
    expect(closeStreamMock).toHaveBeenCalled();
    expect(closeSyncstringsMock).toHaveBeenCalled();

    expect(result).toEqual({
      deleted: 3,
      history_epoch: 6,
    });
  });

  it("works when there is no prior history metadata", async () => {
    const deleteMock = jest.fn(async () => ({ seqs: [] }));
    const configMock = jest.fn(async () => ({ required_headers: {} }));
    const stream = {
      delete: deleteMock,
      config: configMock,
      close: jest.fn(),
    };
    const syncstrings = {
      get_one: jest.fn(() => ({
        string_id: "sid",
        project_id: "00000000-1000-4000-8000-000000000000",
        path: "a.txt",
        doctype: JSON.stringify({ type: "string", patch_format: 0 }),
        settings: {},
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

    const { purgeHistory } = await import("./sync");
    const result = await purgeHistory({
      account_id: "acct-1",
      project_id: "00000000-1000-4000-8000-000000000000",
      path: "a.txt",
    });

    expect(configMock).toHaveBeenCalledWith({
      required_headers: { history_epoch: 1 },
    });
    expect(result.history_epoch).toBe(1);
  });
});
