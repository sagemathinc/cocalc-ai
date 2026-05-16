/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const queryMock = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    query: queryMock,
  })),
}));

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

jest.mock("@cocalc/backend/sandbox/rustic", () => ({
  __esModule: true,
  default: {},
}));

jest.mock("@cocalc/backend/sandbox/exec", () => ({
  parseOutput: jest.fn(),
}));

jest.mock("@cocalc/server/project-host/control", () => ({
  deleteProjectDataOnHost: jest.fn(),
  stopProjectOnHost: jest.fn(),
}));

jest.mock("@cocalc/server/project-backup", () => ({
  getDeletedProjectBackupConfigForDeletion: jest.fn(),
  getProjectBackupConfigForDeletion: jest.fn(),
  releaseProjectBackupRepoAssignment: jest.fn(),
  resolveProjectBackupRepoAssignment: jest.fn(),
}));

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const COLLABORATOR_ID = "33333333-3333-4333-8333-333333333333";

function projectRow(users: Record<string, { group: string }>) {
  return {
    project_id: PROJECT_ID,
    name: "project",
    title: "Project",
    description: "",
    users,
    host_id: "host-1",
    region: "us",
    backup_repo_id: null,
    created: new Date(),
    last_edited: new Date(),
  };
}

describe("hard-delete permission", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("allows the project owner", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        projectRow({
          [OWNER_ID]: { group: "owner" },
          [COLLABORATOR_ID]: { group: "collaborator" },
        }),
      ],
    });

    const { assertHardDeleteProjectPermission } = await import("./hard-delete");
    await expect(
      assertHardDeleteProjectPermission({
        project_id: PROJECT_ID,
        account_id: OWNER_ID,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects collaborators", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        projectRow({
          [OWNER_ID]: { group: "owner" },
          [COLLABORATOR_ID]: { group: "collaborator" },
        }),
      ],
    });

    const { assertHardDeleteProjectPermission } = await import("./hard-delete");
    await expect(
      assertHardDeleteProjectPermission({
        project_id: PROJECT_ID,
        account_id: COLLABORATOR_ID,
      }),
    ).rejects.toThrow(
      "must be a project owner to permanently delete a workspace",
    );
  });
});
