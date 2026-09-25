import assert from "node:assert/strict";
import test from "node:test";

import { queryProjects, resolveHost, resolveProject } from "./project-resolve";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const HOST_ID = "33333333-3333-4333-8333-333333333333";

function createContext(
  handler: (table: string, row?: Record<string, unknown>) => any[],
) {
  return {
    accountId: ACCOUNT_ID,
    projectCache: new Map(),
    hub: {
      db: {
        userQuery: async ({
          query,
        }: {
          query: Record<string, Array<Record<string, unknown>>>;
        }) => {
          const table = Object.keys(query)[0];
          return {
            [table]: handler(table, query[table]?.[0]),
          };
        },
      },
      system: {},
      hosts: {},
    },
  } as any;
}

test("API key project lookup never falls back to account userQuery", async () => {
  const originalFetch = global.fetch;
  const paths: string[] = [];
  global.fetch = (async (url: URL, options: RequestInit) => {
    paths.push(url.pathname);
    assert.equal(options.headers?.["Authorization"], "Bearer scoped-key");
    if (url.pathname === "/api/conat/project-host-api-key") {
      return { ok: true, json: async () => ({ error: "list-only key" }) };
    }
    return {
      ok: true,
      json: async () => ({
        projects: [
          {
            project_id: PROJECT_ID,
            title: "SageMath",
            host_id: HOST_ID,
            state: "running",
            last_edited: null,
          },
        ],
        next_offset: null,
      }),
    };
  }) as typeof fetch;
  try {
    const ctx = createContext(() => {
      throw Error("account userQuery must not be called");
    });
    ctx.apiBaseUrl = "https://example.com";
    ctx.apiKey = "scoped-key";
    const project = await resolveProject(ctx, PROJECT_ID, 1000);
    assert.equal(project.title, "SageMath");
    assert.deepEqual(paths, [
      "/api/conat/project-host-api-key",
      "/api/conat/hub",
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("API key title lookup applies exact matching to scoped search results", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => ({
    ok: true,
    json: async () => ({
      projects: [
        { project_id: PROJECT_ID, title: "SageMath archive", host_id: HOST_ID },
        { project_id: HOST_ID, title: "SageMath", host_id: HOST_ID },
      ],
      next_offset: null,
    }),
  })) as unknown as typeof fetch;
  try {
    const ctx = createContext(() => {
      throw Error("account userQuery must not be called");
    });
    ctx.apiBaseUrl = "https://example.com";
    ctx.apiKey = "scoped-key";
    const project = await resolveProject(ctx, "SageMath", 1000);
    assert.equal(project.project_id, HOST_ID);
  } finally {
    global.fetch = originalFetch;
  }
});

test("queryProjects uses legacy projects reads by default", async () => {
  delete process.env.COCALC_ACCOUNT_PROJECT_INDEX_PROJECT_LIST_READS;
  delete process.env.COCALC_CLUSTER_ROLE;
  const seen: string[] = [];
  const rows = await queryProjects({
    ctx: createContext((table) => {
      seen.push(table);
      if (table === "projects") {
        return [
          {
            project_id: "22222222-2222-4222-8222-222222222222",
            title: "Legacy Project",
            host_id: null,
            state: { state: "running" },
            last_edited: "2026-04-03T00:00:00.000Z",
            deleted: false,
          },
        ];
      }
      return [];
    }),
    limit: 10,
  });
  assert.deepEqual(seen, ["projects"]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "Legacy Project");
});

test("queryProjects prefers account_project_index rows automatically in multi-bay mode", async () => {
  delete process.env.COCALC_ACCOUNT_PROJECT_INDEX_PROJECT_LIST_READS;
  process.env.COCALC_CLUSTER_ROLE = "attached";
  const seen: string[] = [];
  let projectedRow: Record<string, unknown> | undefined;
  const rows = await queryProjects({
    ctx: createContext((table, row) => {
      seen.push(table);
      if (table === "account_project_index") {
        projectedRow = row;
      }
      if (table === "account_project_index") {
        return [
          {
            account_id: ACCOUNT_ID,
            project_id: "99999999-9999-4999-8999-999999999999",
            title: "Auto Projected Project",
            host_id: "77777777-7777-4777-8777-777777777777",
            state_summary: { state: "running" },
            last_edited: "2026-04-02T00:00:00.000Z",
            sort_key: "2026-04-03T00:00:00.000Z",
            updated_at: "2026-04-03T00:00:01.000Z",
            is_hidden: false,
          },
        ];
      }
      return [];
    }),
    limit: 10,
  });
  assert.deepEqual(seen, ["account_project_index"]);
  assert.equal(projectedRow?.account_id, ACCOUNT_ID);
  assert.deepEqual(rows, [
    {
      project_id: "99999999-9999-4999-8999-999999999999",
      title: "Auto Projected Project",
      host_id: "77777777-7777-4777-8777-777777777777",
      state: { state: "running" },
      last_edited: "2026-04-02T00:00:00.000Z",
      deleted: false,
    },
  ]);
  delete process.env.COCALC_CLUSTER_ROLE;
});

test("queryProjects prefers account_project_index rows when enabled", async () => {
  process.env.COCALC_ACCOUNT_PROJECT_INDEX_PROJECT_LIST_READS = "prefer";
  const seen: string[] = [];
  const rows = await queryProjects({
    ctx: createContext((table) => {
      seen.push(table);
      if (table === "account_project_index") {
        return [
          {
            account_id: ACCOUNT_ID,
            project_id: "33333333-3333-4333-8333-333333333333",
            title: "Projected Project",
            host_id: "44444444-4444-4444-8444-444444444444",
            state_summary: { state: "stopped" },
            last_edited: "2026-04-02T00:00:00.000Z",
            sort_key: "2026-04-03T00:00:00.000Z",
            updated_at: "2026-04-03T00:00:01.000Z",
            is_hidden: false,
          },
        ];
      }
      return [];
    }),
    limit: 10,
  });
  assert.deepEqual(seen, ["account_project_index"]);
  assert.deepEqual(rows, [
    {
      project_id: "33333333-3333-4333-8333-333333333333",
      title: "Projected Project",
      host_id: "44444444-4444-4444-8444-444444444444",
      state: { state: "stopped" },
      last_edited: "2026-04-02T00:00:00.000Z",
      deleted: false,
    },
  ]);
});

test("queryProjects preserves projected user summaries for viewer role detection", async () => {
  process.env.COCALC_ACCOUNT_PROJECT_INDEX_PROJECT_LIST_READS = "prefer";
  const rows = await queryProjects({
    ctx: createContext((table) => {
      if (table === "account_project_index") {
        return [
          {
            account_id: ACCOUNT_ID,
            project_id: "12121212-1212-4212-8212-121212121212",
            title: "Viewer Project",
            host_id: "34343434-3434-4434-8434-343434343434",
            users_summary: {
              [ACCOUNT_ID]: { group: "viewer" },
            },
            is_hidden: false,
          },
        ];
      }
      return [];
    }),
    limit: 10,
  });

  assert.deepEqual(rows, [
    {
      project_id: "12121212-1212-4212-8212-121212121212",
      title: "Viewer Project",
      host_id: "34343434-3434-4434-8434-343434343434",
      state: null,
      last_edited: null,
      deleted: false,
      users_summary: {
        [ACCOUNT_ID]: { group: "viewer" },
      },
    },
  ]);
});

test("queryProjects filters hidden account_project_index rows", async () => {
  process.env.COCALC_ACCOUNT_PROJECT_INDEX_PROJECT_LIST_READS = "prefer";
  const rows = await queryProjects({
    ctx: createContext((table) => {
      if (table === "account_project_index") {
        return [
          {
            account_id: ACCOUNT_ID,
            project_id: "55555555-5555-4555-8555-555555555555",
            title: "Hidden Project",
            host_id: null,
            state_summary: { state: "running" },
            last_edited: "2026-04-01T00:00:01.000Z",
            sort_key: "2026-04-03T00:00:01.000Z",
            updated_at: "2026-04-03T00:00:01.000Z",
            is_hidden: true,
          },
          {
            account_id: ACCOUNT_ID,
            project_id: "66666666-6666-4666-8666-666666666666",
            title: "Visible Project",
            host_id: null,
            state_summary: { state: "running" },
            last_edited: "2026-04-02T00:00:00.000Z",
            sort_key: "2026-04-03T00:00:00.000Z",
            updated_at: "2026-04-03T00:00:00.000Z",
            is_hidden: false,
          },
        ];
      }
      return [];
    }),
    limit: 10,
  });
  assert.deepEqual(rows, [
    {
      project_id: "66666666-6666-4666-8666-666666666666",
      title: "Visible Project",
      host_id: null,
      state: { state: "running" },
      last_edited: "2026-04-02T00:00:00.000Z",
      deleted: false,
    },
  ]);
});

test("queryProjects does not fall back and reveal hidden projected rows", async () => {
  process.env.COCALC_ACCOUNT_PROJECT_INDEX_PROJECT_LIST_READS = "prefer";
  const seen: string[] = [];
  const rows = await queryProjects({
    ctx: createContext((table) => {
      seen.push(table);
      if (table === "account_project_index") {
        return [
          {
            account_id: ACCOUNT_ID,
            project_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            title: "Hidden Project",
            host_id: null,
            state_summary: { state: "running" },
            last_edited: "2026-04-02T00:00:00.000Z",
            sort_key: "2026-04-03T00:00:00.000Z",
            updated_at: "2026-04-03T00:00:00.000Z",
            is_hidden: true,
          },
        ];
      }
      if (table === "projects") {
        return [
          {
            project_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            title: "Hidden Project",
            host_id: null,
            state: { state: "running" },
            last_edited: "2026-04-02T00:00:00.000Z",
            deleted: false,
          },
        ];
      }
      return [];
    }),
    limit: 10,
  });
  assert.deepEqual(seen, ["account_project_index"]);
  assert.deepEqual(rows, []);
});

test("queryProjects does not treat projected sort_key as last_edited", async () => {
  process.env.COCALC_ACCOUNT_PROJECT_INDEX_PROJECT_LIST_READS = "prefer";
  const rows = await queryProjects({
    ctx: createContext((table) => {
      if (table === "account_project_index") {
        return [
          {
            account_id: ACCOUNT_ID,
            project_id: "77777777-7777-4777-8777-777777777777",
            title: "Projected Active Project",
            host_id: null,
            state_summary: { state: "running" },
            last_edited: "2026-04-01T00:00:00.000Z",
            last_activity_at: "2026-04-03T00:00:00.000Z",
            sort_key: "2026-04-04T00:00:00.000Z",
            updated_at: "2026-04-05T00:00:00.000Z",
            is_hidden: false,
          },
        ];
      }
      return [];
    }),
    limit: 10,
  });
  assert.deepEqual(rows, [
    {
      project_id: "77777777-7777-4777-8777-777777777777",
      title: "Projected Active Project",
      host_id: null,
      state: { state: "running" },
      last_edited: "2026-04-01T00:00:00.000Z",
      deleted: false,
    },
  ]);
});

test("queryProjects falls back from projection in prefer mode", async () => {
  process.env.COCALC_ACCOUNT_PROJECT_INDEX_PROJECT_LIST_READS = "prefer";
  const seen: string[] = [];
  const rows = await queryProjects({
    ctx: createContext((table) => {
      seen.push(table);
      if (table === "projects") {
        return [
          {
            project_id: "22222222-2222-4222-8222-222222222222",
            title: "Legacy Project",
            host_id: null,
            state: { state: "running" },
            last_edited: "2026-04-03T00:00:00.000Z",
            deleted: false,
          },
        ];
      }
      return [];
    }),
    limit: 10,
  });
  assert.deepEqual(seen, ["account_project_index", "projects"]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "Legacy Project");
});

test("queryProjects does not fall back in only mode", async () => {
  process.env.COCALC_ACCOUNT_PROJECT_INDEX_PROJECT_LIST_READS = "only";
  const seen: string[] = [];
  const rows = await queryProjects({
    ctx: createContext((table) => {
      seen.push(table);
      return [];
    }),
    limit: 10,
  });
  assert.deepEqual(seen, ["account_project_index"]);
  assert.deepEqual(rows, []);
});

test("resolveProject falls back to getProjectBay for remote UUID projects", async () => {
  const ctx = {
    projectCache: new Map(),
    hub: {
      db: {
        userQuery: async () => {
          throw new Error("FATAL: you do not have read access to this project");
        },
      },
      system: {
        getProjectBay: async ({ project_id }) => ({
          project_id,
          owning_bay_id: "bay-0",
          host_id: "host-1",
          title: "Remote Project",
          source: "project-row",
        }),
      },
      hosts: {},
    },
  } as any;

  const project = await resolveProject(
    ctx,
    "77777777-7777-4777-8777-777777777777",
    60_000,
  );

  assert.deepEqual(project, {
    project_id: "77777777-7777-4777-8777-777777777777",
    title: "Remote Project",
    host_id: "host-1",
    state: null,
    last_edited: null,
    deleted: false,
  });
});

test("queryProjects falls back to getProjectBay for exact remote UUID reads", async () => {
  delete process.env.COCALC_ACCOUNT_PROJECT_INDEX_PROJECT_LIST_READS;
  const ctx = {
    projectCache: new Map(),
    hub: {
      db: {
        userQuery: async () => {
          throw new Error("FATAL: you do not have read access to this project");
        },
      },
      system: {
        getProjectBay: async ({ project_id }) => ({
          project_id,
          owning_bay_id: "bay-0",
          host_id: "host-2",
          title: "Remote Query Project",
          source: "project-row",
        }),
      },
      hosts: {},
    },
  } as any;

  const rows = await queryProjects({
    ctx,
    project_id: "88888888-8888-4888-8888-888888888888",
    limit: 1,
  });

  assert.deepEqual(rows, [
    {
      project_id: "88888888-8888-4888-8888-888888888888",
      title: "Remote Query Project",
      host_id: "host-2",
      state: null,
      last_edited: null,
      deleted: false,
    },
  ]);
});

test("queryProjects explains project-scoped API key routing failures", async () => {
  delete process.env.COCALC_ACCOUNT_PROJECT_INDEX_PROJECT_LIST_READS;
  const ctx = {
    apiBaseUrl: "https://cocalc.ai",
    projectCache: new Map(),
    hub: {
      db: {
        userQuery: async () => ({}),
      },
      system: {
        getProjectBay: async () => {
          throw Object.assign(
            new Error(
              "permission denied publishing to 'hub.account.a3e24fbf-c4b9-429e-8cab-5558052195bb.api' - callHub: subject='hub.account.a3e24fbf-c4b9-429e-8cab-5558052195bb.api', name='system.getProjectBay', code='403'",
            ),
            { code: 403 },
          );
        },
      },
      hosts: {},
    },
  } as any;

  await assert.rejects(
    () =>
      queryProjects({
        ctx,
        project_id: "88888888-8888-4888-8888-888888888888",
        limit: 1,
      }),
    (err: any) => {
      assert.equal(err.code, 403);
      assert.match(err.message, /Cannot resolve project/);
      assert.match(err.message, /project-scoped/);
      assert.match(err.message, /account-level project routing lookup/);
      assert.match(err.message, /cocalc --api https:\/\/cocalc\.ai auth login/);
      assert.match(err.message, /without COCALC_API_KEY/);
      return true;
    },
  );
});

test("resolveProject explains project-scoped API key routing failures", async () => {
  delete process.env.COCALC_ACCOUNT_PROJECT_INDEX_PROJECT_LIST_READS;
  const ctx = {
    projectCache: new Map(),
    hub: {
      db: {
        userQuery: async () => ({}),
      },
      system: {
        getProjectBay: async () => {
          throw Object.assign(
            new Error(
              "permission denied publishing to 'hub.account.a3e24fbf-c4b9-429e-8cab-5558052195bb.api' - callHub: subject='hub.account.a3e24fbf-c4b9-429e-8cab-5558052195bb.api', name='system.getProjectBay', code='403'",
            ),
            { code: 403 },
          );
        },
      },
      hosts: {},
    },
  } as any;

  await assert.rejects(
    () => resolveProject(ctx, "88888888-8888-4888-8888-888888888888", 60_000),
    /project-scoped/,
  );
});

test("resolveHost accepts an explicit host UUID even when no hosts are visible", async () => {
  const host = await resolveHost(
    {
      projectCache: new Map(),
      hub: {
        db: {},
        system: {},
        hosts: {
          listHosts: async () => [],
        },
      },
    } as any,
    "99999999-9999-4999-8999-999999999999",
  );

  assert.deepEqual(host, {
    id: "99999999-9999-4999-8999-999999999999",
    name: "99999999-9999-4999-8999-999999999999",
  });
});

test("resolveHost accepts an explicit host UUID when host listing fails", async () => {
  const host = await resolveHost(
    {
      projectCache: new Map(),
      hub: {
        db: {},
        system: {},
        hosts: {
          listHosts: async () => {
            throw new Error(
              "timeout waiting for hub response: hosts.listHosts",
            );
          },
        },
      },
    } as any,
    "99999999-9999-4999-8999-999999999999",
  );

  assert.deepEqual(host, {
    id: "99999999-9999-4999-8999-999999999999",
    name: "99999999-9999-4999-8999-999999999999",
  });
});

test("resolveHost still requires visible hosts for name lookup", async () => {
  await assert.rejects(
    () =>
      resolveHost(
        {
          projectCache: new Map(),
          hub: {
            db: {},
            system: {},
            hosts: {
              listHosts: async () => [],
            },
          },
        } as any,
        "host",
      ),
    /no hosts are visible to this account/,
  );
});

test("resolveHost can include deleted hosts when requested", async () => {
  const listHosts = async (opts?: { include_deleted?: boolean }) => {
    if (opts?.include_deleted) {
      return [
        {
          id: "99999999-9999-4999-8999-999999999999",
          name: "deleted-host",
          status: "deprovisioned",
        },
      ];
    }
    return [];
  };
  const host = await resolveHost(
    {
      projectCache: new Map(),
      hub: {
        db: {},
        system: {},
        hosts: {
          listHosts,
        },
      },
    } as any,
    "deleted-host",
    { include_deleted: true },
  );

  assert.deepEqual(host, {
    id: "99999999-9999-4999-8999-999999999999",
    name: "deleted-host",
    status: "deprovisioned",
  });
});
