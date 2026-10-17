const rows = new Map<string, any>();
const mockCallHub = jest.fn();
const mockUpsertProject = jest.fn();
let mockMasterClient: object | undefined = {};

jest.mock("@cocalc/lite/hub/sqlite/database", () => ({
  getRow: (_table: string, pk: string) => rows.get(pk),
}));
jest.mock("@cocalc/conat/hub/call-hub", () => ({
  __esModule: true,
  default: (...args: any[]) => mockCallHub(...args),
}));
jest.mock("../master-conat-client", () => ({
  getMasterConatClient: () => mockMasterClient,
}));
jest.mock("../sqlite/hosts", () => ({
  getLocalHostId: () => "host-1",
}));
jest.mock("../sqlite/projects", () => ({
  upsertProject: (...args: any[]) => mockUpsertProject(...args),
}));

import { isAcpProjectMember } from "./project-membership";

const project_id = "11111111-1111-4111-8111-111111111111";
const owner = "22222222-2222-4222-8222-222222222222";
const collaborator = "33333333-3333-4333-8333-333333333333";
const removed = "44444444-4444-4444-8444-444444444444";

describe("isAcpProjectMember", () => {
  beforeEach(() => {
    rows.clear();
    mockCallHub.mockReset();
    mockUpsertProject.mockReset();
    mockMasterClient = {};
    rows.set(JSON.stringify({ project_id }), {
      project_id,
      users: {
        [owner]: { group: "owner" },
        [collaborator]: "collaborator",
      },
    });
  });

  it("accepts owners and collaborators on the local project record", async () => {
    expect(await isAcpProjectMember({ account_id: owner, project_id })).toBe(
      true,
    );
    expect(
      await isAcpProjectMember({ account_id: collaborator, project_id }),
    ).toBe(true);
    // The local record answered: the owning bay is not asked.
    expect(mockCallHub).not.toHaveBeenCalled();
  });

  it("refuses removed accounts, unknown projects and malformed ids", async () => {
    mockCallHub.mockResolvedValue({
      users: { [owner]: { group: "owner" } },
      users_revision: 3,
    });
    expect(await isAcpProjectMember({ account_id: removed, project_id })).toBe(
      false,
    );
    mockCallHub.mockRejectedValue(
      new Error("project is not assigned to host host-1"),
    );
    expect(
      await isAcpProjectMember({
        account_id: owner,
        project_id: "55555555-5555-4555-8555-555555555555",
      }),
    ).toBe(false);
    expect(await isAcpProjectMember({ account_id: "owner", project_id })).toBe(
      false,
    );
    expect(mockUpsertProject).not.toHaveBeenCalled();
  });

  it("confirms a local miss with the owning bay and stores its list", async () => {
    // The host's copy lost the owner (how is what the log line records).
    rows.set(JSON.stringify({ project_id }), {
      project_id,
      users: { [collaborator]: "collaborator" },
      users_revision: 4,
    });
    const users = {
      [owner]: { group: "owner" },
      [collaborator]: { group: "collaborator" },
    };
    mockCallHub.mockResolvedValue({ users, users_revision: 5 });
    expect(await isAcpProjectMember({ account_id: owner, project_id })).toBe(
      true,
    );
    expect(mockCallHub).toHaveBeenCalledWith(
      expect.objectContaining({
        host_id: "host-1",
        name: "hosts.getProjectStartMetadata",
        args: [{ project_id }],
      }),
    );
    expect(mockUpsertProject).toHaveBeenCalledWith({
      project_id,
      users,
      users_revision: 5,
    });
  });

  it("fails closed when the owning bay cannot be asked", async () => {
    mockCallHub.mockRejectedValue(new Error("timeout"));
    expect(await isAcpProjectMember({ account_id: removed, project_id })).toBe(
      false,
    );
    mockMasterClient = undefined;
    expect(await isAcpProjectMember({ account_id: removed, project_id })).toBe(
      false,
    );
  });
});
