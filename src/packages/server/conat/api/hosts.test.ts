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
let hostConnectionListMock: jest.Mock;
let hostConnectionGetProjectStartMetadataMock: jest.Mock;
let hostConnectionGetBackupConfigMock: jest.Mock;
let hostConnectionRecordProjectBackupMock: jest.Mock;
let hostConnectionListHostProjectsMock: jest.Mock;
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
let getHostOwnerBaySshIdentityMock: jest.Mock;
let getProviderContextMock: jest.Mock;
let siteUrlMock: jest.Mock;
let getServerSettingsMock: jest.Mock;
let fetchMock: jest.Mock;
let getBackupConfigLocalInternalMock: jest.Mock;
let recordProjectBackupLocalInternalMock: jest.Mock;
const originalFetch = global.fetch;

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
  ensureProjectHostRuntimeDeploymentsSchema: jest.fn(async () => undefined),
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

jest.mock("@cocalc/server/cloud/ssh-key", () => ({
  __esModule: true,
  getHostOwnerBaySshIdentity: (...args: any[]) =>
    getHostOwnerBaySshIdentityMock(...args),
  getHostSshPublicKeys: jest.fn(async () => [
    "ssh-ed25519 AAAAOWNER cocalc-host-owner-bay:bay-0",
  ]),
}));

jest.mock("@cocalc/server/cloud/provider-context", () => ({
  __esModule: true,
  getProviderContext: (...args: any[]) => getProviderContextMock(...args),
}));

jest.mock("@cocalc/database/settings/site-url", () => ({
  __esModule: true,
  default: (...args: any[]) => siteUrlMock(...args),
}));

jest.mock("@cocalc/database/settings/server-settings", () => ({
  __esModule: true,
  getServerSettings: (...args: any[]) => getServerSettingsMock(...args),
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

jest.mock("@cocalc/server/cluster-config", () => {
  const actual = jest.requireActual("@cocalc/server/cluster-config");
  return {
    __esModule: true,
    ...actual,
    getConfiguredClusterBayIdsForStaticEnumerationOnly: jest.fn(() => [
      "bay-0",
      "bay-1",
      "bay-2",
    ]),
  };
});

jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  __esModule: true,
  getInterBayBridge: jest.fn(() => ({
    hostConnection: jest.fn(() => ({
      get: (...args: any[]) => hostConnectionGetMock(...args),
      list: (...args: any[]) => hostConnectionListMock(...args),
      getProjectStartMetadata: (...args: any[]) =>
        hostConnectionGetProjectStartMetadataMock(...args),
      getBackupConfig: (...args: any[]) =>
        hostConnectionGetBackupConfigMock(...args),
      recordProjectBackup: (...args: any[]) =>
        hostConnectionRecordProjectBackupMock(...args),
      listHostProjects: (...args: any[]) =>
        hostConnectionListHostProjectsMock(...args),
    })),
    projectReference: jest.fn(() => ({
      get: (...args: any[]) => projectReferenceGetMock(...args),
    })),
    projectHostAuthToken: jest.fn(() => ({
      issue: (...args: any[]) => projectHostAuthTokenIssueMock(...args),
    })),
  })),
}));

jest.mock("@cocalc/server/project-backup", () => ({
  __esModule: true,
  getBackupConfig: (...args: any[]) =>
    getBackupConfigLocalInternalMock(...args),
  recordProjectBackup: (...args: any[]) =>
    recordProjectBackupLocalInternalMock(...args),
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
  getHostOwnerBaySshIdentityMock = jest.fn(async () => ({
    privateKeyPath: "/tmp/cocalc-owner-bay/id_ed25519",
    publicKey: "ssh-ed25519 AAAAOWNER cocalc-host-owner-bay:bay-0",
  }));
  getProviderContextMock = jest.fn(async () => ({
    entry: {
      provider: {
        ensureSshAccess: jest.fn(async () => undefined),
      },
    },
    creds: {},
  }));
  siteUrlMock = jest.fn(async () => "https://hub.example.test");
  getServerSettingsMock = jest.fn(async () => ({}));
  fetchMock = jest.fn();
  global.fetch = fetchMock as any;
  hostConnectionGetMock = jest.fn();
  hostConnectionListMock = jest.fn(async () => []);
  hostConnectionGetProjectStartMetadataMock = jest.fn();
  hostConnectionGetBackupConfigMock = jest.fn();
  hostConnectionRecordProjectBackupMock = jest.fn(async () => undefined);
  hostConnectionListHostProjectsMock = jest.fn(async () => ({
    rows: [],
    summary: {
      total: 0,
      provisioned: 0,
      running: 0,
      provisioned_up_to_date: 0,
      provisioned_needs_backup: 0,
    },
  }));
  getBackupConfigLocalInternalMock = jest.fn();
  recordProjectBackupLocalInternalMock = jest.fn(async () => undefined);
});

afterAll(() => {
  global.fetch = originalFetch;
});

const SUMMARY_ROW = {
  host_id: HOST_ID,
  total: "4",
  provisioned: "3",
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

const LOCAL_HOST_PROJECT_ROWS = [
  ...PROJECT_ROWS_PAGE_1,
  ...PROJECT_ROWS_PAGE_2,
];

describe("hosts.listHostProjects", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.LOGS = os.tmpdir();
    process.env.COCALC_BAY_ID = "bay-0";
    process.env.COCALC_CLUSTER_BAY_IDS = "bay-0,bay-1,bay-2";
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
              region: "us-west1",
              metadata: {
                owner: ACCOUNT_ID,
                machine: { cloud: "gcp", region: "us-west1" },
              },
              last_seen: new Date("2026-01-05T00:00:00Z"),
            },
          ],
        };
      }
      if (sql.includes("COUNT(*) AS total")) {
        return { rows: [SUMMARY_ROW] };
      }
      if (sql.includes("LEFT(COALESCE(title")) {
        return { rows: LOCAL_HOST_PROJECT_ROWS };
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
    expect(second.rows).toHaveLength(2);
    expect(second.next_cursor).toBeUndefined();
  });

  it("routes project listing to the host-owning bay", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM project_hosts")) {
        return {
          rows: [
            {
              id: HOST_ID,
              bay_id: "bay-1",
              metadata: { owner: ACCOUNT_ID },
              last_seen: new Date("2026-01-05T00:00:00Z"),
            },
          ],
        };
      }
      throw new Error(`unexpected local query: ${sql}`);
    });
    hostConnectionListHostProjectsMock.mockResolvedValueOnce({
      rows: [
        {
          project_id: "proj-remote",
          title: "Remote",
          state: "running",
          provisioned: true,
          last_edited: "2026-01-04T00:00:00.000Z",
          last_backup: "2026-01-03T00:00:00.000Z",
          needs_backup: true,
          collab_count: 4,
        },
      ],
      summary: {
        total: 1,
        provisioned: 1,
        running: 1,
        provisioned_up_to_date: 0,
        provisioned_needs_backup: 1,
      },
    });

    const { listHostProjects } = await import("./hosts");
    const result = await listHostProjects({
      account_id: ACCOUNT_ID,
      id: HOST_ID,
      limit: 10,
    });

    expect(hostConnectionListHostProjectsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: ACCOUNT_ID,
        id: HOST_ID,
        limit: 10,
      }),
    );
    expect(result.rows.map((row) => row.project_id)).toEqual(["proj-remote"]);
    expect(result.summary).toEqual({
      total: 1,
      provisioned: 1,
      running: 1,
      provisioned_up_to_date: 0,
      provisioned_needs_backup: 1,
    });
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

  it("adds state filters when requested", async () => {
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
      state_filter: "running",
    });
    await listHostProjects({
      account_id: ACCOUNT_ID,
      id: HOST_ID,
      limit: 1,
      state_filter: "stopped",
    });
    await listHostProjects({
      account_id: ACCOUNT_ID,
      id: HOST_ID,
      limit: 1,
      state_filter: "unprovisioned",
    });
    await listHostProjects({
      account_id: ACCOUNT_ID,
      id: HOST_ID,
      limit: 1,
      project_state: "opened",
    });

    const [runningSql, stoppedSql, unprovisionedSql, exactStateSql] = listSqls;
    expect(runningSql).toContain("IN ('running','starting')");
    expect(stoppedSql).toContain("provisioned IS TRUE AND NOT");
    expect(unprovisionedSql).toContain("provisioned IS NOT TRUE");
    expect(exactStateSql).toContain("COALESCE(state->>'state', '') =");
  });

  afterEach(() => {
    delete process.env.LOGS;
    delete process.env.COCALC_BAY_ID;
    delete process.env.COCALC_CLUSTER_BAY_IDS;
  });
});

describe("hosts.createHost", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.LOGS = os.tmpdir();
    process.env.COCALC_BAY_ID = "bay-0";
    process.env.COCALC_CLUSTER_BAY_IDS = "bay-0,bay-1,bay-2";
    isAdminMock = jest.fn(async () => true);
    isBannedMock = jest.fn(async () => false);
    moveProjectToHostMock = jest.fn();
    resolveMembershipForAccountMock = jest.fn(async () => ({
      entitlements: { features: { create_hosts: true } },
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
    hostConnectionListHostProjectsMock = jest.fn(async () => ({
      rows: [
        {
          project_id: "proj-remote",
          title: "Remote",
          state: "running",
          provisioned: true,
          last_edited: "2026-01-04T00:00:00.000Z",
          last_backup: "2026-01-03T00:00:00.000Z",
          needs_backup: true,
          collab_count: 4,
        },
      ],
      summary: {
        total: 1,
        provisioned: 1,
        running: 1,
        provisioned_up_to_date: 0,
        provisioned_needs_backup: 1,
      },
    }));
    projectHostAuthTokenIssueMock = jest.fn();
    projectReferenceGetMock = jest.fn(async () => null);
    listProjectHostRuntimeDeploymentsMock = jest.fn(async () => []);
    loadEffectiveProjectHostRuntimeDeploymentsMock = jest.fn(async () => []);
    setProjectHostRuntimeDeploymentsMock = jest.fn(async () => []);
    updateProjectUsersMock = jest.fn(async () => undefined);
    routedHostControlClientMock = jest.fn(async () => ({
      updateProjectUsers: (...args: any[]) => updateProjectUsersMock(...args),
    }));
  });

  afterEach(() => {
    delete process.env.LOGS;
  });

  it("does not snapshot site bootstrap defaults into new host metadata", async () => {
    let insertedMetadata: any;
    getServerSettingsMock = jest.fn(async () => ({
      project_hosts_bootstrap_channel: "latest",
      project_hosts_bootstrap_version: "bootstrap-v1",
    }));
    queryMock = jest.fn(async (sql: string, params: any[]) => {
      if (sql.includes("INSERT INTO project_hosts")) {
        insertedMetadata = params[4];
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO cloud_vm_work")) {
        return { rows: [] };
      }
      if (sql.includes("SELECT * FROM project_hosts")) {
        return {
          rows: [
            {
              id: params[0],
              name: "host-name",
              region: "us-central1",
              status: "starting",
              metadata: insertedMetadata,
              bay_id: "bay-0",
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { createHost } = await import("./hosts");
    await createHost({
      account_id: ACCOUNT_ID,
      name: "host-name",
      region: "us-central1",
      size: "small",
      machine: { cloud: "gcp", metadata: {} },
    });

    expect(insertedMetadata.bootstrap_channel).toBeUndefined();
    expect(insertedMetadata.bootstrap_version).toBeUndefined();
  });

  it("preserves explicit per-host bootstrap overrides", async () => {
    let insertedMetadata: any;
    getServerSettingsMock = jest.fn(async () => ({
      project_hosts_bootstrap_channel: "latest",
      project_hosts_bootstrap_version: "bootstrap-v1",
    }));
    queryMock = jest.fn(async (sql: string, params: any[]) => {
      if (sql.includes("INSERT INTO project_hosts")) {
        insertedMetadata = params[4];
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO cloud_vm_work")) {
        return { rows: [] };
      }
      if (sql.includes("SELECT * FROM project_hosts")) {
        return {
          rows: [
            {
              id: params[0],
              name: "host-name",
              region: "us-central1",
              status: "starting",
              metadata: insertedMetadata,
              bay_id: "bay-0",
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { createHost } = await import("./hosts");
    await createHost({
      account_id: ACCOUNT_ID,
      name: "host-name",
      region: "us-central1",
      size: "small",
      machine: {
        cloud: "gcp",
        metadata: {
          bootstrap_channel: "staging",
          bootstrap_version: "bootstrap-v2",
        },
      },
    });

    expect(insertedMetadata.bootstrap_channel).toBe("staging");
    expect(insertedMetadata.bootstrap_version).toBe("bootstrap-v2");
  });
});

describe("hosts.getHostRuntimeDeploymentStatus", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.LOGS = os.tmpdir();
    process.env.COCALC_BAY_ID = "bay-0";
    process.env.COCALC_CLUSTER_BAY_IDS = "bay-0,bay-1,bay-2";
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
    hostConnectionListHostProjectsMock = jest.fn(async () => ({
      rows: [
        {
          project_id: "proj-remote",
          title: "Remote",
          state: "running",
          provisioned: true,
          last_edited: "2026-01-04T00:00:00.000Z",
          last_backup: "2026-01-03T00:00:00.000Z",
          needs_backup: true,
          collab_count: 4,
        },
      ],
      summary: {
        total: 1,
        provisioned: 1,
        running: 1,
        provisioned_up_to_date: 0,
        provisioned_needs_backup: 1,
      },
    }));
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
          version_bytes: [
            { version: "ph-v2", bytes: 2000 },
            { version: "ph-v1", bytes: 1000 },
          ],
          installed_bytes_total: 3000,
        },
        {
          artifact: "project-bundle",
          current_version: "bundle-v4",
          current_build_id: "build-bundle-v4",
          installed_versions: ["bundle-v4"],
          version_bytes: [{ version: "bundle-v4", bytes: 4000 }],
          installed_bytes_total: 4000,
          referenced_versions: [{ version: "bundle-v4", project_count: 2 }],
        },
        {
          artifact: "tools",
          current_version: "tools-v7",
          installed_versions: ["tools-v7"],
          version_bytes: [{ version: "tools-v7", bytes: 7000 }],
          installed_bytes_total: 7000,
          referenced_versions: [
            { version: "tools-v7", project_count: 1 },
            { version: "tools-v6", project_count: 1 },
          ],
        },
      ],
      getHostAgentStatus: async () => ({
        project_host: {
          last_known_good_version: "ph-v1",
          pending_rollout: {
            target_version: "ph-v3",
            previous_version: "ph-v1",
            started_at: "2026-04-16T06:14:11.396Z",
            deadline_at: "2026-04-16T06:14:31.396Z",
          },
          last_automatic_rollback: {
            target_version: "ph-v2",
            rollback_version: "ph-v1",
            started_at: "2026-04-16T06:14:11.396Z",
            finished_at: "2026-04-16T06:14:33.539Z",
            reason: "health_deadline_exceeded",
          },
        },
      }),
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
        version_bytes: [{ version: "bundle-v4", bytes: 4000 }],
        installed_bytes_total: 4000,
        referenced_versions: [{ version: "bundle-v4", project_count: 2 }],
        retention_policy: { keep_count: 3 },
      },
      {
        artifact: "project-host",
        current_version: "ph-v2",
        current_build_id: "build-ph-v2",
        installed_versions: ["ph-v2", "ph-v1"],
        version_bytes: [
          { version: "ph-v2", bytes: 2000 },
          { version: "ph-v1", bytes: 1000 },
        ],
        installed_bytes_total: 3000,
        retention_policy: { keep_count: 10 },
      },
      {
        artifact: "tools",
        current_version: "tools-v7",
        installed_versions: ["tools-v7"],
        version_bytes: [{ version: "tools-v7", bytes: 7000 }],
        installed_bytes_total: 7000,
        referenced_versions: [
          { version: "tools-v7", project_count: 1 },
          { version: "tools-v6", project_count: 1 },
        ],
        retention_policy: { keep_count: 3 },
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
    expect(status.observed_host_agent).toEqual({
      project_host: {
        last_known_good_version: "ph-v1",
        pending_rollout: {
          target_version: "ph-v3",
          previous_version: "ph-v1",
          started_at: "2026-04-16T06:14:11.396Z",
          deadline_at: "2026-04-16T06:14:31.396Z",
        },
        last_automatic_rollback: {
          target_version: "ph-v2",
          rollback_version: "ph-v1",
          started_at: "2026-04-16T06:14:11.396Z",
          finished_at: "2026-04-16T06:14:33.539Z",
          reason: "health_deadline_exceeded",
        },
      },
    });
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
        referenced_versions: [],
        protected_versions: ["ph-v2", "ph-v1"],
        prune_candidate_versions: [],
        retained_bytes_total: 3000,
        protected_bytes_total: 3000,
        prune_candidate_bytes_total: undefined,
        retention_policy: { keep_count: 10 },
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
        referenced_versions: [],
        protected_versions: ["ph-v2", "ph-v1"],
        prune_candidate_versions: [],
        retained_bytes_total: 3000,
        protected_bytes_total: 3000,
        prune_candidate_bytes_total: undefined,
        retention_policy: { keep_count: 10 },
      },
    ]);
    expect(status.observation_error).toBeUndefined();
  });

  it("ignores missing host-agent status support on older hosts", async () => {
    routedHostControlClientMock.mockImplementationOnce(async () => ({
      upgradeSoftware: async () => ({ results: [] }),
      rolloutManagedComponents: async ({ components }: any) => ({
        results: components.map((component: string) => ({
          component,
          action: "spawned",
        })),
      }),
      getManagedComponentStatus: async () => [],
      getInstalledRuntimeArtifacts: async () => [
        {
          artifact: "project-host",
          current_version: "ph-v2",
          current_build_id: "build-ph-v2",
          installed_versions: ["ph-v2", "ph-v1"],
        },
      ],
      getHostAgentStatus: async () => {
        throw new Error(
          "calling remote function 'getHostAgentStatus': TypeError: impl[mesg.name] is not a function",
        );
      },
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
                },
              },
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const { getHostRuntimeDeploymentStatus } = await import("./hosts");
    const status = await getHostRuntimeDeploymentStatus({
      account_id: ACCOUNT_ID,
      id: HOST_ID,
    });
    expect(status.observed_host_agent).toBeUndefined();
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
      getHostAgentStatus: async () => ({
        project_host: {
          last_known_good_version: "ph-v1",
        },
      }),
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
        created_by: ACCOUNT_ID,
        input: expect.objectContaining({
          id: HOST_ID,
          account_id: ACCOUNT_ID,
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
        created_by: ACCOUNT_ID,
        input: expect.objectContaining({
          account_id: ACCOUNT_ID,
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
      getHostAgentStatus: async () => ({
        project_host: {
          last_known_good_version: "ph-v0",
        },
      }),
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
        created_by: ACCOUNT_ID,
        input: expect.objectContaining({
          id: HOST_ID,
          account_id: ACCOUNT_ID,
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

  it("allows mixed project-host upgrades so one request can upgrade all host software", async () => {
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
    ).resolves.toEqual(
      expect.objectContaining({
        op_id: "op-123",
        kind: "host-upgrade-software",
      }),
    );
    expect(createLroMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "host-upgrade-software",
        scope_type: "host",
        scope_id: HOST_ID,
        input: expect.objectContaining({
          id: HOST_ID,
          targets: [
            { artifact: "project-host", version: "ph-v2" },
            { artifact: "tools", version: "tools-v5" },
          ],
        }),
      }),
    );
  });
});

describe("hosts.stopHostProjects / restartHostProjects", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.LOGS = os.tmpdir();
    process.env.COCALC_BAY_ID = "bay-0";
    process.env.COCALC_CLUSTER_BAY_IDS = "bay-0,bay-1,bay-2";
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
    hostConnectionListHostProjectsMock = jest.fn(async () => ({
      rows: [
        {
          project_id: "proj-remote",
          title: "Remote",
          state: "running",
          provisioned: true,
          last_edited: "2026-01-04T00:00:00.000Z",
          last_backup: "2026-01-03T00:00:00.000Z",
          needs_backup: true,
          collab_count: 4,
        },
      ],
      summary: {
        total: 1,
        provisioned: 1,
        running: 1,
        provisioned_up_to_date: 0,
        provisioned_needs_backup: 1,
      },
    }));
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
      if (sql.includes("COUNT(*) AS total")) {
        return {
          rows: [
            {
              host_id: HOST_ID,
              total: "2",
              provisioned: "2",
              running: "2",
              provisioned_up_to_date: "0",
              provisioned_needs_backup: "2",
            },
          ],
        };
      }
      if (sql.includes("LEFT(COALESCE(title")) {
        return {
          rows: [
            {
              project_id: "proj-1",
              title: "Project 1",
              state: "running",
              provisioned: true,
              last_edited: new Date("2026-01-02T00:00:00Z"),
              last_backup: new Date("2026-01-01T00:00:00Z"),
              needs_backup: true,
              collab_count: "1",
            },
            {
              project_id: "proj-2",
              title: "Project 2",
              state: "running",
              provisioned: true,
              last_edited: new Date("2026-01-01T00:00:00Z"),
              last_backup: new Date("2025-12-31T00:00:00Z"),
              needs_backup: true,
              collab_count: "2",
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
  });

  afterEach(() => {
    delete process.env.LOGS;
    delete process.env.COCALC_BAY_ID;
    delete process.env.COCALC_CLUSTER_BAY_IDS;
  });

  it("queues host-scoped project stop/restart actions with a snapshot target set", async () => {
    const { stopHostProjects, restartHostProjects } = await import("./hosts");

    await stopHostProjects({
      account_id: ACCOUNT_ID,
      id: HOST_ID,
      state_filter: "running",
      parallel: 2,
    });
    await restartHostProjects({
      account_id: ACCOUNT_ID,
      id: HOST_ID,
      project_state: "opened",
    });

    expect(createLroMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        kind: "host-stop-projects",
        scope_type: "host",
        scope_id: HOST_ID,
        input: expect.objectContaining({
          id: HOST_ID,
          state_filter: "running",
          parallel: 2,
          projects: [
            { project_id: "proj-1", state: "running" },
            { project_id: "proj-2", state: "running" },
          ],
        }),
      }),
    );
    expect(createLroMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        kind: "host-restart-projects",
        scope_type: "host",
        scope_id: HOST_ID,
        input: expect.objectContaining({
          id: HOST_ID,
          state_filter: "all",
          project_state: "opened",
          projects: [
            { project_id: "proj-1", state: "running" },
            { project_id: "proj-2", state: "running" },
          ],
        }),
      }),
    );
  });

  it("routes host-scoped project actions to the host-owning bay", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM project_hosts")) {
        return {
          rows: [
            {
              id: HOST_ID,
              bay_id: "bay-1",
              status: "running",
              metadata: { owner: ACCOUNT_ID },
            },
          ],
        };
      }
      throw new Error(`unexpected local query: ${sql}`);
    });
    hostConnectionListHostProjectsMock
      .mockResolvedValueOnce({
        rows: [{ project_id: "proj-remote-1", state: "running" }],
        summary: {
          total: 2,
          provisioned: 2,
          running: 2,
          provisioned_up_to_date: 0,
          provisioned_needs_backup: 2,
        },
        next_cursor: "next",
      })
      .mockResolvedValueOnce({
        rows: [{ project_id: "proj-remote-2", state: "off" }],
        summary: {
          total: 2,
          provisioned: 2,
          running: 2,
          provisioned_up_to_date: 0,
          provisioned_needs_backup: 2,
        },
      });

    const { stopHostProjects } = await import("./hosts");
    await stopHostProjects({
      account_id: ACCOUNT_ID,
      id: HOST_ID,
      state_filter: "running",
    });

    expect(hostConnectionListHostProjectsMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        account_id: ACCOUNT_ID,
        id: HOST_ID,
        limit: 5000,
        cursor: undefined,
        state_filter: "running",
      }),
    );
    expect(hostConnectionListHostProjectsMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        account_id: ACCOUNT_ID,
        id: HOST_ID,
        limit: 5000,
        cursor: "next",
        state_filter: "running",
      }),
    );
    expect(createLroMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "host-stop-projects",
        scope_id: HOST_ID,
        input: expect.objectContaining({
          projects: [
            { project_id: "proj-remote-1", state: "running" },
            { project_id: "proj-remote-2", state: "off" },
          ],
        }),
      }),
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
        deployments: expect.arrayContaining([
          expect.objectContaining({
            target_type: "artifact",
            target: "project-host",
            desired_version: "ph-v1",
          }),
          expect.objectContaining({
            target_type: "component",
            target: "project-host",
            desired_version: "ph-v1",
            rollout_reason: "automatic_project_host_upgrade_rollback",
          }),
          expect.objectContaining({
            target_type: "component",
            target: "conat-router",
            desired_version: "ph-v1",
            rollout_reason: "automatic_project_host_upgrade_rollback",
          }),
          expect.objectContaining({
            target_type: "component",
            target: "conat-persist",
            desired_version: "ph-v1",
            rollout_reason: "automatic_project_host_upgrade_rollback",
          }),
          expect.objectContaining({
            target_type: "component",
            target: "acp-worker",
            desired_version: "ph-v1",
            rollout_reason: "automatic_project_host_upgrade_rollback",
          }),
        ]),
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

  it("restores desired state when project-host rollback bootstrap reconcile fails", async () => {
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
        software: {
          project_host: "ph-v2",
          project_host_build_id: "build-ph-v2",
        },
      },
    };
    const updatedVersions: string[] = [];
    queryMock = jest.fn(async (sql: string, params: any[]) => {
      if (sql.includes("SELECT * FROM project_hosts")) {
        return { rows: [initialRow] };
      }
      if (sql.includes("UPDATE project_hosts") && sql.includes("version=$3")) {
        updatedVersions.push(params[2]);
        return { rows: [] };
      }
      if (sql.includes("UPDATE project_hosts")) {
        return { rows: [] };
      }
      if (
        sql.includes(
          "SELECT status, deleted, metadata FROM project_hosts WHERE id=$1 LIMIT 1",
        )
      ) {
        return {
          rows: [
            {
              status: "running",
              deleted: false,
              metadata: {
                bootstrap: {
                  status: "done",
                  updated_at: "2026-04-15T00:00:00.000Z",
                },
                bootstrap_lifecycle: {
                  summary_status: "in_sync",
                },
              },
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    spawnMock = jest.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: { end: () => void };
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = {
        end: () => {
          setImmediate(() => child.emit("close", 1));
        },
      };
      return child;
    });

    const { rollbackProjectHostOverSshInternal } = await import("./hosts");
    await expect(
      rollbackProjectHostOverSshInternal({
        account_id: ACCOUNT_ID,
        id: HOST_ID,
        version: "ph-v1",
        reason: "test failed rollback",
      }),
    ).rejects.toThrow("failed with code 1");

    expect(updatedVersions).toEqual(["ph-v1", "ph-v2"]);
    expect(setProjectHostRuntimeDeploymentsMock).toHaveBeenCalledTimes(2);
    expect(setProjectHostRuntimeDeploymentsMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        deployments: expect.arrayContaining([
          expect.objectContaining({
            target_type: "artifact",
            target: "project-host",
            desired_version: "ph-v1",
          }),
        ]),
      }),
    );
    expect(setProjectHostRuntimeDeploymentsMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        deployments: expect.arrayContaining([
          expect.objectContaining({
            target_type: "artifact",
            target: "project-host",
            desired_version: "ph-v2",
          }),
        ]),
      }),
    );
  });
});

describe("hosts.rolloutHostManagedComponentsInternal local rollback", () => {
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
      rolloutManagedComponents: jest.fn(async () => ({
        results: [
          {
            component: "project-host",
            action: "restart_scheduled",
          },
        ],
      })),
    }));
  });

  it("records a host-agent project-host rollback instead of treating the candidate as successful", async () => {
    const baselineSeen = new Date(Date.now() - 1_000);
    const refreshedSeen = new Date(Date.now() + 60_000);
    const desiredRow = {
      id: HOST_ID,
      status: "running",
      version: "ph-v2",
      last_seen: baselineSeen,
      metadata: {
        owner: ACCOUNT_ID,
        software: {
          project_host: "ph-v2",
        },
      },
    };
    const rolledBackRow = {
      ...desiredRow,
      version: "ph-v1",
      last_seen: refreshedSeen,
      metadata: {
        owner: ACCOUNT_ID,
        software: {
          project_host: "ph-v1",
        },
      },
    };
    let hostLoads = 0;
    queryMock = jest.fn(async (sql: string, params: any[]) => {
      if (sql.includes("SELECT * FROM project_hosts")) {
        hostLoads += 1;
        return { rows: [hostLoads === 1 ? desiredRow : rolledBackRow] };
      }
      if (sql.includes("SELECT deleted, last_seen FROM project_hosts")) {
        return {
          rows: [
            {
              deleted: false,
              last_seen: refreshedSeen,
            },
          ],
        };
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
      throw new Error(`unexpected query: ${sql}`);
    });

    const {
      isProjectHostLocalRollbackError,
      rolloutHostManagedComponentsInternal,
    } = await import("./hosts");

    let err: any;
    try {
      await rolloutHostManagedComponentsInternal({
        account_id: ACCOUNT_ID,
        id: HOST_ID,
        components: ["project-host"],
        reason: "host_software_upgrade",
      });
    } catch (caught) {
      err = caught;
    }

    expect(isProjectHostLocalRollbackError(err)).toBe(true);
    expect(err.automaticRollback).toEqual({
      host_id: HOST_ID,
      rollback_version: "ph-v1",
      source: "host-agent",
    });
    expect(setProjectHostRuntimeDeploymentsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        scope_type: "host",
        host_id: HOST_ID,
        deployments: expect.arrayContaining([
          expect.objectContaining({
            target_type: "artifact",
            target: "project-host",
            desired_version: "ph-v1",
          }),
          expect.objectContaining({
            target_type: "component",
            target: "project-host",
            desired_version: "ph-v1",
          }),
          expect.objectContaining({
            target_type: "component",
            target: "conat-router",
            desired_version: "ph-v1",
          }),
          expect.objectContaining({
            target_type: "component",
            target: "conat-persist",
            desired_version: "ph-v1",
          }),
          expect.objectContaining({
            target_type: "component",
            target: "acp-worker",
            desired_version: "ph-v1",
          }),
        ]),
      }),
    );
  });
});

describe("hosts.resolveHostConnection", () => {
  const REMOTE_HOST_ID = "host-remote";
  const REMOTE_PROJECT_ID = "project-remote";

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
    hostConnectionGetProjectStartMetadataMock = jest.fn(async () => ({
      title: "Remote project",
      image: "ghcr.io/example/project:latest",
      run_quota: { disk_quota: 10 },
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

  it("routes project start metadata lookup to the owning bay when the local host bay misses", async () => {
    resolveProjectBayMock = jest.fn(async () => ({
      bay_id: "bay-7",
      epoch: 2,
    }));
    const { getProjectStartMetadata } = await import("./hosts");
    await expect(
      getProjectStartMetadata({
        host_id: REMOTE_HOST_ID,
        project_id: REMOTE_PROJECT_ID,
      }),
    ).resolves.toEqual({
      title: "Remote project",
      image: "ghcr.io/example/project:latest",
      run_quota: { disk_quota: 10 },
    });
    expect(resolveProjectBayMock).toHaveBeenCalledWith(REMOTE_PROJECT_ID);
    expect(hostConnectionGetProjectStartMetadataMock).toHaveBeenCalledWith({
      host_id: REMOTE_HOST_ID,
      project_id: REMOTE_PROJECT_ID,
    });
  });

  it("routes backup config lookup to the owning bay when the project is remote", async () => {
    resolveProjectBayMock = jest.fn(async () => ({
      bay_id: "bay-7",
      epoch: 2,
    }));
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("FROM project_hosts")) {
        return {
          rows: [
            {
              id: REMOTE_HOST_ID,
              region: "us-west1",
              metadata: {
                machine: { cloud: "gcp", region: "us-west1" },
              },
            },
          ],
        };
      }
      return { rows: [] };
    });
    hostConnectionGetBackupConfigMock = jest.fn(async () => ({
      toml: "[repository]",
      ttl_seconds: 123,
    }));
    const { getBackupConfig } = await import("./hosts");
    await expect(
      getBackupConfig({
        host_id: REMOTE_HOST_ID,
        project_id: REMOTE_PROJECT_ID,
      }),
    ).resolves.toEqual({
      toml: "[repository]",
      ttl_seconds: 123,
    });
    expect(resolveProjectBayMock).toHaveBeenCalledWith(REMOTE_PROJECT_ID);
    expect(hostConnectionGetBackupConfigMock).toHaveBeenCalledWith({
      host_id: REMOTE_HOST_ID,
      project_id: REMOTE_PROJECT_ID,
      host_region: "us-west1",
      host_machine: { cloud: "gcp", region: "us-west1" },
    });
    expect(getBackupConfigLocalInternalMock).not.toHaveBeenCalled();
  });

  it("routes project backup recording to the owning bay when the project is remote", async () => {
    resolveProjectBayMock = jest.fn(async () => ({
      bay_id: "bay-7",
      epoch: 2,
    }));
    const { recordProjectBackup } = await import("./hosts");
    const time = new Date("2026-04-19T20:00:00Z");
    await expect(
      recordProjectBackup({
        host_id: REMOTE_HOST_ID,
        project_id: REMOTE_PROJECT_ID,
        time,
      }),
    ).resolves.toBeUndefined();
    expect(resolveProjectBayMock).toHaveBeenCalledWith(REMOTE_PROJECT_ID);
    expect(hostConnectionRecordProjectBackupMock).toHaveBeenCalledWith({
      host_id: REMOTE_HOST_ID,
      project_id: REMOTE_PROJECT_ID,
      time,
    });
    expect(recordProjectBackupLocalInternalMock).not.toHaveBeenCalled();
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
    delete process.env.COCALC_CLUSTER_BAY_IDS;
    delete process.env.COCALC_BAY_ID;
    isAdminMock = jest.fn(async () => true);
    moveProjectToHostMock = jest.fn();
    resolveMembershipForAccountMock = jest.fn(async () => ({
      entitlements: {},
    }));
    loadProjectHostMetricsHistoryMock = jest.fn(async () => new Map());
    hostConnectionListMock = jest.fn(async () => []);
    queryMock = jest.fn(async (sql: string) => {
      if (
        sql.includes(
          "CREATE TABLE IF NOT EXISTS project_host_runtime_deployments",
        )
      ) {
        return { rows: [] };
      }
      if (
        sql.includes(
          "CREATE INDEX IF NOT EXISTS project_host_runtime_deployments_host_idx",
        )
      ) {
        return { rows: [] };
      }
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
                observed_components: [
                  {
                    component: "conat-router",
                    artifact: "project-host",
                    upgrade_policy: "restart_now",
                    enabled: true,
                    managed: true,
                    desired_version: "build-ph-v2",
                    runtime_state: "running",
                    version_state: "aligned",
                    running_versions: ["build-ph-v2"],
                    running_pids: [3210],
                  },
                ],
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
      if (sql.includes("FROM project_host_runtime_deployments")) {
        return {
          rows: [
            { host_id: HOST_ID, target: "project-host" },
            { host_id: HOST_ID, target: "conat-router" },
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
    expect(hosts[0].observed_components).toEqual([
      expect.objectContaining({
        component: "conat-router",
        runtime_state: "running",
        version_state: "aligned",
        running_versions: ["build-ph-v2"],
      }),
    ]);
    expect(hosts[0].runtime_exception_summary).toEqual({
      host_override_count: 2,
      host_override_targets: ["conat-router", "project-host"],
    });
  });

  it("includes visible hosts from remote bays", async () => {
    process.env.COCALC_CLUSTER_BAY_IDS = "bay-0,bay-1";
    process.env.COCALC_BAY_ID = "bay-0";
    hostConnectionListMock = jest.fn(async () => [
      {
        id: "remote-host",
        name: "remote-host",
        owner: "other-owner",
        region: "us-west3",
        size: "t2d-standard-2",
        gpu: false,
        status: "running",
        scope: "collab",
        can_place: true,
        can_start: false,
        pricing_model: "spot",
      },
    ]);

    const { listHosts } = await import("./hosts");
    const hosts = await listHosts({
      account_id: ACCOUNT_ID,
      admin_view: true,
      include_deleted: true,
    });
    expect(hosts.map((host) => host.id)).toEqual([HOST_ID, "remote-host"]);
    expect(hostConnectionListMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      admin_view: true,
      include_deleted: true,
    });
  });

  it("prefers deleted duplicate host rows over stale live rows", async () => {
    process.env.COCALC_CLUSTER_BAY_IDS = "bay-0,bay-1";
    process.env.COCALC_BAY_ID = "bay-0";
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("SELECT * FROM project_hosts")) {
        return {
          rows: [
            {
              id: HOST_ID,
              name: "stale-local-host",
              status: "running",
              deleted: null,
              updated: new Date("2026-04-01T21:00:00Z"),
              metadata: { owner: ACCOUNT_ID },
            },
          ],
        };
      }
      if (sql.includes("FROM project_host_runtime_deployments")) {
        return { rows: [] };
      }
      if (sql.includes("COUNT(*) AS total")) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    hostConnectionListMock = jest.fn(async () => [
      {
        id: HOST_ID,
        name: "deleted-owner-host",
        owner: ACCOUNT_ID,
        bay_id: "bay-0",
        region: "",
        size: "",
        gpu: false,
        status: "deprovisioned",
        scope: "owned",
        can_place: false,
        can_start: true,
        pricing_model: "on_demand",
        updated: "2026-04-01T20:00:00.000Z",
        deleted: "2026-04-01T20:00:00.000Z",
      },
    ]);

    const { listHosts } = await import("./hosts");
    const hosts = await listHosts({
      account_id: ACCOUNT_ID,
      admin_view: true,
      include_deleted: true,
    });
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toEqual(
      expect.objectContaining({
        id: HOST_ID,
        name: "deleted-owner-host",
        status: "deprovisioned",
        deleted: "2026-04-01T20:00:00.000Z",
      }),
    );
  });

  it("keeps a local deprovisioned host row over a newer remote live duplicate", async () => {
    process.env.COCALC_CLUSTER_BAY_IDS = "bay-0,bay-1";
    process.env.COCALC_BAY_ID = "bay-0";
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("SELECT * FROM project_hosts")) {
        return {
          rows: [
            {
              id: HOST_ID,
              name: "local-owner-host",
              status: "deprovisioned",
              deleted: null,
              updated: new Date("2026-04-01T20:00:00Z"),
              metadata: { owner: ACCOUNT_ID },
            },
          ],
        };
      }
      if (sql.includes("FROM project_host_runtime_deployments")) {
        return { rows: [] };
      }
      if (sql.includes("COUNT(*) AS total")) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    hostConnectionListMock = jest.fn(async () => [
      {
        id: HOST_ID,
        name: "stale-remote-host",
        owner: ACCOUNT_ID,
        bay_id: "bay-0",
        region: "",
        size: "",
        gpu: false,
        status: "running",
        scope: "owned",
        can_place: false,
        can_start: true,
        pricing_model: "on_demand",
        updated: "2026-04-01T21:00:00.000Z",
      },
    ]);

    const { listHosts } = await import("./hosts");
    const hosts = await listHosts({
      account_id: ACCOUNT_ID,
      admin_view: true,
      include_deleted: true,
    });
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toEqual(
      expect.objectContaining({
        id: HOST_ID,
        name: "local-owner-host",
        status: "deprovisioned",
        updated: "2026-04-01T20:00:00.000Z",
      }),
    );
  });

  it("prefers the newest non-deleted duplicate host row", async () => {
    process.env.COCALC_CLUSTER_BAY_IDS = "bay-0,bay-1";
    process.env.COCALC_BAY_ID = "bay-0";
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("SELECT * FROM project_hosts")) {
        return {
          rows: [
            {
              id: HOST_ID,
              name: "older-local-host",
              status: "running",
              deleted: null,
              updated: new Date("2026-04-01T20:00:00Z"),
              metadata: { owner: ACCOUNT_ID },
            },
          ],
        };
      }
      if (sql.includes("FROM project_host_runtime_deployments")) {
        return { rows: [] };
      }
      if (sql.includes("COUNT(*) AS total")) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    hostConnectionListMock = jest.fn(async () => [
      {
        id: HOST_ID,
        name: "newer-remote-host",
        owner: ACCOUNT_ID,
        bay_id: "bay-0",
        region: "",
        size: "",
        gpu: false,
        status: "error",
        scope: "owned",
        can_place: false,
        can_start: true,
        pricing_model: "on_demand",
        updated: "2026-04-01T21:00:00.000Z",
      },
    ]);

    const { listHosts } = await import("./hosts");
    const hosts = await listHosts({
      account_id: ACCOUNT_ID,
      admin_view: true,
      include_deleted: true,
    });
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toEqual(
      expect.objectContaining({
        id: HOST_ID,
        name: "newer-remote-host",
        status: "error",
        updated: "2026-04-01T21:00:00.000Z",
      }),
    );
  });

  it("includes collaborator hosts in the local prefilter", async () => {
    queryMock = jest.fn(async (sql: string) => {
      if (
        sql.includes(
          "CREATE TABLE IF NOT EXISTS project_host_runtime_deployments",
        )
      ) {
        return { rows: [] };
      }
      if (
        sql.includes(
          "CREATE INDEX IF NOT EXISTS project_host_runtime_deployments_host_idx",
        )
      ) {
        return { rows: [] };
      }
      if (sql.includes("SELECT * FROM project_hosts")) {
        return {
          rows: [
            {
              id: HOST_ID,
              status: "running",
              deleted: null,
              metadata: {
                collaborators: [ACCOUNT_ID],
              },
            },
          ],
        };
      }
      if (
        sql.includes("FROM project_host_runtime_deployments") ||
        sql.includes("COUNT(*) AS total")
      ) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { listHosts } = await import("./hosts");
    const hosts = await listHosts({
      account_id: ACCOUNT_ID,
      catalog: true,
    });
    expect(hosts).toHaveLength(1);
    expect(hosts[0].scope).toBe("collab");
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

  it("preserves published software metadata fields in version listings", async () => {
    getServerSettingsMock.mockResolvedValue({
      project_hosts_software_base_url: "https://software.example.test/software",
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/project-host/latest-linux.json")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            url: "https://software.example.test/software/project-host/v3/bundle-linux.tar.xz",
            sha256: "sha-latest",
            size_bytes: 3456,
            built_at: "2026-04-17T05:00:00.000Z",
            version: "v3",
            message: "Fix reconnect recovery for host daemons",
          }),
        };
      }
      if (url.endsWith("/project-host/versions-latest-linux.json")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            artifact: "project-host",
            channel: "latest",
            os: "linux",
            generated_at: "2026-04-17T05:01:00.000Z",
            versions: [
              {
                version: "v2",
                url: "https://software.example.test/software/project-host/v2/bundle-linux.tar.xz",
                sha256: "sha-v2",
                size_bytes: 2345,
                built_at: "2026-04-16T01:02:03.000Z",
                message: "Known stable reconnect baseline",
              },
            ],
          }),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const { listHostSoftwareVersions } = await import("./hosts");
    const rows = await listHostSoftwareVersions({
      account_id: ACCOUNT_ID,
      artifacts: ["project-host"],
      channels: ["latest"],
      history_limit: 2,
    });

    expect(rows).toEqual([
      {
        artifact: "project-host",
        channel: "latest",
        os: "linux",
        arch: "amd64",
        version: "v3",
        url: "https://software.example.test/software/project-host/v3/bundle-linux.tar.xz",
        sha256: "sha-latest",
        size_bytes: 3456,
        built_at: "2026-04-17T05:00:00.000Z",
        message: "Fix reconnect recovery for host daemons",
        available: true,
      },
      {
        artifact: "project-host",
        channel: "latest",
        os: "linux",
        arch: "amd64",
        version: "v2",
        url: "https://software.example.test/software/project-host/v2/bundle-linux.tar.xz",
        sha256: "sha-v2",
        size_bytes: 2345,
        built_at: "2026-04-16T01:02:03.000Z",
        message: "Known stable reconnect baseline",
        available: true,
      },
    ]);
  });
});
