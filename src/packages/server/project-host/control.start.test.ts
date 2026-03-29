/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

let queryMock: jest.Mock;
let createHostControlClientMock: jest.Mock;
let conatWithProjectRoutingMock: jest.Mock;
let notifyProjectHostUpdateMock: jest.Mock;
let sshKeysMock: jest.Mock;

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
  getLogger: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    query: (...args: any[]) => queryMock(...args),
  })),
}));

jest.mock("@cocalc/conat/project-host/api", () => ({
  __esModule: true,
  createHostControlClient: (...args: any[]) =>
    createHostControlClientMock(...args),
}));

jest.mock("@cocalc/server/conat/route-client", () => ({
  __esModule: true,
  conatWithProjectRouting: (...args: any[]) =>
    conatWithProjectRoutingMock(...args),
}));

jest.mock("../conat/route-project", () => ({
  __esModule: true,
  notifyProjectHostUpdate: (...args: any[]) =>
    notifyProjectHostUpdateMock(...args),
}));

jest.mock("../projects/get-ssh-keys", () => ({
  __esModule: true,
  default: (...args: any[]) => sshKeysMock(...args),
}));

describe("startProjectOnHost placement", () => {
  beforeEach(() => {
    jest.resetModules();
    notifyProjectHostUpdateMock = jest.fn(async () => undefined);
    conatWithProjectRoutingMock = jest.fn(() => ({ client: "router" }));
    sshKeysMock = jest.fn(async () => ({
      key: { value: "ssh-ed25519 AAAATEST user@test" },
    }));
  });

  it("registers a new host placement without doing the long runtime start in createProject", async () => {
    const createProjectMock = jest.fn(async () => ({
      project_id: "proj-1",
      state: "opened",
    }));
    const startProjectMock = jest.fn(async () => ({
      project_id: "proj-1",
      state: "running",
      phase_timings_ms: { runner_start: 1234 },
    }));
    createHostControlClientMock = jest.fn(() => ({
      createProject: createProjectMock,
      startProject: startProjectMock,
    }));

    let loadProjectCalls = 0;
    queryMock = jest.fn(async (sql: string, params: any[]) => {
      if (sql === "SELECT state FROM projects WHERE project_id=$1") {
        return {
          rows: [{ state: { state: "opened", time: "2026-03-29T00:00:00Z" } }],
        };
      }
      if (sql.includes("FROM long_running_operations")) {
        return { rows: [{ exists: false }] };
      }
      if (
        sql ===
        "SELECT title, users, rootfs_image as image, host_id, run_quota FROM projects WHERE project_id=$1"
      ) {
        loadProjectCalls += 1;
        return {
          rows: [
            {
              title: "OCI test",
              users: { owner: { group: "owner" } },
              image: "sagemathinc/sagemath-x86_64:10.7",
              host_id: loadProjectCalls === 1 ? null : "host-1",
              run_quota: null,
            },
          ],
        };
      }
      if (
        sql.includes("FROM project_hosts") &&
        sql.includes("WHERE status='running'")
      ) {
        return {
          rows: [
            {
              id: "host-1",
              name: "Host 1",
              region: "us-west1",
              public_url: null,
              internal_url: null,
              ssh_server: null,
              tier: 0,
              metadata: { machine: {} },
            },
          ],
        };
      }
      if (
        sql ===
        "SELECT metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL"
      ) {
        return {
          rows: [{ metadata: { machine: {} } }],
        };
      }
      if (sql === "UPDATE projects SET host_id=$1 WHERE project_id=$2") {
        expect(params).toEqual(["host-1", "proj-1"]);
        return { rows: [] };
      }
      if (sql === "SELECT backup_repo_id FROM projects WHERE project_id=$1") {
        return { rows: [{ backup_repo_id: null }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { startProjectOnHost } = await import("./control");
    await startProjectOnHost("proj-1", { lro_op_id: "op-1" });

    expect(createProjectMock).toHaveBeenCalledWith({
      project_id: "proj-1",
      title: "OCI test",
      users: { owner: { group: "owner" } },
      image: "sagemathinc/sagemath-x86_64:10.7",
      start: false,
      authorized_keys: "ssh-ed25519 AAAATEST user@test",
      run_quota: {},
    });
    expect(startProjectMock).toHaveBeenCalledWith({
      project_id: "proj-1",
      authorized_keys: "ssh-ed25519 AAAATEST user@test",
      run_quota: {},
      image: "sagemathinc/sagemath-x86_64:10.7",
      restore: "none",
      lro_op_id: "op-1",
    });
    expect(notifyProjectHostUpdateMock).toHaveBeenCalledWith({
      project_id: "proj-1",
      host_id: "host-1",
    });
  });
});
