export {};

let queryMock: jest.Mock;
let isAdminMock: jest.Mock;
let moveProjectToHostMock: jest.Mock;
let resolveMembershipForAccountMock: jest.Mock;
let loadProjectHostMetricsHistoryMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: queryMock })),
}));

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: any[]) => isAdminMock(...args),
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

const HOST_ID = "host-123";
const ACCOUNT_ID = "acct-123";

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
    isAdminMock = jest.fn(async () => true);
    moveProjectToHostMock = jest.fn();
    resolveMembershipForAccountMock = jest.fn(async () => ({
      entitlements: {},
    }));
    loadProjectHostMetricsHistoryMock = jest.fn(async () => new Map());
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
  });
});
