/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The content-origin revocation counter travels to the project's host with
// its users (trust-free step 6).

const queryMock = jest.fn();
const updateProjectUsersMock = jest.fn(async (_opts: any) => {});

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: (...args: any[]) => queryMock(...args) }),
}));
jest.mock("@cocalc/server/conat/project-host-assignment", () => ({
  getAssignedProjectHostInfo: async () => ({ host_id: "host-1" }),
  PROJECT_HAS_NO_ASSIGNED_HOST_ERROR: "project has no assigned host",
}));
jest.mock("./client", () => ({
  getRoutedHostControlClient: async () => ({
    updateProjectUsers: (opts: any) => updateProjectUsersMock(opts),
  }),
}));
jest.mock("../projects/get-ssh-keys", () => ({
  __esModule: true,
  default: async () => ({}),
}));

import { syncProjectUsersOnHost } from "./control";

const PROJECT = "00000000-0000-4000-8000-000000000001";
const users = { a: { group: "owner" } };

function database({ epochColumn = true }: { epochColumn?: boolean } = {}) {
  queryMock.mockImplementation(async (sql: string) => {
    if (sql.includes("content_epoch")) {
      if (!epochColumn) {
        throw Object.assign(new Error("no such column"), { code: "42703" });
      }
      return { rows: [{ content_epoch: "5" }] };
    }
    if (sql.includes("FROM projects")) {
      return {
        rows: [
          {
            users,
            image: "ubuntu",
            runtime_lifecycle_revision: 2,
            run_quota_revision: 0,
          },
        ],
      };
    }
    return { rows: [] };
  });
}

beforeEach(() => {
  queryMock.mockReset();
  updateProjectUsersMock.mockClear();
});

it("sends the project's content epoch with its users", async () => {
  database();
  await syncProjectUsersOnHost({ project_id: PROJECT });
  expect(updateProjectUsersMock).toHaveBeenCalledWith({
    project_id: PROJECT,
    users,
    runtime_lifecycle_revision: 2,
    content_epoch: 5,
  });
});

it("still syncs users on a schema without the column", async () => {
  database({ epochColumn: false });
  await syncProjectUsersOnHost({ project_id: PROJECT });
  expect(updateProjectUsersMock).toHaveBeenCalledWith({
    project_id: PROJECT,
    users,
    runtime_lifecycle_revision: 2,
  });
});
