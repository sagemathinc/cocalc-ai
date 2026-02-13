export {};

let assertCollabMock: jest.Mock;
let conatMock: jest.Mock;
let projectApiClientMock: jest.Mock;

jest.mock("./util", () => ({
  __esModule: true,
  assertCollab: (...args: any[]) => assertCollabMock(...args),
}));

jest.mock("@cocalc/backend/conat", () => ({
  __esModule: true,
  conat: (...args: any[]) => conatMock(...args),
}));

jest.mock("@cocalc/conat/project/api", () => ({
  __esModule: true,
  projectApiClient: (...args: any[]) => projectApiClientMock(...args),
}));

describe("sync.purgeHistory", () => {
  beforeEach(() => {
    jest.resetModules();
    assertCollabMock = jest.fn(async () => undefined);
    conatMock = jest.fn();
    projectApiClientMock = jest.fn();
  });

  it("deletes patch stream, seeds baseline, and bumps history_epoch", async () => {
    const deleteMock = jest.fn(async () => ({ seqs: [1, 2, 3] }));
    const publishMock = jest.fn(async () => ({ seq: 1, time: Date.now() }));
    const closeStreamMock = jest.fn();
    const stream = {
      delete: deleteMock,
      publish: publishMock,
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
    projectApiClientMock.mockReturnValue({
      system: {
        readTextFileFromProject: jest.fn(async () => "hello world"),
      },
    });

    const { purgeHistory } = await import("./sync");
    const result = await purgeHistory({
      account_id: "acct-1",
      project_id: "00000000-1000-4000-8000-000000000000",
      path: "a.txt",
      keep_current_state: true,
    });

    expect(assertCollabMock).toHaveBeenCalledWith({
      account_id: "acct-1",
      project_id: "00000000-1000-4000-8000-000000000000",
    });
    expect(deleteMock).toHaveBeenCalledWith({ all: true });
    expect(publishMock).toHaveBeenCalledTimes(1);
    const published = publishMock.mock.calls[0][0];
    expect(published.path).toBe("a.txt");
    expect(published.patch).toEqual(expect.any(String));
    expect(published.parents).toEqual([]);
    expect(published.version).toBe(1);

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
      seeded: true,
      history_epoch: 6,
    });
  });

  it("supports keep_current_state=false", async () => {
    const deleteMock = jest.fn(async () => ({ seqs: [] }));
    const publishMock = jest.fn();
    const stream = {
      delete: deleteMock,
      publish: publishMock,
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
    const readMock = jest.fn(async () => "ignored");
    projectApiClientMock.mockReturnValue({
      system: { readTextFileFromProject: readMock },
    });

    const { purgeHistory } = await import("./sync");
    const result = await purgeHistory({
      account_id: "acct-1",
      project_id: "00000000-1000-4000-8000-000000000000",
      path: "a.txt",
      keep_current_state: false,
    });

    expect(readMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
    expect(result.seeded).toBe(false);
    expect(result.history_epoch).toBe(1);
  });
});
