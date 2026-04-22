export {};

let queryMock: jest.Mock;
let connectMock: jest.Mock;
let clientQueryMock: jest.Mock;
let clientReleaseMock: jest.Mock;
let isAdminMock: jest.Mock;
let resolveProjectBayMock: jest.Mock;
let resolveProjectBayDirectMock: jest.Mock;
let projectControlMock: jest.Mock;
let acceptRehomeMock: jest.Mock;
let rehomeMock: jest.Mock;
let appendProjectOutboxEventForProjectMock: jest.Mock;
let drainAccountProjectIndexProjectionMock: jest.Mock;
let publishProjectAccountFeedEventsBestEffortMock: jest.Mock;
let assertBayAcceptsProjectOwnershipMock: jest.Mock;
let dstreamMock: jest.Mock;
let dstreamRowsQueue: any[][];
let dstreamPublishedRows: any[];
let operationRow: any;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    query: queryMock,
    connect: connectMock,
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

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: any[]) => isAdminMock(...args),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: jest.fn(() => "bay-0"),
}));

jest.mock("@cocalc/server/bay-registry", () => ({
  assertBayAcceptsProjectOwnership: (...args: any[]) =>
    assertBayAcceptsProjectOwnershipMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: (...args: any[]) => resolveProjectBayMock(...args),
  resolveProjectBayDirect: (...args: any[]) =>
    resolveProjectBayDirectMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  getInterBayBridge: jest.fn(() => ({
    projectControl: (...args: any[]) => projectControlMock(...args),
  })),
}));

jest.mock("@cocalc/database/postgres/project-events-outbox", () => ({
  appendProjectOutboxEventForProject: (...args: any[]) =>
    appendProjectOutboxEventForProjectMock(...args),
}));

jest.mock("@cocalc/database/postgres/account-project-index-projector", () => ({
  drainAccountProjectIndexProjection: (...args: any[]) =>
    drainAccountProjectIndexProjectionMock(...args),
}));

jest.mock("@cocalc/server/account/project-feed", () => ({
  publishProjectAccountFeedEventsBestEffort: (...args: any[]) =>
    publishProjectAccountFeedEventsBestEffortMock(...args),
}));

jest.mock("@cocalc/backend/conat/sync", () => ({
  dstream: (...args: any[]) => dstreamMock(...args),
}));

describe("project rehome", () => {
  const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
  const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
  const PROJECT_LOG_ROW = {
    id: "log-1",
    project_id: PROJECT_ID,
    account_id: ACCOUNT_ID,
    time: new Date("2026-04-22T00:00:00.000Z"),
    event: { event: "open", path: "a.txt" },
  };

  beforeEach(() => {
    jest.resetModules();
    operationRow = undefined;
    queryMock = jest.fn(async (sql: string, params?: any[]) => {
      if (
        sql.includes("CREATE TABLE IF NOT EXISTS project_rehome_operations") ||
        sql.includes("CREATE INDEX IF NOT EXISTS project_rehome_operations")
      ) {
        return { rows: [] };
      }
      if (
        sql.includes("FROM project_rehome_operations") &&
        sql.includes("status = 'running'")
      ) {
        return { rows: operationRow ? [operationRow] : [] };
      }
      if (sql.includes("INSERT INTO project_rehome_operations")) {
        operationRow = {
          op_id: "33333333-3333-4333-8333-333333333333",
          project_id: params?.[0],
          source_bay_id: params?.[1],
          dest_bay_id: params?.[2],
          requested_by: params?.[3],
          reason: params?.[4],
          campaign_id: params?.[5],
          status: "running",
          stage: "requested",
          attempt: 0,
          project: null,
          last_error: null,
          created_at: new Date("2026-04-22T00:00:00.000Z"),
          updated_at: new Date("2026-04-22T00:00:00.000Z"),
          finished_at: null,
        };
        return { rows: [operationRow] };
      }
      if (
        sql.includes("UPDATE project_rehome_operations") &&
        sql.includes("attempt = attempt + 1")
      ) {
        operationRow = {
          ...operationRow,
          status: "running",
          attempt: (operationRow?.attempt ?? 0) + 1,
          last_error: null,
          finished_at: null,
        };
        return { rows: [operationRow] };
      }
      if (sql.includes("UPDATE project_rehome_operations")) {
        const stage = params?.find((value) =>
          [
            "requested",
            "destination_accepted",
            "source_flipped",
            "portable_state_copied",
            "projected",
            "complete",
          ].includes(value),
        );
        const status = params?.find((value) =>
          ["running", "succeeded", "failed"].includes(value),
        );
        const project = params?.find(
          (value) =>
            value &&
            typeof value === "object" &&
            value.project_id === PROJECT_ID,
        );
        operationRow = {
          ...operationRow,
          ...(stage ? { stage } : {}),
          ...(status ? { status } : {}),
          ...(project ? { project } : {}),
          updated_at: new Date("2026-04-22T00:00:05.000Z"),
          ...(status === "succeeded"
            ? { finished_at: new Date("2026-04-22T00:00:05.000Z") }
            : {}),
        };
        return { rows: [operationRow] };
      }
      if (sql.includes("FROM project_rehome_operations")) {
        return { rows: operationRow ? [operationRow] : [] };
      }
      return { rows: [] };
    });
    clientQueryMock = jest.fn(async (sql: string, params?: any[]) => {
      if (sql.includes("pg_advisory_xact_lock")) {
        return { rows: [] };
      }
      if (
        sql.includes("FROM project_rehome_operations") &&
        sql.includes("status = 'running'")
      ) {
        return { rows: operationRow ? [operationRow] : [] };
      }
      if (sql.includes("INSERT INTO project_rehome_operations")) {
        operationRow = {
          op_id: "33333333-3333-4333-8333-333333333333",
          project_id: params?.[0],
          source_bay_id: params?.[1],
          dest_bay_id: params?.[2],
          requested_by: params?.[3],
          reason: params?.[4],
          campaign_id: params?.[5],
          status: "running",
          stage: "requested",
          attempt: 0,
          project: null,
          last_error: null,
          created_at: new Date("2026-04-22T00:00:00.000Z"),
          updated_at: new Date("2026-04-22T00:00:00.000Z"),
          finished_at: null,
        };
        return { rows: [operationRow] };
      }
      if (sql.includes("information_schema.columns")) {
        return {
          rows: [
            { column_name: "project_id" },
            { column_name: "owning_bay_id" },
            { column_name: "title" },
            { column_name: "users" },
            { column_name: "deleted" },
          ],
        };
      }
      return { rows: [] };
    });
    clientReleaseMock = jest.fn();
    connectMock = jest.fn(async () => ({
      query: clientQueryMock,
      release: clientReleaseMock,
    }));
    isAdminMock = jest.fn(async () => true);
    resolveProjectBayMock = jest.fn(async () => ({
      bay_id: "bay-0",
      epoch: 0,
    }));
    resolveProjectBayDirectMock = jest.fn(async () => ({
      bay_id: "bay-0",
      epoch: 0,
    }));
    acceptRehomeMock = jest.fn(async () => ({
      project_id: PROJECT_ID,
      previous_bay_id: "bay-0",
      owning_bay_id: "bay-2",
      status: "rehomed",
    }));
    rehomeMock = jest.fn(async () => ({
      project_id: PROJECT_ID,
      previous_bay_id: "bay-7",
      owning_bay_id: "bay-2",
      status: "rehomed",
    }));
    projectControlMock = jest.fn((bay_id: string) => ({
      acceptRehome: acceptRehomeMock,
      rehome: rehomeMock,
      bay_id,
    }));
    appendProjectOutboxEventForProjectMock = jest.fn(async () => "event-id");
    drainAccountProjectIndexProjectionMock = jest.fn(async () => ({}));
    publishProjectAccountFeedEventsBestEffortMock = jest.fn(
      async () => undefined,
    );
    assertBayAcceptsProjectOwnershipMock = jest.fn(async () => undefined);
    dstreamRowsQueue = [[PROJECT_LOG_ROW]];
    dstreamPublishedRows = [];
    dstreamMock = jest.fn(async () => {
      const rows = dstreamRowsQueue.length ? dstreamRowsQueue.shift()! : [];
      return {
        getAll: jest.fn(() => rows),
        publish: jest.fn((row) => dstreamPublishedRows.push(row)),
        save: jest.fn(async () => undefined),
        close: jest.fn(),
      };
    });
  });

  it("routes rehome requests to the current owning bay", async () => {
    resolveProjectBayMock = jest.fn(async () => ({
      bay_id: "bay-7",
      epoch: 3,
    }));
    const { rehomeProject } = await import("./rehome");

    const result = await rehomeProject({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      dest_bay_id: "bay-2",
    });

    expect(result.owning_bay_id).toBe("bay-2");
    expect(projectControlMock).toHaveBeenCalledWith("bay-7", {
      timeout_ms: 60_000,
    });
    expect(rehomeMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      dest_bay_id: "bay-2",
      reason: undefined,
      campaign_id: undefined,
      epoch: 3,
    });
    expect(acceptRehomeMock).not.toHaveBeenCalled();
  });

  it("accepts on destination before flipping source ownership", async () => {
    const order: string[] = [];
    const defaultQueryMock = queryMock;
    acceptRehomeMock = jest.fn(async () => {
      order.push("accept-destination");
      return {
        project_id: PROJECT_ID,
        op_id: "33333333-3333-4333-8333-333333333333",
        previous_bay_id: "bay-0",
        owning_bay_id: "bay-2",
        operation_stage: "complete",
        operation_status: "succeeded",
        status: "rehomed",
      };
    });
    projectControlMock = jest.fn(() => ({
      acceptRehome: acceptRehomeMock,
      rehome: rehomeMock,
    }));
    queryMock = jest.fn(async (sql: string, params?: any[]) => {
      if (sql.includes("SELECT to_jsonb(projects.*) AS project")) {
        return {
          rows: [
            {
              project: {
                project_id: PROJECT_ID,
                owning_bay_id: "bay-0",
                title: "Project",
                users: {},
                deleted: false,
              },
            },
          ],
        };
      }
      if (sql.includes("UPDATE projects")) {
        order.push("flip-source");
        return { rows: [] };
      }
      return await defaultQueryMock(sql, params);
    });
    const { rehomeProject } = await import("./rehome");

    const result = await rehomeProject({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      dest_bay_id: "bay-2",
    });

    expect(result).toEqual({
      op_id: "33333333-3333-4333-8333-333333333333",
      project_id: PROJECT_ID,
      previous_bay_id: "bay-0",
      owning_bay_id: "bay-2",
      operation_stage: "complete",
      operation_status: "succeeded",
      status: "rehomed",
    });
    expect(order).toEqual([
      "accept-destination",
      "flip-source",
      "accept-destination",
      "accept-destination",
    ]);
    expect(acceptRehomeMock).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      account_id: ACCOUNT_ID,
      source_bay_id: "bay-0",
      dest_bay_id: "bay-2",
      project: {
        project_id: PROJECT_ID,
        owning_bay_id: "bay-0",
        title: "Project",
        users: {},
        deleted: false,
      },
    });
    expect(acceptRehomeMock).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      source_bay_id: "bay-0",
      dest_bay_id: "bay-2",
      project: {
        project_id: PROJECT_ID,
        owning_bay_id: "bay-0",
        title: "Project",
        users: {},
        deleted: false,
      },
      portable_state: {
        project_log: [PROJECT_LOG_ROW],
        api_keys: [],
      },
    });
    expect(acceptRehomeMock).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      account_id: ACCOUNT_ID,
      source_bay_id: "bay-0",
      dest_bay_id: "bay-2",
      project: {
        project_id: PROJECT_ID,
        owning_bay_id: "bay-0",
        title: "Project",
        users: {},
        deleted: false,
      },
      portable_state: {
        project_log: [
          {
            id: "project-rehome:33333333-3333-4333-8333-333333333333",
            project_id: PROJECT_ID,
            account_id: ACCOUNT_ID,
            time: new Date("2026-04-22T00:00:05.000Z"),
            event: {
              event: "project_rehomed",
              op_id: "33333333-3333-4333-8333-333333333333",
              source_bay_id: "bay-0",
              dest_bay_id: "bay-2",
              duration_ms: 5000,
              reason: undefined,
              campaign_id: undefined,
            },
          },
        ],
      },
    });
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE account_project_index"),
      [PROJECT_ID, "bay-2"],
    );
  });

  it("destination accept upserts the project row as locally owned", async () => {
    const { acceptProjectRehome } = await import("./rehome");

    await expect(
      acceptProjectRehome({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        source_bay_id: "bay-1",
        dest_bay_id: "bay-0",
        project: {
          project_id: PROJECT_ID,
          owning_bay_id: "bay-1",
          title: "Project",
          users: {},
          deleted: false,
        },
      }),
    ).resolves.toEqual({
      project_id: PROJECT_ID,
      previous_bay_id: "bay-1",
      owning_bay_id: "bay-0",
      status: "rehomed",
    });

    expect(clientQueryMock).toHaveBeenCalledWith("BEGIN");
    expect(clientQueryMock).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT (project_id) DO UPDATE"),
      [PROJECT_ID, "bay-0", "Project", {}, false],
    );
    expect(appendProjectOutboxEventForProjectMock).toHaveBeenCalledWith({
      db: expect.anything(),
      event_type: "project.summary_changed",
      project_id: PROJECT_ID,
      default_bay_id: "bay-0",
    });
    expect(clientQueryMock).toHaveBeenCalledWith("COMMIT");
    expect(drainAccountProjectIndexProjectionMock).toHaveBeenCalledWith({
      bay_id: "bay-0",
      dry_run: false,
      limit: 100,
    });
    expect(publishProjectAccountFeedEventsBestEffortMock).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      default_bay_id: "bay-0",
    });
  });

  it("destination accept merges portable project log rows", async () => {
    dstreamRowsQueue = [[PROJECT_LOG_ROW]];
    const { acceptProjectRehome } = await import("./rehome");

    await acceptProjectRehome({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      source_bay_id: "bay-1",
      dest_bay_id: "bay-0",
      project: {
        project_id: PROJECT_ID,
        owning_bay_id: "bay-1",
        title: "Project",
        users: {},
        deleted: false,
      },
      portable_state: {
        project_log: [
          PROJECT_LOG_ROW,
          {
            ...PROJECT_LOG_ROW,
            id: "log-2",
            event: { event: "open", path: "b.txt" },
          },
        ],
      },
    });

    expect(dstreamMock).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      name: "project-log",
      noAutosave: true,
      noCache: true,
      noInventory: true,
    });
    expect(dstreamPublishedRows).toEqual([
      {
        ...PROJECT_LOG_ROW,
        id: "log-2",
        event: { event: "open", path: "b.txt" },
      },
    ]);
  });

  it("destination accept replaces project-scoped v2 api keys by key_id", async () => {
    const apiKeyRow = {
      id: 123,
      key_id: "portable-project-key",
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      created: new Date("2026-04-22T00:00:00.000Z"),
      hash: "hash",
      trunc: "sk-co...portable",
      name: "project key",
      expire: null,
      last_active: null,
    };
    const defaultQueryMock = queryMock;
    const apiKeyQueries: Array<{ sql: string; params?: any[] }> = [];
    queryMock = jest.fn(async (sql: string, params?: any[]) => {
      if (
        sql.includes("ALTER TABLE api_keys ADD COLUMN") ||
        sql.includes(
          "CREATE UNIQUE INDEX IF NOT EXISTS api_keys_key_id_unique_idx",
        )
      ) {
        return { rows: [] };
      }
      if (
        sql.includes("information_schema.columns") &&
        params?.[0] === "api_keys"
      ) {
        return {
          rows: [
            { column_name: "id" },
            { column_name: "account_id" },
            { column_name: "created" },
            { column_name: "hash" },
            { column_name: "project_id" },
            { column_name: "expire" },
            { column_name: "trunc" },
            { column_name: "name" },
            { column_name: "last_active" },
            { column_name: "key_id" },
          ],
        };
      }
      if (sql.includes("DELETE FROM api_keys")) {
        apiKeyQueries.push({ sql, params });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO api_keys")) {
        apiKeyQueries.push({ sql, params });
        return { rows: [], rowCount: 1 };
      }
      return await defaultQueryMock(sql, params);
    });
    const { acceptProjectRehome } = await import("./rehome");

    await acceptProjectRehome({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      source_bay_id: "bay-1",
      dest_bay_id: "bay-0",
      project: {
        project_id: PROJECT_ID,
        owning_bay_id: "bay-1",
        title: "Project",
        users: {},
        deleted: false,
      },
      portable_state: {
        api_keys: [apiKeyRow],
      },
    });

    expect(apiKeyQueries[0]).toEqual({
      sql: expect.stringContaining("DELETE FROM api_keys"),
      params: [PROJECT_ID],
    });
    expect(apiKeyQueries[1].sql).toEqual(
      expect.stringContaining("ON CONFLICT (key_id) DO UPDATE SET"),
    );
    expect(apiKeyQueries[1].params).toEqual([
      ACCOUNT_ID,
      apiKeyRow.created,
      "hash",
      PROJECT_ID,
      null,
      "sk-co...portable",
      "project key",
      null,
      "portable-project-key",
    ]);
  });

  it("reconciles a destination-accepted operation by copying portable state", async () => {
    operationRow = {
      op_id: "33333333-3333-4333-8333-333333333333",
      project_id: PROJECT_ID,
      source_bay_id: "bay-0",
      dest_bay_id: "bay-2",
      requested_by: ACCOUNT_ID,
      reason: "maintenance",
      campaign_id: "drain-bay-0",
      status: "failed",
      stage: "destination_accepted",
      attempt: 1,
      project: {
        project_id: PROJECT_ID,
        owning_bay_id: "bay-0",
        title: "Project",
        users: {},
        deleted: false,
      },
      last_error: "source flip failed",
    };
    const order: string[] = [];
    const defaultQueryMock = queryMock;
    queryMock = jest.fn(async (sql: string, params?: any[]) => {
      if (sql.includes("UPDATE projects")) {
        order.push("flip-source");
        return { rows: [] };
      }
      return await defaultQueryMock(sql, params);
    });
    const { reconcileProjectRehome } = await import("./rehome");

    await expect(
      reconcileProjectRehome({
        account_id: ACCOUNT_ID,
        op_id: operationRow.op_id,
      }),
    ).resolves.toEqual({
      op_id: operationRow.op_id,
      project_id: PROJECT_ID,
      previous_bay_id: "bay-0",
      owning_bay_id: "bay-2",
      operation_stage: "complete",
      operation_status: "succeeded",
      status: "rehomed",
    });

    expect(acceptRehomeMock).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      source_bay_id: "bay-0",
      dest_bay_id: "bay-2",
      project: {
        project_id: PROJECT_ID,
        owning_bay_id: "bay-0",
        title: "Project",
        users: {},
        deleted: false,
      },
      portable_state: {
        project_log: [PROJECT_LOG_ROW],
        api_keys: [],
      },
    });
    expect(order).toEqual(["flip-source"]);
  });

  it("summarizes failed project rehome operations for operator retry", async () => {
    operationRow = {
      op_id: "33333333-3333-4333-8333-333333333333",
      project_id: PROJECT_ID,
      source_bay_id: "bay-0",
      dest_bay_id: "bay-2",
      requested_by: ACCOUNT_ID,
      reason: "maintenance",
      campaign_id: "drain-bay-0",
      status: "failed",
      stage: "destination_accepted",
      attempt: 2,
      project: {
        project_id: PROJECT_ID,
        owning_bay_id: "bay-0",
        title: "Project",
        users: {},
        deleted: false,
      },
      last_error: "source flip failed",
      created_at: new Date("2026-04-22T00:00:00.000Z"),
      updated_at: new Date("2026-04-22T00:00:05.000Z"),
      finished_at: new Date("2026-04-22T00:00:05.000Z"),
    };
    const { getProjectRehomeOperation } = await import("./rehome");

    await expect(
      getProjectRehomeOperation(operationRow.op_id),
    ).resolves.toEqual({
      op_id: operationRow.op_id,
      project_id: PROJECT_ID,
      source_bay_id: "bay-0",
      dest_bay_id: "bay-2",
      requested_by: ACCOUNT_ID,
      reason: "maintenance",
      campaign_id: "drain-bay-0",
      status: "failed",
      stage: "destination_accepted",
      attempt: 2,
      last_error: "source flip failed",
      created_at: new Date("2026-04-22T00:00:00.000Z"),
      updated_at: new Date("2026-04-22T00:00:05.000Z"),
      finished_at: new Date("2026-04-22T00:00:05.000Z"),
    });
  });

  it("drainProjectRehome dry-runs local source bay candidates", async () => {
    const defaultQueryMock = queryMock;
    queryMock = jest.fn(async (sql: string, params?: any[]) => {
      if (sql.includes("FROM projects") && sql.includes("ORDER BY")) {
        return {
          rows: [{ project_id: PROJECT_ID }],
        };
      }
      return await defaultQueryMock(sql, params);
    });
    const { drainProjectRehome } = await import("./rehome");

    await expect(
      drainProjectRehome({
        account_id: ACCOUNT_ID,
        source_bay_id: "bay-0",
        dest_bay_id: "bay-2",
        limit: 10,
        dry_run: true,
        campaign_id: "drain-bay-0",
      }),
    ).resolves.toMatchObject({
      source_bay_id: "bay-0",
      dest_bay_id: "bay-2",
      dry_run: true,
      limit: 10,
      campaign_id: "drain-bay-0",
      candidates: [PROJECT_ID],
      rehomed: [],
      errors: [],
    });
    expect(acceptRehomeMock).not.toHaveBeenCalled();
  });
});
