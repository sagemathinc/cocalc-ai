/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

let queryMock: jest.Mock;
let connectQueryMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    query: (...args: any[]) => queryMock(...args),
    connect: async () => ({
      query: (...args: any[]) => connectQueryMock(...args),
      release: jest.fn(),
    }),
  })),
}));

describe("expireDueLros", () => {
  beforeEach(() => {
    jest.resetModules();
    connectQueryMock = jest.fn(async () => ({ rows: [] }));
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("UPDATE long_running_operations")) {
        return {
          rows: [
            {
              op_id: "11111111-1111-1111-1111-111111111111",
              kind: "project-move",
              status: "expired",
            },
          ],
        };
      }
      return { rows: [] };
    });
  });

  it("marks active expired LROs terminal for one kind", async () => {
    const { expireDueLros } = await import("./lro-db");

    await expect(expireDueLros({ kind: "project-move" })).resolves.toEqual([
      expect.objectContaining({
        kind: "project-move",
        status: "expired",
      }),
    ]);

    const expireCall = queryMock.mock.calls.find(([sql]) =>
      `${sql}`.includes("UPDATE long_running_operations"),
    );
    expect(expireCall).toBeDefined();
    expect(expireCall?.[0]).toContain("expires_at <= now()");
    expect(expireCall?.[0]).toContain("status = ANY($1::text[])");
    expect(expireCall?.[0]).toContain("FOR UPDATE SKIP LOCKED");
    expect(expireCall?.[0]).toContain("LIMIT $3");
    expect(expireCall?.[0]).toContain("kind=$2");
    expect(expireCall?.[1]).toEqual([
      ["queued", "running"],
      "project-move",
      1000,
    ]);
  });

  it("can expire all active LRO kinds", async () => {
    const { expireDueLros } = await import("./lro-db");

    await expireDueLros();

    const expireCall = queryMock.mock.calls.find(([sql]) =>
      `${sql}`.includes("UPDATE long_running_operations"),
    );
    expect(expireCall).toBeDefined();
    expect(expireCall?.[0]).not.toContain("kind=$2");
    expect(expireCall?.[1]).toEqual([["queued", "running"], 1000]);
  });
});

describe("expireOrphanedProjectBackupLros", () => {
  beforeEach(() => {
    jest.resetModules();
    connectQueryMock = jest.fn(async () => ({ rows: [] }));
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("project no longer exists")) {
        return {
          rows: [
            {
              op_id: "11111111-1111-1111-1111-111111111111",
              kind: "project-backup",
              status: "expired",
            },
          ],
        };
      }
      return { rows: [] };
    });
  });

  it("only expires queued project backups with no project row", async () => {
    const { expireOrphanedProjectBackupLros } = await import("./lro-db");

    await expect(
      expireOrphanedProjectBackupLros({ limit: 25 }),
    ).resolves.toEqual([
      expect.objectContaining({
        kind: "project-backup",
        status: "expired",
      }),
    ]);

    const expireCall = queryMock.mock.calls.find(([sql]) =>
      `${sql}`.includes("project no longer exists"),
    );
    expect(expireCall?.[0]).toContain("lro.kind='project-backup'");
    expect(expireCall?.[0]).toContain("lro.status='queued'");
    expect(expireCall?.[0]).toContain("NOT EXISTS");
    expect(expireCall?.[0]).toContain("projects.project_id=lro.scope_id");
    expect(expireCall?.[1]).toEqual([25]);
  });
});

describe("createLroDetailed", () => {
  beforeEach(() => {
    jest.resetModules();
    queryMock = jest.fn(async () => ({ rows: [] }));
  });

  it("serializes deduplicated creation and reports a reused operation", async () => {
    const existing = {
      op_id: "11111111-1111-4111-8111-111111111111",
      kind: "project-start",
      scope_type: "project",
      scope_id: "22222222-2222-4222-8222-222222222222",
      status: "running",
    };
    connectQueryMock = jest.fn(async (sql: string) => {
      if (sql.includes("pg_try_advisory_lock")) {
        return { rows: [{ acquired: false }] };
      }
      if (sql.includes("SELECT *") && sql.includes("dedupe_key=$3")) {
        return { rows: [existing] };
      }
      return { rows: [] };
    });
    const { createLroDetailed } = await import("./lro-db");

    await expect(
      createLroDetailed({
        kind: "project-start",
        scope_type: "project",
        scope_id: existing.scope_id,
        dedupe_key: "project-start:start:default",
      }),
    ).resolves.toEqual({ lro: existing, created: false });

    const sql = connectQueryMock.mock.calls.map(
      ([statement]) => `${statement}`,
    );
    expect(sql).toContain("BEGIN");
    expect(
      sql.some((statement) => statement.includes("pg_advisory_xact_lock")),
    ).toBe(true);
    expect(sql).toContain("COMMIT");
    expect(sql.some((statement) => statement.includes("INSERT INTO"))).toBe(
      false,
    );
  });

  it("creates exactly one operation while holding the dedupe lock", async () => {
    const created = {
      op_id: "11111111-1111-4111-8111-111111111111",
      kind: "project-start",
      scope_type: "project",
      scope_id: "22222222-2222-4222-8222-222222222222",
      status: "queued",
    };
    connectQueryMock = jest.fn(async (sql: string) => {
      if (sql.includes("pg_try_advisory_lock")) {
        return { rows: [{ acquired: false }] };
      }
      if (sql.includes("INSERT INTO")) {
        return { rows: [created] };
      }
      return { rows: [] };
    });
    const { createLroDetailed } = await import("./lro-db");

    await expect(
      createLroDetailed({
        kind: "project-start",
        scope_type: "project",
        scope_id: created.scope_id,
        dedupe_key: "project-start:start:default",
      }),
    ).resolves.toEqual({ lro: created, created: true });

    const sql = connectQueryMock.mock.calls.map(
      ([statement]) => `${statement}`,
    );
    expect(sql.indexOf("BEGIN")).toBeLessThan(
      sql.findIndex((statement) => statement.includes("INSERT INTO")),
    );
    expect(sql).toContain("COMMIT");
  });

  it("can reuse a terminal operation for an idempotent request", async () => {
    const existing = {
      op_id: "11111111-1111-4111-8111-111111111111",
      kind: "copy-path-between-projects",
      scope_type: "project",
      scope_id: "22222222-2222-4222-8222-222222222222",
      status: "succeeded",
    };
    connectQueryMock = jest.fn(async (sql: string) => {
      if (sql.includes("SELECT *") && sql.includes("dedupe_key=$3")) {
        return { rows: [existing] };
      }
      return { rows: [] };
    });
    const { createLroDetailed } = await import("./lro-db");

    await expect(
      createLroDetailed({
        kind: "copy-path-between-projects",
        scope_type: "project",
        scope_id: existing.scope_id,
        dedupe_key: "copy-path-between-projects:request-1",
        reuse_terminal_dedupe: true,
      }),
    ).resolves.toEqual({ lro: existing, created: false });

    const select = connectQueryMock.mock.calls.find(([sql]) =>
      `${sql}`.includes("dedupe_key=$3"),
    );
    expect(select?.[0]).not.toContain("status <> ALL");
    expect(select?.[1]).toEqual([
      "project",
      existing.scope_id,
      "copy-path-between-projects:request-1",
    ]);
  });
});

describe("updateLro", () => {
  beforeEach(() => {
    jest.resetModules();
    connectQueryMock = jest.fn(async () => ({ rows: [] }));
    queryMock = jest.fn(async (sql: string, values: unknown[]) => ({
      rows: [
        {
          op_id: values[0],
          status: "canceled",
        },
      ],
    }));
  });

  it("can make a terminal transition conditional on the active statuses", async () => {
    const { updateLro } = await import("./lro-db");

    await updateLro({
      op_id: "11111111-1111-4111-8111-111111111111",
      status: "canceled",
      error: "canceled",
      if_status: ["queued", "running"],
    });

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("status=ANY($4::text[])"),
      [
        "11111111-1111-4111-8111-111111111111",
        "canceled",
        "canceled",
        ["queued", "running"],
      ],
    );
  });
});

describe("claimLroOps", () => {
  beforeEach(() => {
    jest.resetModules();
    connectQueryMock = jest.fn(async () => ({ rows: [] }));
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("UPDATE long_running_operations")) {
        return { rows: [] };
      }
      if (sql.includes("CREATE TABLE") || sql.includes("CREATE INDEX")) {
        return { rows: [] };
      }
      return { rows: [] };
    });
  });

  it("can defer claims until an input timestamp", async () => {
    const { claimLroOps } = await import("./lro-db");

    await claimLroOps({
      kind: "course-collect-assignment",
      owner_type: "hub",
      owner_id: "11111111-1111-4111-8111-111111111111",
      input_not_before_key: "run_at",
    });

    const claimCall = connectQueryMock.mock.calls.find(([sql]) =>
      `${sql}`.includes("FOR UPDATE SKIP LOCKED"),
    );
    expect(claimCall).toBeDefined();
    expect(claimCall?.[0]).toContain("input ->> $6");
    expect(claimCall?.[1]).toEqual([
      "course-collect-assignment",
      120000,
      10,
      "hub",
      "11111111-1111-4111-8111-111111111111",
      "run_at",
    ]);
    expect(
      queryMock.mock.calls.some(([sql]) =>
        `${sql}`.includes("WITH candidates AS"),
      ),
    ).toBe(false);
  });
});

describe("touchLro", () => {
  beforeEach(() => {
    jest.resetModules();
    connectQueryMock = jest.fn(async () => ({ rows: [] }));
    queryMock = jest.fn(async () => ({ rows: [] }));
  });

  it("does not refresh terminal LROs", async () => {
    const { touchLro } = await import("./lro-db");

    await touchLro({
      op_id: "11111111-1111-1111-1111-111111111111",
      owner_type: "hub",
      owner_id: "22222222-2222-4222-8222-222222222222",
    });

    const touchCall = queryMock.mock.calls.find(([sql]) =>
      `${sql}`.includes("UPDATE long_running_operations"),
    );
    expect(touchCall).toBeDefined();
    expect(touchCall?.[0]).toContain("status <> ALL($4::text[])");
    expect(touchCall?.[1]).toEqual([
      "11111111-1111-1111-1111-111111111111",
      "hub",
      "22222222-2222-4222-8222-222222222222",
      ["succeeded", "failed", "canceled", "expired"],
    ]);
  });
});

describe("ensureLroSchema", () => {
  beforeEach(() => {
    jest.resetModules();
    connectQueryMock = jest.fn(async () => ({ rows: [] }));
    queryMock = jest.fn(async () => ({ rows: [] }));
  });

  it("migrates child LRO parent tracking into existing tables", async () => {
    connectQueryMock = jest.fn(async (sql: string) => {
      if (sql.includes("information_schema.columns")) {
        return { rows: [{ exists: false }] };
      }
      if (sql.includes("pg_try_advisory_lock")) {
        return { rows: [{ locked: true }] };
      }
      return { rows: [] };
    });
    const { ensureLroSchema } = await import("./lro-db");

    await ensureLroSchema();

    const sql = connectQueryMock.mock.calls.map(([sql]) => `${sql}`);
    expect(sql.some((x) => x.includes("pg_advisory_lock"))).toBe(true);
    expect(sql.some((x) => x.includes("pg_advisory_unlock"))).toBe(true);
    expect(
      sql.some((x) => x.includes("ADD COLUMN IF NOT EXISTS parent_id UUID")),
    ).toBe(true);
    expect(sql.some((x) => x.includes("lro_parent_idx"))).toBe(true);
    expect(sql.some((x) => x.includes("lro_expiry_idx"))).toBe(true);

    await ensureLroSchema();
    expect(
      connectQueryMock.mock.calls.filter(([statement]) =>
        `${statement}`.includes("pg_advisory_lock"),
      ),
    ).toHaveLength(1);
  });
});
