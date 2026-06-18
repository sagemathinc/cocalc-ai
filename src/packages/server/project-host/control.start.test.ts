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
let assertCanRestoreProvisionedProjectStorageMock: jest.Mock;
let cancelStaleProjectStartLrosMock: jest.Mock;
let resolveMembershipForAccountMock: jest.Mock;
let countsTowardManagedCpuBudgetForHostMock: jest.Mock;
let isAdminMock: jest.Mock;
let interBayHostListMock: jest.Mock;
let interBayHostControlCreateProjectMock: jest.Mock;
let interBayHostControlStartProjectMock: jest.Mock;
let getLroMock: jest.Mock;

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

jest.mock("@cocalc/server/cluster-config", () => ({
  __esModule: true,
  getConfiguredClusterBayIdsForStaticEnumerationOnly: jest.fn(() => [
    "bay-0",
    "bay-9",
  ]),
}));

jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  __esModule: true,
  getInterBayBridge: jest.fn(() => ({
    hostConnection: jest.fn(() => ({
      list: (...args: any[]) => interBayHostListMock(...args),
    })),
    hostControl: jest.fn(() => ({
      createProject: (...args: any[]) =>
        interBayHostControlCreateProjectMock(...args),
      startProject: (...args: any[]) =>
        interBayHostControlStartProjectMock(...args),
    })),
  })),
}));

jest.mock("@cocalc/server/projects/rootfs-state", () => ({
  __esModule: true,
  getCurrentProjectRootfsBinding: (...args: any[]) =>
    getCurrentProjectRootfsBindingMock(...args),
}));

jest.mock("@cocalc/server/membership/project-limits", () => ({
  __esModule: true,
  assertCanRestoreProvisionedProjectStorage: (...args: any[]) =>
    assertCanRestoreProvisionedProjectStorageMock(...args),
}));

jest.mock("@cocalc/server/projects/start-lro-cleanup", () => ({
  __esModule: true,
  cancelStaleProjectStartLros: (...args: any[]) =>
    cancelStaleProjectStartLrosMock(...args),
}));

jest.mock("@cocalc/server/lro/lro-db", () => ({
  __esModule: true,
  getLro: (...args: any[]) => getLroMock(...args),
}));

jest.mock("@cocalc/server/membership/resolve", () => ({
  __esModule: true,
  resolveMembershipForAccount: (...args: any[]) =>
    resolveMembershipForAccountMock(...args),
}));

jest.mock("@cocalc/server/membership/managed-cpu-scope", () => ({
  __esModule: true,
  countsTowardManagedCpuBudgetForHost: (...args: any[]) =>
    countsTowardManagedCpuBudgetForHostMock(...args),
}));

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: any[]) => isAdminMock(...args),
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
    assertCanRestoreProvisionedProjectStorageMock = jest.fn(
      async () => undefined,
    );
    cancelStaleProjectStartLrosMock = jest.fn(async () => 0);
    resolveMembershipForAccountMock = jest.fn(async () => ({
      entitlements: { features: { project_host_tier: 0 } },
    }));
    countsTowardManagedCpuBudgetForHostMock = jest.fn(async () => true);
    isAdminMock = jest.fn(async () => false);
    interBayHostControlCreateProjectMock = jest.fn(async () => ({
      project_id: "proj-1",
      state: "opened",
    }));
    interBayHostControlStartProjectMock = jest.fn(async () => ({
      project_id: "proj-1",
      state: "running",
    }));
    getLroMock = jest.fn(async () => undefined);
    releaseMock = jest.fn();
    resolveHostBayMock = jest.fn(async (host_id: string) => ({
      bay_id: host_id === "host-2" ? "bay-7" : "bay-0",
      epoch: 0,
    }));
    interBayHostListMock = jest.fn(async () => []);
  });

  it("only uses shared pool hosts for automatic placement without an account", async () => {
    queryMock = jest.fn(async (sql: string, params: any[]) => {
      if (
        sql.includes("FROM project_hosts") &&
        sql.includes("WHERE status='running'")
      ) {
        expect(params).toEqual(["bay-0"]);
        return {
          rows: [
            {
              id: "private-host",
              bay_id: "bay-0",
              name: "Private Host",
              region: "us-west1",
              public_url: null,
              internal_url: null,
              ssh_server: null,
              tier: null,
              metadata: { owner: "owner-account", machine: {} },
              delegated_access_role: null,
            },
            {
              id: "pool-host",
              bay_id: "bay-0",
              name: "Pool Host",
              region: "us-west1",
              public_url: null,
              internal_url: null,
              ssh_server: null,
              tier: 0,
              metadata: { machine: {} },
              delegated_access_role: null,
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { selectActiveHost } = await import("./control");
    await expect(selectActiveHost({ bay_id: "bay-0" })).resolves.toMatchObject({
      id: "pool-host",
    });
    expect(resolveMembershipForAccountMock).not.toHaveBeenCalled();
  });

  it("filters automatic placement by account host access and membership tier", async () => {
    resolveMembershipForAccountMock = jest.fn(async () => ({
      entitlements: { features: { project_host_tier: 0 } },
    }));
    queryMock = jest.fn(async (sql: string, params: any[]) => {
      if (
        sql.includes("FROM project_hosts") &&
        sql.includes("WHERE status='running'")
      ) {
        expect(params).toEqual(["bay-0", "account-1"]);
        return {
          rows: [
            {
              id: "high-tier-host",
              bay_id: "bay-0",
              name: "High Tier Host",
              region: "us-west1",
              public_url: null,
              internal_url: null,
              ssh_server: null,
              tier: 2,
              metadata: { machine: {} },
              delegated_access_role: null,
            },
            {
              id: "owned-private-host",
              bay_id: "bay-0",
              name: "Owned Private Host",
              region: "us-west1",
              public_url: null,
              internal_url: null,
              ssh_server: null,
              tier: null,
              metadata: { owner: "account-1", machine: {} },
              delegated_access_role: null,
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { selectActiveHost } = await import("./control");
    await expect(
      selectActiveHost({ bay_id: "bay-0", account_id: "account-1" }),
    ).resolves.toMatchObject({
      id: "owned-private-host",
      tier: undefined,
    });
  });

  it("falls back to remote shared pool hosts for automatic placement", async () => {
    resolveMembershipForAccountMock = jest.fn(async () => ({
      entitlements: { features: { project_host_tier: 0 } },
    }));
    interBayHostListMock = jest.fn(async () => [
      {
        id: "remote-pool-host",
        bay_id: "bay-9",
        name: "Remote Pool Host",
        owner: "host-owner",
        region: "us-west1",
        size: "standard",
        gpu: false,
        status: "running",
        tier: 0,
        scope: "pool",
        access_role: "pool",
        can_place: true,
        pressure: { zone: "normal" },
      },
    ]);
    let placementQuery = 0;
    queryMock = jest.fn(async (sql: string, params: any[]) => {
      if (
        sql.includes("FROM project_hosts") &&
        sql.includes("WHERE status='running'")
      ) {
        placementQuery += 1;
        if (placementQuery === 1) {
          expect(params).toEqual(["bay-1", "account-1"]);
          expect(sql).toContain("COALESCE(bay_id");
          return {
            rows: [
              {
                id: "same-bay-other-region",
                bay_id: "bay-1",
                name: "Same Bay Other Region",
                region: "europe-west1",
                public_url: null,
                internal_url: null,
                ssh_server: null,
                tier: 0,
                metadata: { machine: {} },
                delegated_access_role: null,
              },
            ],
          };
        }
        expect(params).toEqual(["account-1"]);
        expect(sql).not.toContain("COALESCE(bay_id");
        expect(sql).toContain("tier IS NOT NULL");
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { selectActiveHost } = await import("./control");
    await expect(
      selectActiveHost({
        bay_id: "bay-1",
        account_id: "account-1",
        project_region: "wnam",
      }),
    ).resolves.toMatchObject({
      id: "remote-pool-host",
      bay_id: "bay-9",
      tier: 0,
    });
    expect(placementQuery).toBe(2);
    expect(interBayHostListMock).toHaveBeenCalledWith({
      account_id: "account-1",
      catalog: false,
    });
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
        "SELECT title, users, rootfs_image as image, host_id, region, owning_bay_id, run_quota FROM projects WHERE project_id=$1"
      ) {
        loadProjectCalls += 1;
        return {
          rows: [
            {
              title: "OCI test",
              users: { owner: { group: "owner" } },
              image: "sagemathinc/sagemath-x86_64:10.7",
              host_id: loadProjectCalls === 1 ? null : "host-1",
              region: "wnam",
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
      if (
        sql ===
        "SELECT backup_repo_id, provisioned FROM projects WHERE project_id=$1"
      ) {
        return { rows: [{ backup_repo_id: null, provisioned: true }] };
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
      ensure_volume: false,
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

  it("re-registers a project that already has an assigned host", async () => {
    const createProjectMock = jest.fn(async () => ({
      project_id: "proj-1",
      state: "opened",
    }));
    createHostControlClientMock = jest.fn(() => ({
      createProject: createProjectMock,
    }));

    queryMock = jest.fn(async (sql: string, params: any[]) => {
      if (
        sql ===
        "SELECT title, users, rootfs_image as image, host_id, region, owning_bay_id, run_quota FROM projects WHERE project_id=$1"
      ) {
        expect(params).toEqual(["proj-1"]);
        return {
          rows: [
            {
              title: "Already placed",
              users: { owner: { group: "owner" } },
              image: "cocalc.local/rootfs/course",
              host_id: "host-1",
              region: "wnam",
              owning_bay_id: "bay-0",
              run_quota: null,
            },
          ],
        };
      }
      if (
        sql ===
        "SELECT id, bay_id, name, region, public_url, internal_url, ssh_server, tier, metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL"
      ) {
        expect(params).toEqual(["host-1"]);
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
        expect(params).toEqual(["host-1"]);
        return { rows: [{ metadata: { machine: {} } }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { ensurePlacement } = await import("./control");
    await expect(ensurePlacement("proj-1", "account-1")).resolves.toEqual({
      host_id: "host-1",
    });

    expect(createProjectMock).toHaveBeenCalledWith({
      project_id: "proj-1",
      title: "Already placed",
      users: { owner: { group: "owner" } },
      image: "cocalc.local/rootfs/course",
      ensure_volume: false,
      start: false,
      authorized_keys: "ssh-ed25519 AAAATEST user@test",
      run_quota: {},
    });
  });

  it("passes account_id when automatic placement registers a project on a remote shared-pool host", async () => {
    let loadProjectCalls = 0;
    let placementQuery = 0;
    interBayHostListMock = jest.fn(async () => [
      {
        id: "host-2",
        bay_id: "bay-9",
        name: "Remote Pool Host",
        region: "wnam",
        public_url: null,
        internal_url: null,
        ssh_server: null,
        tier: 0,
        can_place: true,
        metadata: { machine: {} },
      },
    ]);
    queryMock = jest.fn(async (sql: string) => {
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
        "SELECT title, users, rootfs_image as image, host_id, region, owning_bay_id, run_quota FROM projects WHERE project_id=$1"
      ) {
        loadProjectCalls += 1;
        return {
          rows: [
            {
              title: "Remote placement",
              users: { owner: { group: "owner" } },
              image: "cocalc.local/rootfs/release",
              host_id: loadProjectCalls === 1 ? null : "host-2",
              region: "wnam",
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
        placementQuery += 1;
        return { rows: [] };
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
      if (
        sql ===
        "SELECT backup_repo_id, provisioned FROM projects WHERE project_id=$1"
      ) {
        return { rows: [{ backup_repo_id: null, provisioned: true }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    poolConnectMock = jest.fn(async () => ({
      query: queryMock,
      release: releaseMock,
    }));

    const { startProjectOnHost } = await import("./control");
    await startProjectOnHost("proj-1", {
      account_id: "account-1",
      lro_op_id: "op-1",
    });

    expect(placementQuery).toBe(2);
    expect(interBayHostControlCreateProjectMock).toHaveBeenCalledWith({
      account_id: "account-1",
      host_id: "host-2",
      create: {
        project_id: "proj-1",
        title: "Remote placement",
        users: { owner: { group: "owner" } },
        image: "cocalc.local/rootfs/release",
        start: false,
        ensure_volume: false,
        authorized_keys: "ssh-ed25519 AAAATEST user@test",
        run_quota: {},
      },
    });
    expect(interBayHostControlStartProjectMock).toHaveBeenCalledWith({
      host_id: "host-2",
      start: {
        project_id: "proj-1",
        authorized_keys: "ssh-ed25519 AAAATEST user@test",
        run_quota: {},
        image: "cocalc.local/rootfs/release",
        restore: "none",
        lro_op_id: "op-1",
      },
    });
  });

  it("forwards managed egress overrides when starting on a host", async () => {
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
        "SELECT title, users, rootfs_image as image, host_id, region, owning_bay_id, run_quota FROM projects WHERE project_id=$1"
      ) {
        loadProjectCalls += 1;
        return {
          rows: [
            {
              title: "OCI test",
              users: { owner: { group: "owner" } },
              image: "sagemathinc/sagemath-x86_64:10.7",
              host_id: loadProjectCalls === 1 ? null : "host-1",
              region: "wnam",
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
      if (
        sql ===
        "SELECT backup_repo_id, provisioned FROM projects WHERE project_id=$1"
      ) {
        return { rows: [{ backup_repo_id: null, provisioned: true }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    poolConnectMock = jest.fn(async () => ({
      query: queryMock,
      release: releaseMock,
    }));

    const { startProjectOnHost } = await import("./control");
    await startProjectOnHost("proj-1", {
      managed_egress_override: "admin-host-drain",
    });

    expect(startProjectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "proj-1",
        managed_egress_override: "admin-host-drain",
      }),
    );
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
        "SELECT title, users, rootfs_image as image, host_id, region, owning_bay_id, run_quota FROM projects WHERE project_id=$1"
      ) {
        loadProjectCalls += 1;
        return {
          rows: [
            {
              title: "OCI test",
              users: { owner: { group: "owner" } },
              image: "sagemathinc/sagemath-x86_64:10.7",
              host_id: loadProjectCalls === 1 ? null : "host-1",
              region: "wnam",
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
      if (
        sql ===
        "SELECT backup_repo_id, provisioned FROM projects WHERE project_id=$1"
      ) {
        return { rows: [{ backup_repo_id: null, provisioned: true }] };
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

  it("skips restart when the assigned host still reports the project running", async () => {
    const startProjectMock = jest.fn(async () => ({
      project_id: "proj-1",
      state: "running",
    }));
    const getProjectStatusMock = jest.fn(async () => ({
      project_id: "proj-1",
      state: "running",
    }));
    createHostControlClientMock = jest.fn(() => ({
      createProject: jest.fn(async () => ({ project_id: "proj-1" })),
      startProject: startProjectMock,
      getProjectStatus: getProjectStatusMock,
    }));

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
        "SELECT title, users, rootfs_image as image, host_id, region, owning_bay_id, run_quota FROM projects WHERE project_id=$1"
      ) {
        expect(params).toEqual(["proj-1"]);
        return {
          rows: [
            {
              title: "Existing project",
              users: { owner: { group: "owner" } },
              image: "sagemathinc/sagemath-x86_64:10.7",
              host_id: "host-1",
              region: "wnam",
              owning_bay_id: "bay-0",
              run_quota: null,
            },
          ],
        };
      }
      if (sql === "SELECT host_id FROM projects WHERE project_id=$1") {
        expect(params).toEqual(["proj-1"]);
        return { rows: [{ host_id: "host-1" }] };
      }
      if (
        sql ===
        "SELECT id, bay_id, name, region, public_url, internal_url, ssh_server, tier, metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL"
      ) {
        expect(params).toEqual(["host-1"]);
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
        expect(params).toEqual(["host-1"]);
        return { rows: [{ metadata: { machine: {} } }] };
      }
      if (
        sql ===
        "SELECT backup_repo_id, provisioned FROM projects WHERE project_id=$1"
      ) {
        expect(params).toEqual(["proj-1"]);
        return { rows: [{ backup_repo_id: null, provisioned: true }] };
      }
      if (sql.includes("SET state=$2::jsonb")) {
        expect(params[0]).toBe("proj-1");
        expect(params[1]).toMatchObject({ state: "running" });
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    poolConnectMock = jest.fn(async () => ({
      query: queryMock,
      release: releaseMock,
    }));

    const { startProjectOnHost } = await import("./control");
    await startProjectOnHost("proj-1");

    expect(getProjectStatusMock).toHaveBeenCalledWith({
      project_id: "proj-1",
    });
    expect(startProjectMock).not.toHaveBeenCalled();
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
        "SELECT title, users, rootfs_image as image, host_id, region, owning_bay_id, run_quota FROM projects WHERE project_id=$1"
      ) {
        loadProjectCalls += 1;
        return {
          rows: [
            {
              title: "OCI test",
              users: { owner: { group: "owner" } },
              image: "",
              host_id: loadProjectCalls === 1 ? null : "host-1",
              region: "wnam",
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
      if (
        sql ===
        "SELECT backup_repo_id, provisioned FROM projects WHERE project_id=$1"
      ) {
        return { rows: [{ backup_repo_id: null, provisioned: true }] };
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
        "SELECT title, users, rootfs_image as image, host_id, region, owning_bay_id, run_quota FROM projects WHERE project_id=$1"
      ) {
        loadProjectCalls += 1;
        return {
          rows: [
            {
              title: "OCI test",
              users: { owner: { group: "owner" } },
              image: "",
              host_id: loadProjectCalls === 1 ? null : "host-1",
              region: "wnam",
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
      if (
        sql ===
        "SELECT backup_repo_id, provisioned FROM projects WHERE project_id=$1"
      ) {
        return { rows: [{ backup_repo_id: null, provisioned: true }] };
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

  it("checks restore storage headroom before auto-restoring an unprovisioned project", async () => {
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
        "SELECT title, users, rootfs_image as image, host_id, region, owning_bay_id, run_quota FROM projects WHERE project_id=$1"
      ) {
        loadProjectCalls += 1;
        return {
          rows: [
            {
              title: "Archived test",
              users: { owner: { group: "owner" } },
              image: "sagemathinc/sagemath-x86_64:10.7",
              host_id: loadProjectCalls === 1 ? null : "host-1",
              region: "wnam",
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
        expect(params).toEqual(["host-1", "proj-1", "bay-0"]);
        return {
          rows: [{ owning_bay_id: "bay-0" }],
        };
      }
      if (
        sql ===
        "SELECT backup_repo_id, provisioned FROM projects WHERE project_id=$1"
      ) {
        return { rows: [{ backup_repo_id: "repo-1", provisioned: false }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    poolConnectMock = jest.fn(async () => ({
      query: queryMock,
      release: releaseMock,
    }));

    const { startProjectOnHost } = await import("./control");
    await startProjectOnHost("proj-1");

    expect(assertCanRestoreProvisionedProjectStorageMock).toHaveBeenCalledWith({
      project_id: "proj-1",
    });
    expect(startProjectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        restore: "auto",
      }),
    );
  });

  it("passes an explicit restore backup id to host start", async () => {
    const startProjectMock = jest.fn(async () => ({
      project_id: "proj-1",
      state: "running",
      phase_timings_ms: { runner_start: 1234 },
    }));
    createHostControlClientMock = jest.fn(() => ({
      createProject: jest.fn(async () => ({ project_id: "proj-1" })),
      startProject: startProjectMock,
      getProjectStatus: jest.fn(async () => ({ state: "stopped" })),
    }));

    queryMock = jest.fn(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: null };
      }
      if (sql === "SELECT state FROM projects WHERE project_id=$1") {
        return {
          rows: [{ state: { state: "stopped", time: "2026-03-29T00:00:00Z" } }],
        };
      }
      if (
        sql ===
        "SELECT title, users, rootfs_image as image, host_id, region, owning_bay_id, run_quota FROM projects WHERE project_id=$1"
      ) {
        return {
          rows: [
            {
              title: "Restore test",
              users: { owner: { group: "owner" } },
              image: DEFAULT_PROJECT_IMAGE,
              host_id: "host-1",
              region: "wnam",
              owning_bay_id: "bay-0",
              run_quota: null,
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
      if (
        sql ===
        "SELECT id, bay_id, name, region, public_url, internal_url, ssh_server, tier, metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL"
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
        "SELECT backup_repo_id, provisioned FROM projects WHERE project_id=$1"
      ) {
        return { rows: [{ backup_repo_id: "repo-1", provisioned: true }] };
      }
      if (sql.includes("SET state=$2::jsonb")) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("UPDATE projects SET last_started")) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    poolConnectMock = jest.fn(async () => ({
      query: queryMock,
      release: releaseMock,
    }));

    const { startProjectOnHost } = await import("./control");
    await startProjectOnHost("proj-1", {
      restore_backup_id: "backup-explicit",
    });

    expect(startProjectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        restore: "auto",
        restore_backup_id: "backup-explicit",
      }),
    );
  });

  it("does not skip restart when an explicit restore backup id is requested", async () => {
    const startProjectMock = jest.fn(async () => ({
      project_id: "proj-1",
      state: "running",
      phase_timings_ms: { runner_start: 1234 },
    }));
    const getProjectStatusMock = jest.fn(async () => ({
      project_id: "proj-1",
      state: "running",
    }));
    createHostControlClientMock = jest.fn(() => ({
      createProject: jest.fn(async () => ({ project_id: "proj-1" })),
      startProject: startProjectMock,
      getProjectStatus: getProjectStatusMock,
    }));

    queryMock = jest.fn(async (sql: string) => {
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
        "SELECT title, users, rootfs_image as image, host_id, region, owning_bay_id, run_quota FROM projects WHERE project_id=$1"
      ) {
        return {
          rows: [
            {
              title: "Restore retry test",
              users: { owner: { group: "owner" } },
              image: DEFAULT_PROJECT_IMAGE,
              host_id: "host-1",
              region: "wnam",
              owning_bay_id: "bay-0",
              run_quota: null,
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
      if (
        sql ===
        "SELECT id, bay_id, name, region, public_url, internal_url, ssh_server, tier, metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL"
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
        "SELECT backup_repo_id, provisioned FROM projects WHERE project_id=$1"
      ) {
        return { rows: [{ backup_repo_id: "repo-1", provisioned: true }] };
      }
      if (sql.includes("SET state=$2::jsonb")) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("UPDATE projects SET last_started")) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    poolConnectMock = jest.fn(async () => ({
      query: queryMock,
      release: releaseMock,
    }));

    const { startProjectOnHost } = await import("./control");
    await startProjectOnHost("proj-1", {
      restore_backup_id: "backup-explicit",
    });

    expect(getProjectStatusMock).toHaveBeenCalledWith({
      project_id: "proj-1",
    });
    expect(startProjectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        restore: "auto",
        restore_backup_id: "backup-explicit",
      }),
    );
  });

  it("replaces an in-memory start when its lro was canceled", async () => {
    let resolveSecondStart: ((value: any) => void) | undefined;
    const firstStart = new Promise(() => undefined);
    const secondStart = new Promise((resolve) => {
      resolveSecondStart = resolve;
    });
    const startProjectMock = jest
      .fn()
      .mockReturnValueOnce(firstStart)
      .mockReturnValueOnce(secondStart);
    createHostControlClientMock = jest.fn(() => ({
      createProject: jest.fn(async () => ({ project_id: "proj-1" })),
      startProject: startProjectMock,
      getProjectStatus: jest.fn(async () => ({ state: "stopped" })),
    }));
    getLroMock = jest.fn(async () => ({
      op_id: "old-op",
      status: "canceled",
    }));

    queryMock = jest.fn(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: null };
      }
      if (sql === "SELECT state FROM projects WHERE project_id=$1") {
        return {
          rows: [{ state: { state: "opened", time: "2026-03-29T00:00:00Z" } }],
        };
      }
      if (
        sql ===
        "SELECT title, users, rootfs_image as image, host_id, region, owning_bay_id, run_quota FROM projects WHERE project_id=$1"
      ) {
        return {
          rows: [
            {
              title: "Retry test",
              users: { owner: { group: "owner" } },
              image: DEFAULT_PROJECT_IMAGE,
              host_id: "host-1",
              region: "wnam",
              owning_bay_id: "bay-0",
              run_quota: null,
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
      if (
        sql ===
        "SELECT id, bay_id, name, region, public_url, internal_url, ssh_server, tier, metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL"
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
        "SELECT backup_repo_id, provisioned FROM projects WHERE project_id=$1"
      ) {
        return { rows: [{ backup_repo_id: null, provisioned: true }] };
      }
      if (sql.includes("SET state=$2::jsonb")) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("UPDATE projects SET last_started")) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    poolConnectMock = jest.fn(async () => ({
      query: queryMock,
      release: releaseMock,
    }));

    const { startProjectOnHost } = await import("./control");
    void startProjectOnHost("proj-1", { lro_op_id: "old-op" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(startProjectMock).toHaveBeenCalledTimes(1);

    const retry = startProjectOnHost("proj-1", { lro_op_id: "new-op" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(getLroMock).toHaveBeenCalledWith("old-op");
    expect(startProjectMock).toHaveBeenCalledTimes(2);

    resolveSecondStart?.({
      project_id: "proj-1",
      state: "running",
      phase_timings_ms: { runner_start: 1234 },
    });
    await retry;
  });
});
