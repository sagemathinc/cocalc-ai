/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

import { DEFAULT_PROJECT_IMAGE } from "@cocalc/util/db-schema/defaults";

let queryMock: jest.Mock;
let createHostControlClientMock: jest.Mock;
let getExplicitHostRoutedClientMock: jest.Mock;
let notifyProjectHostUpdateMock: jest.Mock;
let sshKeysMock: jest.Mock;
let maybeAutoGrowHostDiskForReservationFailureMock: jest.Mock;
let appendProjectOutboxEventForProjectMock: jest.Mock;
let publishProjectAccountFeedEventsBestEffortMock: jest.Mock;
let poolConnectMock: jest.Mock;
let releaseMock: jest.Mock;
let resolveHostBayMock: jest.Mock;
let getCurrentProjectRootfsBindingMock: jest.Mock;

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
    connect: (...args: any[]) => poolConnectMock(...args),
  })),
}));

jest.mock("@cocalc/database/postgres/project-events-outbox", () => ({
  __esModule: true,
  appendProjectOutboxEventForProject: (...args: any[]) =>
    appendProjectOutboxEventForProjectMock(...args),
}));

jest.mock("@cocalc/server/account/project-feed", () => ({
  __esModule: true,
  publishProjectAccountFeedEventsBestEffort: (...args: any[]) =>
    publishProjectAccountFeedEventsBestEffortMock(...args),
}));

jest.mock("@cocalc/conat/project-host/api", () => ({
  __esModule: true,
  createHostControlClient: (...args: any[]) =>
    createHostControlClientMock(...args),
}));

jest.mock("@cocalc/server/conat/route-client", () => ({
  __esModule: true,
  getExplicitHostRoutedClient: (...args: any[]) =>
    getExplicitHostRoutedClientMock(...args),
  getExplicitHostControlClient: (...args: any[]) =>
    getExplicitHostRoutedClientMock(...args),
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

jest.mock("./auto-grow", () => ({
  __esModule: true,
  maybeAutoGrowHostDiskForReservationFailure: (...args: any[]) =>
    maybeAutoGrowHostDiskForReservationFailureMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/directory", () => ({
  __esModule: true,
  resolveHostBayAcrossCluster: (...args: any[]) => resolveHostBayMock(...args),
}));

jest.mock("@cocalc/server/projects/rootfs-state", () => ({
  __esModule: true,
  getCurrentProjectRootfsBinding: (...args: any[]) =>
    getCurrentProjectRootfsBindingMock(...args),
}));

describe("startProjectOnHost placement", () => {
  beforeEach(() => {
    jest.resetModules();
    notifyProjectHostUpdateMock = jest.fn(async () => undefined);
    getExplicitHostRoutedClientMock = jest.fn(async () => ({
      client: "router",
    }));
    sshKeysMock = jest.fn(async () => ({
      key: { value: "ssh-ed25519 AAAATEST user@test" },
    }));
    maybeAutoGrowHostDiskForReservationFailureMock = jest.fn(async () => ({
      grown: false,
      reason: "auto-grow disabled",
    }));
    appendProjectOutboxEventForProjectMock = jest.fn(async () => "event-id");
    publishProjectAccountFeedEventsBestEffortMock = jest.fn(
      async () => undefined,
    );
    getCurrentProjectRootfsBindingMock = jest.fn(async () => undefined);
    releaseMock = jest.fn();
    resolveHostBayMock = jest.fn(async (host_id: string) => ({
      bay_id: host_id === "host-2" ? "bay-7" : "bay-0",
      epoch: 0,
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
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: null };
      }
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
        "SELECT title, users, rootfs_image as image, host_id, owning_bay_id, run_quota FROM projects WHERE project_id=$1"
      ) {
        loadProjectCalls += 1;
        return {
          rows: [
            {
              title: "OCI test",
              users: { owner: { group: "owner" } },
              image: "sagemathinc/sagemath-x86_64:10.7",
              host_id: loadProjectCalls === 1 ? null : "host-1",
              owning_bay_id: "bay-0",
              run_quota: null,
            },
          ],
        };
      }
      if (
        sql.includes("FROM project_hosts") &&
        sql.includes("WHERE status='running'")
      ) {
        expect(params).toEqual(["bay-0"]);
        return {
          rows: [
            {
              id: "host-1",
              bay_id: "bay-0",
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
      if (sql.includes("SET state=$2::jsonb")) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("UPDATE projects AS projects")) {
        expect(params).toEqual(["host-1", "proj-1", "bay-0"]);
        return {
          rows: [{ owning_bay_id: "bay-0" }],
        };
      }
      if (sql === "SELECT backup_repo_id FROM projects WHERE project_id=$1") {
        return { rows: [{ backup_repo_id: null }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    poolConnectMock = jest.fn(async () => ({
      query: queryMock,
      release: releaseMock,
    }));

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

  it("retries start once after a successful guarded auto-grow", async () => {
    const createProjectMock = jest.fn(async () => ({
      project_id: "proj-1",
      state: "opened",
    }));
    const startProjectMock = jest
      .fn()
      .mockRejectedValueOnce(
        new Error("host storage reservation denied for OCI image pull"),
      )
      .mockResolvedValueOnce({
        project_id: "proj-1",
        state: "running",
        phase_timings_ms: { runner_start: 4321 },
      });
    createHostControlClientMock = jest.fn(() => ({
      createProject: createProjectMock,
      startProject: startProjectMock,
    }));
    maybeAutoGrowHostDiskForReservationFailureMock = jest.fn(async () => ({
      grown: true,
      next_disk_gb: 250,
    }));

    let loadProjectCalls = 0;
    queryMock = jest.fn(async (sql: string, params: any[]) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: null };
      }
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
        "SELECT title, users, rootfs_image as image, host_id, owning_bay_id, run_quota FROM projects WHERE project_id=$1"
      ) {
        loadProjectCalls += 1;
        return {
          rows: [
            {
              title: "OCI test",
              users: { owner: { group: "owner" } },
              image: "sagemathinc/sagemath-x86_64:10.7",
              host_id: loadProjectCalls === 1 ? null : "host-1",
              owning_bay_id: "bay-0",
              run_quota: null,
            },
          ],
        };
      }
      if (
        sql.includes("FROM project_hosts") &&
        sql.includes("WHERE status='running'")
      ) {
        expect(params).toEqual(["bay-0"]);
        return {
          rows: [
            {
              id: "host-1",
              bay_id: "bay-0",
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
      if (sql.includes("SET state=$2::jsonb")) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("UPDATE projects AS projects")) {
        expect(params).toEqual(["host-1", "proj-1", "bay-0"]);
        return {
          rows: [{ owning_bay_id: "bay-0" }],
        };
      }
      if (sql === "SELECT backup_repo_id FROM projects WHERE project_id=$1") {
        return { rows: [{ backup_repo_id: null }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    poolConnectMock = jest.fn(async () => ({
      query: queryMock,
      release: releaseMock,
    }));

    const { startProjectOnHost } = await import("./control");
    await startProjectOnHost("proj-1", { lro_op_id: "op-1" });

    expect(startProjectMock).toHaveBeenCalledTimes(2);
    expect(maybeAutoGrowHostDiskForReservationFailureMock).toHaveBeenCalledWith(
      {
        host_id: "host-1",
        err: expect.any(Error),
      },
    );
  });

  it("allows placement onto a host from another bay", async () => {
    queryMock = jest.fn(async (sql: string, params: any[]) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: null };
      }
      if (sql.includes("SET state=$2::jsonb")) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("UPDATE projects AS projects")) {
        expect(params).toEqual(["host-2", "proj-1", "bay-0"]);
        return {
          rows: [{ owning_bay_id: "bay-0" }],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    poolConnectMock = jest.fn(async () => ({
      query: queryMock,
      release: releaseMock,
    }));

    const { savePlacement } = await import("./control");
    await expect(savePlacement("proj-1", { host_id: "host-2" })).resolves.toBe(
      undefined,
    );
    expect(notifyProjectHostUpdateMock).toHaveBeenCalledWith({
      project_id: "proj-1",
      host_id: "host-2",
    });
  });

  it("falls back to the current rootfs binding when projects.rootfs_image is blank", async () => {
    const createProjectMock = jest.fn(async () => ({
      project_id: "proj-1",
      state: "opened",
    }));
    const startProjectMock = jest.fn(async () => ({
      project_id: "proj-1",
      state: "running",
    }));
    createHostControlClientMock = jest.fn(() => ({
      createProject: createProjectMock,
      startProject: startProjectMock,
    }));
    getCurrentProjectRootfsBindingMock = jest.fn(async () => ({
      image: "ghcr.io/example/current-rootfs:2026-04-12",
    }));

    let loadProjectCalls = 0;
    queryMock = jest.fn(async (sql: string, _params: any[]) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: null };
      }
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
        "SELECT title, users, rootfs_image as image, host_id, owning_bay_id, run_quota FROM projects WHERE project_id=$1"
      ) {
        loadProjectCalls += 1;
        return {
          rows: [
            {
              title: "OCI test",
              users: { owner: { group: "owner" } },
              image: "",
              host_id: loadProjectCalls === 1 ? null : "host-1",
              owning_bay_id: "bay-0",
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
              bay_id: "bay-0",
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
      if (sql.includes("SET state=$2::jsonb")) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("UPDATE projects AS projects")) {
        return {
          rows: [{ owning_bay_id: "bay-0" }],
        };
      }
      if (sql === "SELECT backup_repo_id FROM projects WHERE project_id=$1") {
        return { rows: [{ backup_repo_id: null }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    poolConnectMock = jest.fn(async () => ({
      query: queryMock,
      release: releaseMock,
    }));

    const { startProjectOnHost } = await import("./control");
    await startProjectOnHost("proj-1");

    expect(getCurrentProjectRootfsBindingMock).toHaveBeenCalledWith({
      project_id: "proj-1",
    });
    expect(startProjectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        image: "ghcr.io/example/current-rootfs:2026-04-12",
      }),
    );
  });

  it("falls back to the default project image when no rootfs metadata exists", async () => {
    const createProjectMock = jest.fn(async () => ({
      project_id: "proj-1",
      state: "opened",
    }));
    const startProjectMock = jest.fn(async () => ({
      project_id: "proj-1",
      state: "running",
    }));
    createHostControlClientMock = jest.fn(() => ({
      createProject: createProjectMock,
      startProject: startProjectMock,
    }));
    getCurrentProjectRootfsBindingMock = jest.fn(async () => undefined);

    let loadProjectCalls = 0;
    queryMock = jest.fn(async (sql: string, _params: any[]) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: null };
      }
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
        "SELECT title, users, rootfs_image as image, host_id, owning_bay_id, run_quota FROM projects WHERE project_id=$1"
      ) {
        loadProjectCalls += 1;
        return {
          rows: [
            {
              title: "OCI test",
              users: { owner: { group: "owner" } },
              image: "",
              host_id: loadProjectCalls === 1 ? null : "host-1",
              owning_bay_id: "bay-0",
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
              bay_id: "bay-0",
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
      if (sql.includes("SET state=$2::jsonb")) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("UPDATE projects AS projects")) {
        return {
          rows: [{ owning_bay_id: "bay-0" }],
        };
      }
      if (sql === "SELECT backup_repo_id FROM projects WHERE project_id=$1") {
        return { rows: [{ backup_repo_id: null }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    poolConnectMock = jest.fn(async () => ({
      query: queryMock,
      release: releaseMock,
    }));

    const { startProjectOnHost } = await import("./control");
    await startProjectOnHost("proj-1");

    expect(startProjectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        image: DEFAULT_PROJECT_IMAGE,
      }),
    );
  });
});
