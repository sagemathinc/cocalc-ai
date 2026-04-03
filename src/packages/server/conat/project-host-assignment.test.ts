export {};

let queryMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: queryMock })),
}));

const HOST_ID = "11111111-1111-1111-1111-111111111111";
const PROJECT_ID = "22222222-2222-2222-2222-222222222222";

describe("project host assignment", () => {
  beforeEach(() => {
    jest.resetModules();
    queryMock = jest.fn(async () => ({ rows: [] }));
  });

  it("returns assigned host info when project and host bays match", async () => {
    queryMock = jest.fn(async () => ({
      rows: [
        {
          host_id: HOST_ID,
          project_owning_bay_id: "bay-a",
          host_bay_id: "bay-a",
          ssh_server: "ssh.example:22",
          metadata: { machine: { cloud: "gcp" } },
        },
      ],
    }));
    const { getAssignedProjectHostInfo } =
      await import("./project-host-assignment");
    await expect(getAssignedProjectHostInfo(PROJECT_ID)).resolves.toMatchObject(
      {
        host_id: HOST_ID,
        ssh_server: "ssh.example:22",
        metadata: { machine: { cloud: "gcp" } },
      },
    );
  });

  it("rejects missing workspaces", async () => {
    queryMock = jest.fn(async () => ({ rows: [] }));
    const { getAssignedProjectHostInfo } =
      await import("./project-host-assignment");
    await expect(getAssignedProjectHostInfo(PROJECT_ID)).rejects.toThrow(
      "workspace not found",
    );
  });

  it("rejects workspaces without an assigned host", async () => {
    queryMock = jest.fn(async () => ({
      rows: [
        {
          host_id: null,
          project_owning_bay_id: "bay-a",
          host_bay_id: "bay-a",
          ssh_server: null,
          metadata: null,
        },
      ],
    }));
    const { getAssignedProjectHostInfo } =
      await import("./project-host-assignment");
    await expect(getAssignedProjectHostInfo(PROJECT_ID)).rejects.toThrow(
      "workspace has no assigned host",
    );
  });

  it("rejects assigned hosts in the wrong bay", async () => {
    queryMock = jest.fn(async () => ({
      rows: [
        {
          host_id: HOST_ID,
          project_owning_bay_id: "bay-a",
          host_bay_id: "bay-b",
          ssh_server: "ssh.example:22",
          metadata: null,
        },
      ],
    }));
    const { getAssignedProjectHostInfo } =
      await import("./project-host-assignment");
    await expect(getAssignedProjectHostInfo(PROJECT_ID)).rejects.toThrow(
      "workspace bay does not match assigned host",
    );
  });
});
