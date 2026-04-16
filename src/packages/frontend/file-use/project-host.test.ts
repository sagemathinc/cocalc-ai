import { Map as ImmutableMap, fromJS } from "immutable";

const listRecentMock = jest.fn();
let mockLite = false;

jest.mock("@cocalc/conat/project/document-activity", () => ({
  listRecent: (...args: any[]) => listRecentMock(...args),
}));

jest.mock("@cocalc/frontend/lite", () => ({
  get lite() {
    return mockLite;
  },
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      conat: jest.fn(() => ({ id: "client" })),
    },
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("listRecentDocumentActivityBestEffort", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLite = false;
  });

  it("publishes a fast first wave before waiting on slower projects", async () => {
    const slow = deferred<any[]>();
    listRecentMock.mockImplementation(async ({ project_id }: any) => {
      switch (project_id) {
        case "project-1":
          return [
            {
              project_id,
              path: "fast-1.txt",
              last_accessed: "2026-04-12T20:00:00.000Z",
              recent_account_ids: [],
            },
          ];
        case "project-2":
          return [
            {
              project_id,
              path: "fast-2.txt",
              last_accessed: "2026-04-12T19:00:00.000Z",
              recent_account_ids: [],
            },
          ];
        case "project-3":
          return await slow.promise;
        default:
          return [];
      }
    });

    const updates: Array<{ rows: any[]; complete: boolean }> = [];
    const project_map = fromJS({
      "project-1": {
        host_id: "host-1",
        last_edited: 30,
      },
      "project-2": {
        host_id: "host-2",
        last_edited: 20,
      },
      "project-3": {
        host_id: "host-3",
        last_edited: 10,
      },
    }) as ImmutableMap<string, any>;

    const { listRecentDocumentActivityBestEffort } =
      await import("./project-host");
    const promise = listRecentDocumentActivityBestEffort({
      account_id: "00000000-0000-4000-8000-000000000001",
      project_map,
      maxProjects: 3,
      firstWaveProjects: 2,
      onRows: (update) => updates.push(update),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(updates).toHaveLength(1);
    expect(updates[0].complete).toBe(false);
    expect(updates[0].rows.map((row) => row.path)).toEqual([
      "fast-1.txt",
      "fast-2.txt",
    ]);

    slow.resolve([
      {
        project_id: "project-3",
        path: "slow.txt",
        last_accessed: "2026-04-12T18:00:00.000Z",
        recent_account_ids: [],
      },
    ]);

    const finalRows = await promise;
    expect(finalRows.map((row) => row.path)).toEqual([
      "fast-1.txt",
      "fast-2.txt",
      "slow.txt",
    ]);
    expect(updates).toHaveLength(2);
    expect(updates[1].complete).toBe(true);
  });

  it("returns immediately without querying document-activity in lite mode", async () => {
    mockLite = true;
    const updates: Array<{ rows: any[]; complete: boolean }> = [];
    const project_map = fromJS({
      "project-1": {
        host_id: "host-1",
        last_edited: 30,
      },
    }) as ImmutableMap<string, any>;

    const { listRecentDocumentActivityBestEffort } =
      await import("./project-host");
    const rows = await listRecentDocumentActivityBestEffort({
      account_id: "00000000-0000-4000-8000-000000000001",
      project_map,
      onRows: (update) => updates.push(update),
    });

    expect(rows).toEqual([]);
    expect(updates).toEqual([{ rows: [], complete: true }]);
    expect(listRecentMock).not.toHaveBeenCalled();
  });
});
