jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getActions: jest.fn(),
    getStore: jest.fn(),
  },
}));

const mockString = jest.fn(() => ({ kind: "syncstring" }));
const mockDb = jest.fn(() => ({ kind: "syncdb" }));
const mockImmer = jest.fn(() => ({ kind: "immerdb" }));
const mockProjectConatSync = jest.fn(() => ({
  sync: {
    string: mockString,
    db: mockDb,
    immer: mockImmer,
  },
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      projectConatSync: mockProjectConatSync,
    },
    project_client: {},
    time_client: {},
    tracking_client: {},
  },
}));

describe("generic editor syncdoc client routing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("opens syncstrings through the project-scoped Conat client", () => {
    const { syncstring2 } = require("./client");

    syncstring2({
      project_id: "00000000-0000-4000-8000-000000000001",
      path: "/a.txt",
    });

    expect(mockProjectConatSync).toHaveBeenCalledWith({
      project_id: "00000000-0000-4000-8000-000000000001",
      caller: "syncstring2",
      requireRouting: true,
    });
    expect(mockString).toHaveBeenCalledWith({
      project_id: "00000000-0000-4000-8000-000000000001",
      path: "/a.txt",
    });
  });

  it("opens structured syncdocs through the project-scoped Conat client", () => {
    const { syncdb2, immerdb2 } = require("./client");

    syncdb2({
      project_id: "00000000-0000-4000-8000-000000000002",
      path: "/a.ipynb",
      primary_keys: ["id"],
    });
    immerdb2({
      project_id: "00000000-0000-4000-8000-000000000003",
      path: "/a.chat",
      primary_keys: ["id"],
    });

    expect(mockProjectConatSync).toHaveBeenCalledWith({
      project_id: "00000000-0000-4000-8000-000000000002",
      caller: "syncdb2",
      requireRouting: true,
    });
    expect(mockProjectConatSync).toHaveBeenCalledWith({
      project_id: "00000000-0000-4000-8000-000000000003",
      caller: "immerdb2",
      requireRouting: true,
    });
    expect(mockDb).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "00000000-0000-4000-8000-000000000002",
        path: "/a.ipynb",
      }),
    );
    expect(mockImmer).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "00000000-0000-4000-8000-000000000003",
        path: "/a.chat",
      }),
    );
  });
});
