import assert from "node:assert/strict";
import test from "node:test";

import { queryProjects, resolveProject } from "./project-resolve";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

function createContext(handler: (table: string) => any[]) {
  return {
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
            [table]: handler(table),
          };
        },
      },
      system: {},
      hosts: {},
    },
  } as any;
}

test("queryProjects uses legacy projects reads by default", async () => {
  delete process.env.COCALC_ACCOUNT_PROJECT_INDEX_PROJECT_LIST_READS;
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
      last_edited: "2026-04-03T00:00:00.000Z",
      deleted: false,
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
      last_edited: "2026-04-03T00:00:00.000Z",
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
