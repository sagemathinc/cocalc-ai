export {};

import { EventEmitter } from "node:events";
import os from "node:os";

let spawnMock: jest.Mock;
let queryMock: jest.Mock;
let isAdminMock: jest.Mock;
let isBannedMock: jest.Mock;
let moveProjectToHostMock: jest.Mock;
let resolveMembershipForAccountMock: jest.Mock;
let loadProjectHostMetricsHistoryMock: jest.Mock;
let syncProjectUsersOnHostMock: jest.Mock;
let issueProjectHostAuthTokenJwtMock: jest.Mock;
let assertAccountProjectHostTokenProjectAccessMock: jest.Mock;
let assertProjectHostAgentTokenAccessMock: jest.Mock;
let hasAccountProjectHostTokenHostAccessMock: jest.Mock;
let resolveProjectBayMock: jest.Mock;
let resolveHostBayMock: jest.Mock;
let hostConnectionGetMock: jest.Mock;
let projectHostAuthTokenIssueMock: jest.Mock;
let projectReferenceGetMock: jest.Mock;
let routedHostControlClientMock: jest.Mock;
let listProjectHostRuntimeDeploymentsMock: jest.Mock;
let loadEffectiveProjectHostRuntimeDeploymentsMock: jest.Mock;
let setProjectHostRuntimeDeploymentsMock: jest.Mock;
let updateProjectUsersMock: jest.Mock;
let createLroMock: jest.Mock;
let createProjectHostBootstrapTokenMock: jest.Mock;
let buildCloudInitStartupScriptMock: jest.Mock;
let siteUrlMock: jest.Mock;

jest.mock("node:child_process", () => {
  const actual = jest.requireActual("node:child_process");
  return {
    __esModule: true,
    ...actual,
    spawn: (...args: any[]) => spawnMock(...args),
  };
});

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: queryMock })),
}));

jest.mock("@cocalc/server/lro/lro-db", () => ({
  __esModule: true,
  claimLroOps: jest.fn(async () => []),
  createLro: (...args: any[]) => createLroMock(...args),
  getLro: jest.fn(async () => null),
  touchLro: jest.fn(async () => undefined),
  updateLro: jest.fn(async () => null),
}));

jest.mock("@cocalc/server/lro/stream", () => ({
  __esModule: true,
  publishLroEvent: jest.fn(async () => undefined),
  publishLroSummary: jest.fn(async () => undefined),
}));

jest.mock("@cocalc/backend/logger", () => {
  const factory = () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  });
  return {
    __esModule: true,
    default: factory,
    getLogger: factory,
  };
});

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: any[]) => isAdminMock(...args),
}));

jest.mock("@cocalc/server/accounts/is-banned", () => ({
  __esModule: true,
  default: (...args: any[]) => isBannedMock(...args),
}));

jest.mock("@cocalc/server/projects/move", () => ({
  __esModule: true,
  moveProjectToHost: (...args: any[]) => moveProjectToHostMock(...args),
}));

jest.mock("@cocalc/server/membership/resolve", () => ({
  __esModule: true,
  resolveMembershipForAccount: (...args: any[]) =>
    resolveMembershipForAccountMock(...args),
}));

jest.mock("@cocalc/database/postgres/project-host-metrics", () => ({
  __esModule: true,
  clearProjectHostMetrics: jest.fn(async () => undefined),
  loadProjectHostMetricsHistory: (...args: any[]) =>
    loadProjectHostMetricsHistoryMock(...args),
}));

jest.mock("@cocalc/database/postgres/project-host-runtime-deployments", () => ({
  __esModule: true,
  listProjectHostRuntimeDeployments: (...args: any[]) =>
    listProjectHostRuntimeDeploymentsMock(...args),
  loadEffectiveProjectHostRuntimeDeployments: (...args: any[]) =>
    loadEffectiveProjectHostRuntimeDeploymentsMock(...args),
  setProjectHostRuntimeDeployments: (...args: any[]) =>
    setProjectHostRuntimeDeploymentsMock(...args),
}));

jest.mock("@cocalc/backend/data", () => {
  const actual = jest.requireActual("@cocalc/backend/data");
  return {
    __esModule: true,
    ...actual,
    getProjectHostAuthTokenPrivateKey: jest.fn(() => "test-private-key"),
  };
});

jest.mock("@cocalc/server/project-host/control", () => ({
  __esModule: true,
  syncProjectUsersOnHost: (...args: any[]) =>
    syncProjectUsersOnHostMock(...args),
}));

jest.mock("@cocalc/server/project-host/bootstrap-token", () => ({
  __esModule: true,
  createProjectHostBootstrapToken: (...args: any[]) =>
    createProjectHostBootstrapTokenMock(...args),
  revokeProjectHostTokensForHost: jest.fn(async () => undefined),
}));

jest.mock("@cocalc/server/cloud/bootstrap-host", () => ({
  __esModule: true,
  buildCloudInitStartupScript: (...args: any[]) =>
    buildCloudInitStartupScriptMock(...args),
}));

jest.mock("@cocalc/database/settings/site-url", () => ({
  __esModule: true,
  default: (...args: any[]) => siteUrlMock(...args),
}));

jest.mock("@cocalc/server/project-host/client", () => ({
  __esModule: true,
  getRoutedHostControlClient: (...args: any[]) =>
    routedHostControlClientMock(...args),
}));

jest.mock("@cocalc/conat/auth/project-host-token", () => ({
  __esModule: true,
  issueProjectHostAuthToken: (...args: any[]) =>
    issueProjectHostAuthTokenJwtMock(...args),
}));

jest.mock("./project-host-token-auth", () => ({
  __esModule: true,
  assertAccountProjectHostTokenProjectAccess: (...args: any[]) =>
    assertAccountProjectHostTokenProjectAccessMock(...args),
  assertProjectHostAgentTokenAccess: (...args: any[]) =>
    assertProjectHostAgentTokenAccessMock(...args),
  hasAccountProjectHostTokenHostAccess: (...args: any[]) =>
    hasAccountProjectHostTokenHostAccessMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/directory", () => ({
  __esModule: true,
  resolveProjectBay: (...args: any[]) => resolveProjectBayMock(...args),
  resolveHostBay: (...args: any[]) => resolveHostBayMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  __esModule: true,
  getInterBayBridge: jest.fn(() => ({
    hostConnection: jest.fn(() => ({
      get: (...args: any[]) => hostConnectionGetMock(...args),
    })),
    projectReference: jest.fn(() => ({
      get: (...args: any[]) => projectReferenceGetMock(...args),
    })),
    projectHostAuthToken: jest.fn(() => ({
      issue: (...args: any[]) => projectHostAuthTokenIssueMock(...args),
    })),
  })),
}));

const HOST_ID = "host-123";
const ACCOUNT_ID = "acct-123";

beforeEach(() => {
  createLroMock = jest.fn(async (opts: any) => ({
    op_id: "op-123",
    kind: opts.kind,
    scope_type: opts.scope_type,
    scope_id: opts.scope_id,
    status: opts.status ?? "queued",
    created_by: opts.created_by ?? null,
    owner_type: opts.owner_type ?? "hub",
    owner_id: opts.owner_id ?? null,
    routing: opts.routing ?? "hub",
    input: opts.input ?? null,
  }));
  spawnMock = jest.fn(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { end: (input?: string) => void };
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      end: () => {
        setImmediate(() => child.emit("close", 0));
      },
    };
    return child;
  });
  createProjectHostBootstrapTokenMock = jest.fn(async () => ({
    token: "bootstrap-token",
  }));
  buildCloudInitStartupScriptMock = jest.fn(
    async () => "#!/usr/bin/env bash\necho bootstrap\n",
  );
  siteUrlMock = jest.fn(async () => "https://hub.example.test");
});

const SUMMARY_ROW = {
  host_id: HOST_ID,
  total: "3",
  provisioned: "2",
  running: "1",
  provisioned_up_to_date: "1",
  provisioned_needs_backup: "1",
};

const PROJECT_ROWS_PAGE_1 = [
  {
    project_id: "proj-3",
    title: "Gamma",
    state: "running",
    provisioned: true,
    last_edited: new Date("2026-01-03T00:00:00Z"),
    last_backup: new Date("2026-01-02T00:00:00Z"),
    needs_backup: true,
    collab_count: "2",
  },
  {
    project_id: "proj-2",
    title: "Beta",
    state: "off",
    provisioned: true,
    last_edited: new Date("2026-01-02T00:00:00Z"),
    last_backup: new Date("2026-01-01T00:00:00Z"),
    needs_backup: true,
    collab_count: "1",
  },
  {
    project_id: "proj-1",
    title: "Alpha",
    state: "off",
    provisioned: false,
    last_edited: new Date("2026-01-01T00:00:00Z"),
    last_backup: null,
    needs_backup: false,
    collab_count: "3",
  },
];

const PROJECT_ROWS_PAGE_2 = [
  {
    project_id: "proj-0",
    title: "Delta",
    state: "off",
    provisioned: true,
    last_edited: new Date("2026-01-01T00:00:00Z"),
    last_backup: new Date("2026-01-01T00:00:00Z"),
    needs_backup: false,
    collab_count: "0",
  },
];

describe("hosts.listHostProjects", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.LOGS = os.tmpdir();
    isAdminMock = jest.fn(async () => true);
    isBannedMock = jest.fn(async () => false);
    moveProjectToHostMock = jest.fn();
    resolveMembershipForAccountMock = jest.fn(async () => ({
      entitlements: {},
    }));
    loadProjectHostMetricsHistoryMock = jest.fn(async () => new Map());
    syncProjectUsersOnHostMock = jest.fn(async () => undefined);
    issueProjectHostAuthTokenJwtMock = jest.fn(() => ({
      token: "test-token",
      expires_at: 1234567890,
    }));
    assertAccountProjectHostTokenProjectAccessMock = jest.fn(
      async () => undefined,
    );
    assertProjectHostAgentTokenAccessMock = jest.fn(async () => undefined);
    hasAccountProjectHostTokenHostAccessMock = jest.fn(async () => false);
    resolveProjectBayMock = jest.fn(async () => ({
      bay_id: "bay-0",
      epoch: 1,
    }));
    resolveHostBayMock = jest.fn(async () => ({
      bay_id: "bay-0",
      epoch: 1,
    }));
    hostConnectionGetMock = jest.fn();
    projectHostAuthTokenIssueMock = jest.fn();
    projectReferenceGetMock = jest.fn(async () => null);
    listProjectHostRuntimeDeploymentsMock = jest.fn(async () => []);
    loadEffectiveProjectHostRuntimeDeploymentsMock = jest.fn(async () => []);
    setProjectHostRuntimeDeploymentsMock = jest.fn(async () => []);
    updateProjectUsersMock = jest.fn(async () => undefined);
    routedHostControlClientMock = jest.fn(async () => ({
      updateProjectUsers: (...args: any[]) => updateProjectUsersMock(...args),
    }));
    queryMock = jest.fn(async (sql: string, params: any[]) => {
      if (sql.includes("FROM project_hosts")) {
        return {
          rows: [
            {
              id: HOST_ID,
              metadata: { owner: ACCOUNT_ID },
              last_seen: new Date("2026-01-05T00:00:00Z"),
            },
          ],
        };
      }
      if (sql.includes("COUNT(*) AS total")) {
        return { rows: [SUMMARY_ROW] };
      }
      if (sql.includes("LEFT(COALESCE(title")) {
        if (params.length === 2) {
          return { rows: PROJECT_ROWS_PAGE_1 };
        }
        if (params.length === 4) {
          return { rows: PROJECT_ROWS_PAGE_2 };
        }
      }
      throw new Error(`unexpected query: ${sql}`);
    });
  });

  it("paginates with cursor", async () => {
    const { listHostProjects } = await import("./hosts");
    const first = await listHostProjects({
      account_id: ACCOUNT_ID,
      id: HOST_ID,
      limit: 2,
    });
    expect(first.rows).toHaveLength(2);
    expect(first.next_cursor).toBeDefined();
    const second = await listHostProjects({
      account_id: ACCOUNT_ID,
      id: HOST_ID,
      limit: 2,
      cursor: first.next_cursor,
    });
    expect(second.rows).toHaveLength(1);
    expect(second.next_cursor).toBeUndefined();
  });

  it("adds the risk filter when requested", async () => {
    const listSqls: string[] = [];
    queryMock.mockImplementation(async (sql: string, _params: any[]) => {
      if (sql.includes("FROM project_hosts")) {
        return {
          rows: [
            {
              id: HOST_ID,
              metadata: { owner: ACCOUNT_ID },
            },
          ],
        };
      }
      if (sql.includes("COUNT(*) AS total")) {
        return { rows: [SUMMARY_ROW] };
      }
      if (sql.includes("LEFT(COALESCE(title")) {
        listSqls.push(sql);
        return { rows: PROJECT_ROWS_PAGE_1.slice(0, 1) };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { listHostProjects } = await import("./hosts");
    await listHostProjects({
      account_id: ACCOUNT_ID,
      id: HOST_ID,
      limit: 1,
      risk_only: false,
    });
    await listHostProjects({
      account_id: ACCOUNT_ID,
      id: HOST_ID,
      limit: 1,
      risk_only: true,
    });
    const [baseSql, riskSql] = listSqls;
    expect(baseSql).toBeDefined();
    expect(riskSql).toBeDefined();
    const baseCount = (baseSql.match(/last_backup IS NULL/g) || []).length;
    const riskCount = (riskSql.match(/last_backup IS NULL/g) || []).length;
    expect(riskCount).toBeGreaterThan(baseCount);
  });

  afterEach(() => {
    delete process.env.LOGS;
  });
});

describe("hosts.getHostRuntimeDeploymentStatus", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.LOGS = os.tmpdir();
    isAdminMock = jest.fn(async () => true);
    isBannedMock = jest.fn(async () => false);
    moveProjectToHostMock = jest.fn();
    resolveMembershipForAccountMock = jest.fn(async () => ({
      entitlements: {},
    }));
    loadProjectHostMetricsHistoryMock = jest.fn(async () => new Map());
    syncProjectUsersOnHostMock = jest.fn(async () => undefined);
    issueProjectHostAuthTokenJwtMock = jest.fn(() => ({
      token: "test-token",
      expires_at: 1234567890,
    }));
    assertAccountProjectHostTokenProjectAccessMock = jest.fn(
      async () => undefined,
    );
    assertProjectHostAgentTokenAccessMock = jest.fn(async () => undefined);
    hasAccountProjectHostTokenHostAccessMock = jest.fn(async () => false);
    resolveProjectBayMock = jest.fn(async () => ({
      bay_id: "bay-0",
      epoch: 1,
    }));
    resolveHostBayMock = jest.fn(async () => ({
      bay_id: "bay-0",
      epoch: 1,
    }));
    hostConnectionGetMock = jest.fn();
    projectHostAuthTokenIssueMock = jest.fn();
    projectReferenceGetMock = jest.fn(async () => null);
    listProjectHostRuntimeDeploymentsMock = jest.fn(async () => [
      {
        scope_type: "host",
        scope_id: HOST_ID,
        host_id: HOST_ID,
        target_type: "artifact",
        target: "project-host",
        desired_version: "ph-v3",
        requested_by: ACCOUNT_ID,
        requested_at: "2026-04-15T00:00:00.000Z",
        updated_at: "2026-04-15T00:00:00.000Z",
      },
      {
        scope_type: "host",
        scope_id: HOST_ID,
        host_id: HOST_ID,
        target_type: "component",
        target: "acp-worker",
        desired_version: "ph-v2",
        rollout_policy: "drain_then_replace",
        requested_by: ACCOUNT_ID,
        requested_at: "2026-04-15T00:00:00.000Z",
        updated_at: "2026-04-15T00:00:00.000Z",
      },
    ]);
    loadEffectiveProjectHostRuntimeDeploymentsMock = jest.fn(async () =>
      listProjectHostRuntimeDeploymentsMock(),
    );
    setProjectHostRuntimeDeploymentsMock = jest.fn(async ({ deployments }) =>
      deployments.map((deployment: any) => ({
        scope_type: "host",
        scope_id: HOST_ID,
        host_id: HOST_ID,
        requested_by: ACCOUNT_ID,
        requested_at: "2026-04-15T00:00:00.000Z",
        updated_at: "2026-04-15T00:00:00.000Z",
        ...deployment,
      })),
    );
    updateProjectUsersMock = jest.fn(async () => undefined);
    routedHostControlClientMock = jest.fn(async () => ({
      upgradeSoftware: async () => ({ results: [] }),
      rolloutManagedComponents: async ({ components }: any) => ({
        results: components.map((component: string) => ({
          component,
          action: "spawned",
        })),
      }),
      getManagedComponentStatus: async () => [
        {
          component: "acp-worker",
          artifact: "project-host",
          upgrade_policy: "drain_then_replace",
          enabled: true,
          managed: true,
          desired_version: "build-ph-v2",
          runtime_state: "running",
          version_state: "aligned",
          running_versions: ["build-ph-v2"],
          running_pids: [4321],
        },
      ],
      getInstalledRuntimeArtifacts: async () => [
        {
          artifact: "project-host",
          current_version: "ph-v2",
          current_build_id: "build-ph-v2",
          installed_versions: ["ph-v2", "ph-v1"],
        },
        {
          artifact: "project-bundle",
          current_version: "bundle-v4",
          current_build_id: "build-bundle-v4",
          installed_versions: ["bundle-v4"],
        },
        {
          artifact: "tools",
          current_version: "tools-v7",
          installed_versions: ["tools-v7"],
        },
      ],
    }));
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("FROM project_hosts")) {
        return {
          rows: [
            {
              id: HOST_ID,
              status: "running",
              metadata: {
                owner: ACCOUNT_ID,
                software: {
                  project_host: "ph-v2",
                  project_host_build_id: "build-ph-v2",
                  project_bundle: "bundle-v4",
                  project_bundle_build_id: "build-bundle-v4",
                  tools: "tools-v7",
                },
                runtime_deployments: {
                  last_known_good_versions: {
                    "project-host": "ph-v0",
                  },
                },
              },
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
  });

  it("tracks observed artifact inventory and compares artifact targets", async () => {
    const { getHostRuntimeDeploymentStatus } = await import("./hosts");
    const status = await getHostRuntimeDeploymentStatus({
      account_id: ACCOUNT_ID,
      id: HOST_ID,
    });
    expect(status.observed_artifacts).toEqual([
      {
        artifact: "project-bundle",
        current_version: "bundle-v4",
        current_build_id: "build-bundle-v4",
        installed_versions: ["bundle-v4"],
      },
      {
        artifact: "project-host",
        current_version: "ph-v2",
        current_build_id: "build-ph-v2",
        installed_versions: ["ph-v2", "ph-v1"],
      },
      {
        artifact: "tools",
        current_version: "tools-v7",
        installed_versions: ["tools-v7"],
      },
    ]);
    expect(status.observed_targets).toEqual([
      expect.objectContaining({
        target_type: "artifact",
        target: "project-host",
        desired_version: "ph-v3",
        observed_version_state: "missing",
        current_version: "ph-v2",
        installed_versions: ["ph-v2", "ph-v1"],
      }),
      expect.objectContaining({
        target_type: "component",
        target: "acp-worker",
        desired_version: "ph-v2",
        observed_version_state: "aligned",
      }),
    ]);
    expect(status.rollback_targets).toEqual([
      {
        target_type: "artifact",
        target: "project-host",
        artifact: "project-host",
        desired_version: "ph-v3",
        current_version: "ph-v2",
        previous_version: "ph-v1",
        last_known_good_version: "ph-v0",
        retained_versions: ["ph-v2", "ph-v1"],
      },
      {
        target_type: "component",
        target: "acp-worker",
        artifact: "project-host",
        desired_version: "ph-v2",
        current_version: "ph-v2",
        previous_version: "ph-v1",
        last_known_good_version: "ph-v0",
        retained_versions: ["ph-v2", "ph-v1"],
      },
    ]);
    expect(status.observation_error).toBeUndefined();
  });

  it("rolls back a component target to an explicit version and reconciles it", async () => {
    const { rollbackHostRuntimeDeploymentsInternal } = await import("./hosts");
    const result = await rollbackHostRuntimeDeploymentsInternal({
      account_id: ACCOUNT_ID,
      id: HOST_ID,
      target_type: "component",
      target: "acp-worker",
      version: "ph-v2",
      reason: "test rollback",
    });
    expect(result).toMatchObject({
      host_id: HOST_ID,
      target_type: "component",
      target: "acp-worker",
      artifact: "project-host",
      rollback_version: "ph-v2",
      rollback_source: "explicit_version",
      deployment: {
        target_type: "component",
        target: "acp-worker",
        desired_version: "ph-v2",
      },
    });
    expect(setProjectHostRuntimeDeploymentsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        scope_type: "host",
        host_id: HOST_ID,
        deployments: [
          expect.objectContaining({
            target_type: "component",
            target: "acp-worker",
            desired_version: "ph-v2",
            rollout_reason: "test rollback",
          }),
        ],
      }),
    );
    expect(result.reconcile_result).toMatchObject({
      host_id: HOST_ID,
    });
  });
});

describe("hosts.setHostRuntimeDeployments automatic reconcile", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.LOGS = os.tmpdir();
    isAdminMock = jest.fn(async () => true);
    isBannedMock = jest.fn(async () => false);
    moveProjectToHostMock = jest.fn();
    resolveMembershipForAccountMock = jest.fn(async () => ({
      entitlements: {},
    }));
    loadProjectHostMetricsHistoryMock = jest.fn(async () => new Map());
    syncProjectUsersOnHostMock = jest.fn(async () => undefined);
    issueProjectHostAuthTokenJwtMock = jest.fn(() => ({
      token: "test-token",
      expires_at: 1234567890,
    }));
    assertAccountProjectHostTokenProjectAccessMock = jest.fn(
      async () => undefined,
    );
    assertProjectHostAgentTokenAccessMock = jest.fn(async () => undefined);
    hasAccountProjectHostTokenHostAccessMock = jest.fn(async () => false);
    resolveProjectBayMock = jest.fn(async () => ({
      bay_id: "bay-0",
      epoch: 1,
    }));
    resolveHostBayMock = jest.fn(async () => ({
      bay_id: "bay-0",
      epoch: 1,
    }));
    hostConnectionGetMock = jest.fn();
    projectHostAuthTokenIssueMock = jest.fn();
    projectReferenceGetMock = jest.fn(async () => null);
    listProjectHostRuntimeDeploymentsMock = jest.fn(async () => []);
    loadEffectiveProjectHostRuntimeDeploymentsMock = jest.fn(async () => [
      {
        scope_type: "host",
        scope_id: HOST_ID,
        host_id: HOST_ID,
        target_type: "component",
        target: "acp-worker",
        desired_version: "ph-v2",
        rollout_policy: "drain_then_replace",
        requested_by: ACCOUNT_ID,
        requested_at: "2026-04-15T00:00:00.000Z",
        updated_at: "2026-04-15T00:00:00.000Z",
      },
    ]);
    setProjectHostRuntimeDeploymentsMock = jest.fn(async ({ deployments }) =>
      deployments.map((deployment: any) => ({
        scope_type: "host",
        scope_id: HOST_ID,
        host_id: HOST_ID,
        requested_by: ACCOUNT_ID,
        requested_at: "2026-04-15T00:00:00.000Z",
        updated_at: "2026-04-15T00:00:00.000Z",
        ...deployment,
      })),
    );
    updateProjectUsersMock = jest.fn(async () => undefined);
    routedHostControlClientMock = jest.fn(async () => ({
      getManagedComponentStatus: async () => [
        {
          component: "acp-worker",
          artifact: "project-host",
          upgrade_policy: "drain_then_replace",
          enabled: true,
          managed: true,
          desired_version: "ph-v2",
          runtime_state: "running",
          version_state: "drifted",
          running_versions: ["ph-v1"],
          running_pids: [4321],
        },
      ],
      getInstalledRuntimeArtifacts: async () => [
        {
          artifact: "project-host",
          current_version: "ph-v2",
          current_build_id: "build-ph-v2",
          installed_versions: ["ph-v2", "ph-v1"],
        },
      ],
      updateProjectUsers: (...args: any[]) => updateProjectUsersMock(...args),
    }));
    queryMock = jest.fn(async (sql: string, _params: any[]) => {
      if (
        sql.includes(
          "SELECT id FROM project_hosts WHERE deleted IS NULL AND LOWER(COALESCE(status, '')) = ANY",
        )
      ) {
        return { rows: [{ id: HOST_ID }] };
      }
      if (sql.includes("FROM project_hosts")) {
        return {
          rows: [
            {
              id: HOST_ID,
              status: "running",
              metadata: {
                owner: ACCOUNT_ID,
                software: {
                  project_host: "ph-v2",
                },
              },
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
  });

  it("queues automatic reconcile for a running host after a host-scoped deployment change", async () => {
    const { setHostRuntimeDeployments } = await import("./hosts");
    await setHostRuntimeDeployments({
      account_id: ACCOUNT_ID,
      scope_type: "host",
      id: HOST_ID,
      deployments: [
        {
          target_type: "component",
          target: "acp-worker",
          desired_version: "ph-v2",
        },
      ],
    });
    expect(createLroMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "host-reconcile-runtime-deployments",
        scope_type: "host",
        scope_id: HOST_ID,
        input: expect.objectContaining({
          id: HOST_ID,
          components: ["acp-worker"],
          reason: "automatic_runtime_deployment_reconcile",
        }),
      }),
    );
  });

  it("fans out automatic reconcile to running hosts after a global deployment change", async () => {
    const { setHostRuntimeDeployments } = await import("./hosts");
    await setHostRuntimeDeployments({
      account_id: ACCOUNT_ID,
      scope_type: "global",
      deployments: [
        {
          target_type: "component",
          target: "acp-worker",
          desired_version: "ph-v2",
        },
      ],
    });
    expect(createLroMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "host-reconcile-runtime-deployments",
        scope_type: "host",
        scope_id: HOST_ID,
        input: expect.objectContaining({
          components: ["acp-worker"],
        }),
      }),
    );
  });
});

describe("hosts.setHostRuntimeDeployments automatic artifact reconcile", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.LOGS = os.tmpdir();
    isAdminMock = jest.fn(async () => true);
    isBannedMock = jest.fn(async () => false);
    moveProjectToHostMock = jest.fn();
    resolveMembershipForAccountMock = jest.fn(async () => ({
      entitlements: {},
    }));
    loadProjectHostMetricsHistoryMock = jest.fn(async () => new Map());
    syncProjectUsersOnHostMock = jest.fn(async () => undefined);
    issueProjectHostAuthTokenJwtMock = jest.fn(() => ({
      token: "test-token",
      expires_at: 1234567890,
    }));
    assertAccountProjectHostTokenProjectAccessMock = jest.fn(
      async () => undefined,
    );
    assertProjectHostAgentTokenAccessMock = jest.fn(async () => undefined);
    hasAccountProjectHostTokenHostAccessMock = jest.fn(async () => false);
    resolveProjectBayMock = jest.fn(async () => ({
      bay_id: "bay-0",
      epoch: 1,
    }));
    resolveHostBayMock = jest.fn(async () => ({
      bay_id: "bay-0",
      epoch: 1,
    }));
    hostConnectionGetMock = jest.fn();
    projectHostAuthTokenIssueMock = jest.fn();
    projectReferenceGetMock = jest.fn(async () => null);
    listProjectHostRuntimeDeploymentsMock = jest.fn(async () => []);
    loadEffectiveProjectHostRuntimeDeploymentsMock = jest.fn(async () => [
      {
        scope_type: "host",
        scope_id: HOST_ID,
        host_id: HOST_ID,
        target_type: "artifact",
        target: "project-bundle",
        desired_version: "bundle-v5",
        requested_by: ACCOUNT_ID,
        requested_at: "2026-04-15T00:00:00.000Z",
        updated_at: "2026-04-15T00:00:00.000Z",
      },
    ]);
    setProjectHostRuntimeDeploymentsMock = jest.fn(async ({ deployments }) =>
      deployments.map((deployment: any) => ({
        scope_type: "host",
        scope_id: HOST_ID,
        host_id: HOST_ID,
        requested_by: ACCOUNT_ID,
        requested_at: "2026-04-15T00:00:00.000Z",
        updated_at: "2026-04-15T00:00:00.000Z",
        ...deployment,
      })),
    );
    updateProjectUsersMock = jest.fn(async () => undefined);
    routedHostControlClientMock = jest.fn(async () => ({
      getManagedComponentStatus: async () => [],
      getInstalledRuntimeArtifacts: async () => [
        {
          artifact: "project-host",
          current_version: "ph-v2",
          current_build_id: "build-ph-v2",
          installed_versions: ["ph-v2"],
        },
        {
          artifact: "project-bundle",
          current_version: "bundle-v4",
          current_build_id: "build-bundle-v4",
          installed_versions: ["bundle-v4"],
        },
      ],
      updateProjectUsers: (...args: any[]) => updateProjectUsersMock(...args),
    }));
    queryMock = jest.fn(async (sql: string, _params: any[]) => {
      if (
        sql.includes(
          "SELECT id FROM project_hosts WHERE deleted IS NULL AND LOWER(COALESCE(status, '')) = ANY",
        )
      ) {
        return { rows: [{ id: HOST_ID }] };
      }
      if (sql.includes("FROM project_hosts")) {
        return {
          rows: [
            {
              id: HOST_ID,
              status: "running",
              metadata: {
                owner: ACCOUNT_ID,
                software: {
                  project_host: "ph-v2",
                  project_bundle: "bundle-v4",
                  project_bundle_build_id: "build-bundle-v4",
                },
              },
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
  });

  it("queues automatic artifact upgrade for a running host after a host-scoped artifact deployment change", async () => {
    const { setHostRuntimeDeployments } = await import("./hosts");
    await setHostRuntimeDeployments({
      account_id: ACCOUNT_ID,
      scope_type: "host",
      id: HOST_ID,
      deployments: [
        {
          target_type: "artifact",
          target: "project-bundle",
          desired_version: "bundle-v5",
        },
      ],
    });
    expect(createLroMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "host-upgrade-software",
        scope_type: "host",
        scope_id: HOST_ID,
        input: expect.objectContaining({
          id: HOST_ID,
          targets: [{ artifact: "project-bundle", version: "bundle-v5" }],
        }),
      }),
    );
  });
});

describe("hosts.upgradeHostSoftware", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.LOGS = os.tmpdir();
    isAdminMock = jest.fn(async () => true);
    isBannedMock = jest.fn(async () => false);
    moveProjectToHostMock = jest.fn();
    resolveMembershipForAccountMock = jest.fn(async () => ({
      entitlements: {},
    }));
    loadProjectHostMetricsHistoryMock = jest.fn(async () => new Map());
    syncProjectUsersOnHostMock = jest.fn(async () => undefined);
    issueProjectHostAuthTokenJwtMock = jest.fn(() => ({
      token: "test-token",
      expires_at: 1234567890,
    }));
    assertAccountProjectHostTokenProjectAccessMock = jest.fn(
      async () => undefined,
    );
    assertProjectHostAgentTokenAccessMock = jest.fn(async () => undefined);
    hasAccountProjectHostTokenHostAccessMock = jest.fn(async () => false);
    resolveProjectBayMock = jest.fn(async () => ({
      bay_id: "bay-0",
      epoch: 1,
    }));
    resolveHostBayMock = jest.fn(async () => ({
      bay_id: "bay-0",
      epoch: 1,
    }));
    hostConnectionGetMock = jest.fn();
    projectHostAuthTokenIssueMock = jest.fn();
    projectReferenceGetMock = jest.fn(async () => null);
    listProjectHostRuntimeDeploymentsMock = jest.fn(async () => []);
    loadEffectiveProjectHostRuntimeDeploymentsMock = jest.fn(async () => []);
    setProjectHostRuntimeDeploymentsMock = jest.fn(async () => []);
    updateProjectUsersMock = jest.fn(async () => undefined);
    routedHostControlClientMock = jest.fn(async () => ({
      updateProjectUsers: (...args: any[]) => updateProjectUsersMock(...args),
    }));
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("FROM project_hosts")) {
        return {
          rows: [
            {
              id: HOST_ID,
              status: "running",
              metadata: { owner: ACCOUNT_ID },
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
  });

  it("rejects mixed project-host upgrades so rollback scope stays well-defined", async () => {
    const { upgradeHostSoftware } = await import("./hosts");
    await expect(
      upgradeHostSoftware({
        account_id: ACCOUNT_ID,
        id: HOST_ID,
        targets: [
          { artifact: "project-host", version: "ph-v2" },
          { artifact: "tools", version: "tools-v5" },
        ],
      }),
    ).rejects.toThrow(
      "project-host upgrades must be requested separately from other artifacts",
    );
  });
});

describe("hosts.rollbackProjectHostOverSshInternal", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.LOGS = os.tmpdir();
    isAdminMock = jest.fn(async () => true);
    isBannedMock = jest.fn(async () => false);
    moveProjectToHostMock = jest.fn();
    resolveMembershipForAccountMock = jest.fn(async () => ({
      entitlements: {},
    }));
    loadProjectHostMetricsHistoryMock = jest.fn(async () => new Map());
    syncProjectUsersOnHostMock = jest.fn(async () => undefined);
    issueProjectHostAuthTokenJwtMock = jest.fn(() => ({
      token: "test-token",
      expires_at: 1234567890,
    }));
    assertAccountProjectHostTokenProjectAccessMock = jest.fn(
      async () => undefined,
    );
    assertProjectHostAgentTokenAccessMock = jest.fn(async () => undefined);
    hasAccountProjectHostTokenHostAccessMock = jest.fn(async () => false);
    resolveProjectBayMock = jest.fn(async () => ({
      bay_id: "bay-0",
      epoch: 1,
    }));
    resolveHostBayMock = jest.fn(async () => ({
      bay_id: "bay-0",
      epoch: 1,
    }));
    hostConnectionGetMock = jest.fn();
    projectHostAuthTokenIssueMock = jest.fn();
    projectReferenceGetMock = jest.fn(async () => null);
    listProjectHostRuntimeDeploymentsMock = jest.fn(async () => []);
    loadEffectiveProjectHostRuntimeDeploymentsMock = jest.fn(async () => []);
    setProjectHostRuntimeDeploymentsMock = jest.fn(async ({ deployments }) =>
      deployments.map((deployment: any) => ({
        scope_type: "host",
        scope_id: HOST_ID,
        host_id: HOST_ID,
        requested_by: ACCOUNT_ID,
        requested_at: "2026-04-15T00:00:00.000Z",
        updated_at: "2026-04-15T00:00:00.000Z",
        ...deployment,
      })),
    );
    updateProjectUsersMock = jest.fn(async () => undefined);
    routedHostControlClientMock = jest.fn(async () => ({
      updateProjectUsers: (...args: any[]) => updateProjectUsersMock(...args),
    }));
  });

  it("rewrites desired state and triggers bootstrap reconcile for project-host rollback", async () => {
    const initialRow = {
      id: HOST_ID,
      status: "running",
      version: "ph-v2",
      metadata: {
        owner: ACCOUNT_ID,
        machine: {
          cloud: "gcp",
          metadata: {
            public_ip: "34.1.2.3",
            ssh_user: "ubuntu",
          },
        },
        runtime: {
          public_ip: "34.1.2.3",
          ssh_user: "ubuntu",
        },
        software: {
          project_host: "ph-v2",
          project_host_build_id: "build-ph-v2",
        },
        bootstrap: {
          status: "done",
          updated_at: "2026-04-15T00:00:00.000Z",
        },
        bootstrap_lifecycle: {
          summary_status: "in_sync",
          summary_message: "ok",
        },
      },
    };
    let bootstrapPolls = 0;
    queryMock = jest.fn(async (sql: string, params: any[]) => {
      if (sql.includes("SELECT * FROM project_hosts")) {
        return { rows: [initialRow] };
      }
      if (
        sql.includes(
          "UPDATE project_hosts SET metadata=$2, version=$3, updated=NOW()",
        )
      ) {
        expect(params[0]).toBe(HOST_ID);
        expect(params[2]).toBe("ph-v1");
        expect(params[1]).toMatchObject({
          software: {
            project_host: "ph-v1",
          },
        });
        expect(params[1]?.software?.project_host_build_id).toBeUndefined();
        return { rows: [] };
      }
      if (sql.includes("UPDATE project_hosts SET metadata=$2, updated=NOW()")) {
        expect(params[0]).toBe(HOST_ID);
        expect(params[1]).toMatchObject({
          runtime_deployments: {
            last_known_good_versions: {
              "project-host": "ph-v1",
            },
          },
        });
        return { rows: [] };
      }
      if (
        sql.includes(
          "SELECT status, deleted, metadata FROM project_hosts WHERE id=$1 LIMIT 1",
        )
      ) {
        bootstrapPolls += 1;
        if (bootstrapPolls === 1) {
          return {
            rows: [
              {
                status: "running",
                deleted: false,
                metadata: {
                  bootstrap: {
                    status: "pending",
                    updated_at: "2026-04-15T00:00:00.000Z",
                  },
                  bootstrap_lifecycle: {
                    summary_status: "drifted",
                    current_operation: "idle",
                  },
                },
              },
            ],
          };
        }
        return {
          rows: [
            {
              status: "running",
              deleted: false,
              metadata: {
                bootstrap: {
                  status: "done",
                  updated_at: "2026-04-15T00:01:00.000Z",
                },
                bootstrap_lifecycle: {
                  summary_status: "in_sync",
                  current_operation: "reconcile",
                  last_reconcile_started_at: "2026-04-15T00:00:30.000Z",
                  last_reconcile_finished_at: "2026-04-15T00:01:00.000Z",
                },
              },
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { rollbackProjectHostOverSshInternal } = await import("./hosts");
    const result = await rollbackProjectHostOverSshInternal({
      account_id: ACCOUNT_ID,
      id: HOST_ID,
      version: "ph-v1",
      reason: "automatic_project_host_upgrade_rollback",
    });

    expect(result).toEqual({
      host_id: HOST_ID,
      rollback_version: "ph-v1",
    });
    expect(setProjectHostRuntimeDeploymentsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        scope_type: "host",
        host_id: HOST_ID,
        deployments: [
          expect.objectContaining({
            target_type: "artifact",
            target: "project-host",
            desired_version: "ph-v1",
            rollout_reason: "automatic_project_host_upgrade_rollback",
          }),
          expect.objectContaining({
            target_type: "component",
            target: "project-host",
            desired_version: "ph-v1",
            rollout_reason: "automatic_project_host_upgrade_rollback",
          }),
        ],
      }),
    );
    expect(createProjectHostBootstrapTokenMock).toHaveBeenCalledWith(HOST_ID);
    expect(buildCloudInitStartupScriptMock).toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledWith(
      "ssh",
      expect.arrayContaining(["ubuntu@34.1.2.3", "bash", "-se"]),
      expect.any(Object),
    );
  });
});

describe("hosts.resolveHostConnection", () => {
  const REMOTE_HOST_ID = "host-remote";

  beforeEach(() => {
    jest.resetModules();
    process.env.LOGS = os.tmpdir();
    isAdminMock = jest.fn(async () => true);
    isBannedMock = jest.fn(async () => false);
    moveProjectToHostMock = jest.fn();
    resolveMembershipForAccountMock = jest.fn(async () => ({
      entitlements: {},
    }));
    loadProjectHostMetricsHistoryMock = jest.fn(async () => new Map());
    syncProjectUsersOnHostMock = jest.fn(async () => undefined);
    issueProjectHostAuthTokenJwtMock = jest.fn(() => ({
      token: "test-token",
      expires_at: 1234567890,
    }));
    assertAccountProjectHostTokenProjectAccessMock = jest.fn(
      async () => undefined,
    );
    assertProjectHostAgentTokenAccessMock = jest.fn(async () => undefined);
    hasAccountProjectHostTokenHostAccessMock = jest.fn(async () => false);
    resolveProjectBayMock = jest.fn(async () => ({
      bay_id: "bay-0",
      epoch: 1,
    }));
    resolveHostBayMock = jest.fn(async () => ({
      bay_id: "bay-7",
      epoch: 2,
    }));
    hostConnectionGetMock = jest.fn(async () => ({
      host_id: REMOTE_HOST_ID,
      bay_id: "bay-7",
      name: "Remote Host",
      region: "us-central1",
      size: "n2-standard-4",
      ssh_server: null,
      connect_url: "https://remote-host.example.test",
      local_proxy: false,
      ready: true,
      status: "running",
      tier: null,
      pricing_model: "on_demand",
      interruption_restore_policy: "never",
      desired_state: "running",
      last_seen: "2026-04-10T00:00:00.000Z",
      online: true,
    }));
    queryMock = jest.fn(async () => ({ rows: [] }));
  });

  afterEach(() => {
    delete process.env.LOGS;
  });

  it("routes host connection lookup to the owning bay when the host is remote", async () => {
    const { resolveHostConnection } = await import("./hosts");
    await expect(
      resolveHostConnection({
        account_id: ACCOUNT_ID,
        host_id: REMOTE_HOST_ID,
      }),
    ).resolves.toMatchObject({
      host_id: REMOTE_HOST_ID,
      bay_id: "bay-7",
      connect_url: "https://remote-host.example.test",
    });
    expect(resolveHostBayMock).toHaveBeenCalledWith(REMOTE_HOST_ID);
    expect(hostConnectionGetMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      host_id: REMOTE_HOST_ID,
    });
  });
});

describe("hosts.issueProjectHostAuthToken", () => {
  const HOST_UUID = "00000000-0000-4000-8000-000000000201";
  const ACCOUNT_UUID = "00000000-0000-4000-8000-000000000202";
  const PROJECT_UUID = "00000000-0000-4000-8000-000000000203";

  beforeEach(() => {
    jest.resetModules();
    queryMock = jest.fn();
    isAdminMock = jest.fn(async () => false);
    isBannedMock = jest.fn(async () => false);
    moveProjectToHostMock = jest.fn();
    resolveMembershipForAccountMock = jest.fn(async () => ({
      entitlements: {},
    }));
    loadProjectHostMetricsHistoryMock = jest.fn(async () => new Map());
    syncProjectUsersOnHostMock = jest.fn(async () => undefined);
    issueProjectHostAuthTokenJwtMock = jest.fn(() => ({
      token: "issued-token",
      expires_at: 424242,
    }));
    assertAccountProjectHostTokenProjectAccessMock = jest.fn(
      async () => undefined,
    );
    assertProjectHostAgentTokenAccessMock = jest.fn(async () => undefined);
    hasAccountProjectHostTokenHostAccessMock = jest.fn(async () => false);
    resolveProjectBayMock = jest.fn(async () => ({
      bay_id: "bay-0",
      epoch: 1,
    }));
    resolveHostBayMock = jest.fn(async () => ({
      bay_id: "bay-0",
      epoch: 1,
    }));
    projectHostAuthTokenIssueMock = jest.fn(async () => ({
      host_id: HOST_UUID,
      token: "remote-issued-token",
      expires_at: 777777,
    }));
    projectReferenceGetMock = jest.fn(async () => ({
      project_id: PROJECT_UUID,
      title: "Remote project",
      host_id: HOST_UUID,
      owning_bay_id: "bay-7",
      users: { [ACCOUNT_UUID]: { group: "owner" } },
    }));
    updateProjectUsersMock = jest.fn(async () => undefined);
    routedHostControlClientMock = jest.fn(async () => ({
      updateProjectUsers: (...args: any[]) => updateProjectUsersMock(...args),
    }));
  });

  it("syncs host ACLs before issuing a browser token for a locally owned project", async () => {
    const { issueProjectHostAuthToken } = await import("./hosts");
    await expect(
      issueProjectHostAuthToken({
        account_id: ACCOUNT_UUID,
        host_id: HOST_UUID,
        project_id: PROJECT_UUID,
      }),
    ).resolves.toEqual({
      host_id: HOST_UUID,
      token: "issued-token",
      expires_at: 424242,
    });
    expect(resolveProjectBayMock).toHaveBeenCalledWith(PROJECT_UUID);
    expect(syncProjectUsersOnHostMock).toHaveBeenCalledWith({
      project_id: PROJECT_UUID,
      expected_host_id: HOST_UUID,
    });
    expect(issueProjectHostAuthTokenJwtMock).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: ACCOUNT_UUID,
        host_id: HOST_UUID,
      }),
    );
  });

  it("routes project-host token issuance to the host bay for remote hosts", async () => {
    resolveProjectBayMock = jest.fn(async () => ({
      bay_id: "bay-7",
      epoch: 2,
    }));
    resolveHostBayMock = jest.fn(async () => ({
      bay_id: "bay-3",
      epoch: 5,
    }));

    const { issueProjectHostAuthToken } = await import("./hosts");
    await expect(
      issueProjectHostAuthToken({
        account_id: ACCOUNT_UUID,
        host_id: HOST_UUID,
        project_id: PROJECT_UUID,
      }),
    ).resolves.toEqual({
      host_id: HOST_UUID,
      token: "remote-issued-token",
      expires_at: 777777,
    });
    expect(resolveHostBayMock).toHaveBeenCalledWith(HOST_UUID);
    expect(syncProjectUsersOnHostMock).not.toHaveBeenCalled();
    expect(issueProjectHostAuthTokenJwtMock).not.toHaveBeenCalled();
    expect(projectHostAuthTokenIssueMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_UUID,
      host_id: HOST_UUID,
      project_id: PROJECT_UUID,
      ttl_seconds: undefined,
    });
  });

  it("issues locally when no project is supplied", async () => {
    hasAccountProjectHostTokenHostAccessMock = jest.fn(async () => true);
    const { issueProjectHostAuthToken } = await import("./hosts");
    await expect(
      issueProjectHostAuthToken({
        account_id: ACCOUNT_UUID,
        host_id: HOST_UUID,
      }),
    ).resolves.toEqual({
      host_id: HOST_UUID,
      token: "issued-token",
      expires_at: 424242,
    });
    expect(resolveProjectBayMock).not.toHaveBeenCalled();
    expect(issueProjectHostAuthTokenJwtMock).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: ACCOUNT_UUID,
        host_id: HOST_UUID,
      }),
    );
  });

  it("syncs remote project users onto a locally owned host before issuing a browser token", async () => {
    resolveProjectBayMock = jest.fn(async () => ({
      bay_id: "bay-7",
      epoch: 2,
    }));
    resolveHostBayMock = jest.fn(async () => ({
      bay_id: "bay-0",
      epoch: 1,
    }));

    const { issueProjectHostAuthToken } = await import("./hosts");
    await expect(
      issueProjectHostAuthToken({
        account_id: ACCOUNT_UUID,
        host_id: HOST_UUID,
        project_id: PROJECT_UUID,
      }),
    ).resolves.toEqual({
      host_id: HOST_UUID,
      token: "issued-token",
      expires_at: 424242,
    });
    expect(projectReferenceGetMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_UUID,
      project_id: PROJECT_UUID,
    });
    expect(syncProjectUsersOnHostMock).not.toHaveBeenCalled();
    expect(updateProjectUsersMock).toHaveBeenCalledWith({
      project_id: PROJECT_UUID,
      users: { [ACCOUNT_UUID]: { group: "owner" } },
    });
  });

  it("routes host-only project-host token issuance to the host bay for remote hosts", async () => {
    hasAccountProjectHostTokenHostAccessMock = jest.fn(async () => true);
    resolveHostBayMock = jest.fn(async () => ({
      bay_id: "bay-4",
      epoch: 3,
    }));
    const { issueProjectHostAuthToken } = await import("./hosts");
    await expect(
      issueProjectHostAuthToken({
        account_id: ACCOUNT_UUID,
        host_id: HOST_UUID,
      }),
    ).resolves.toEqual({
      host_id: HOST_UUID,
      token: "remote-issued-token",
      expires_at: 777777,
    });
    expect(resolveHostBayMock).toHaveBeenCalledWith(HOST_UUID);
    expect(issueProjectHostAuthTokenJwtMock).not.toHaveBeenCalled();
    expect(projectHostAuthTokenIssueMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_UUID,
      host_id: HOST_UUID,
      project_id: undefined,
      ttl_seconds: undefined,
    });
  });
});

describe("hosts.listHosts bootstrap normalization", () => {
  beforeEach(() => {
    jest.resetModules();
    isAdminMock = jest.fn(async () => true);
    moveProjectToHostMock = jest.fn();
    resolveMembershipForAccountMock = jest.fn(async () => ({
      entitlements: {},
    }));
    loadProjectHostMetricsHistoryMock = jest.fn(async () => new Map());
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("SELECT * FROM project_hosts")) {
        return {
          rows: [
            {
              id: HOST_ID,
              status: "running",
              deleted: null,
              last_seen: new Date("2026-04-01T21:03:00Z"),
              metadata: {
                owner: ACCOUNT_ID,
                bootstrap: {
                  status: "error",
                  updated_at: "2026-04-01T20:50:00Z",
                  message: "bootstrap failed (exit 1) at line 206",
                },
                bootstrap_lifecycle: {
                  summary_status: "in_sync",
                  summary_message: "Host software is in sync",
                  last_reconcile_finished_at: "2026-04-01T21:02:00Z",
                  drift_count: 0,
                  items: [],
                },
              },
            },
          ],
        };
      }
      if (sql.includes("COUNT(*) AS total")) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
  });

  it("prefers newer lifecycle success over stale bootstrap failure", async () => {
    const { listHosts } = await import("./hosts");
    const hosts = await listHosts({
      account_id: ACCOUNT_ID,
      admin_view: true,
      include_deleted: true,
    });
    expect(hosts).toHaveLength(1);
    expect(hosts[0].bootstrap?.status).toBe("done");
    expect(hosts[0].bootstrap?.message).toBe("Host software is in sync");
  });
});

describe("hosts.drainHostInternal", () => {
  beforeEach(() => {
    jest.resetModules();
    isAdminMock = jest.fn(async () => true);
    moveProjectToHostMock = jest.fn();
    queryMock = jest.fn(async (sql: string, params: any[]) => {
      if (sql.includes("SELECT * FROM project_hosts WHERE id=$1")) {
        return {
          rows: [
            {
              id: params?.[0],
              metadata: { owner: ACCOUNT_ID },
            },
          ],
        };
      }
      if (
        sql.includes("SELECT project_id") &&
        sql.includes("WHERE host_id=$1")
      ) {
        return {
          rows: [
            { project_id: "proj-5" },
            { project_id: "proj-4" },
            { project_id: "proj-3" },
            { project_id: "proj-2" },
            { project_id: "proj-1" },
          ],
        };
      }
      if (sql.includes("SELECT u.key AS account_id")) {
        return {
          rows: [{ account_id: ACCOUNT_ID }],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
  });

  it("fans out direct project moves up to the requested parallel limit", async () => {
    let started = 0;
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    moveProjectToHostMock.mockImplementation(async () => {
      started += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate;
      active -= 1;
    });

    const { drainHostInternal } = await import("./hosts");
    const promise = drainHostInternal({
      account_id: ACCOUNT_ID,
      id: HOST_ID,
      dest_host_id: "host-999",
      parallel: 3,
    });

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(started).toBe(3);
    expect(maxActive).toBe(3);

    release();

    await expect(promise).resolves.toMatchObject({
      host_id: HOST_ID,
      dest_host_id: "host-999",
      total: 5,
      moved: 5,
      failed: 0,
      parallel: 3,
    });
    expect(moveProjectToHostMock).toHaveBeenCalledTimes(5);
  }, 15000);
});
