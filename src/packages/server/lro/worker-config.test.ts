export {};

let queryMock: jest.Mock;

type StoredOverride = {
  worker_kind: string;
  scope_type: "global" | "provider" | "project_host";
  scope_id: string;
  limit_value: number;
  enabled: boolean;
  updated_at: Date;
  updated_by: string | null;
  note: string | null;
};

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: queryMock })),
}));

describe("parallel ops worker config", () => {
  let rows: Map<string, StoredOverride>;
  let selectCount: number;

  beforeEach(() => {
    jest.resetModules();
    rows = new Map();
    selectCount = 0;
    queryMock = jest.fn(async (sql: string, params?: any[]) => {
      if (
        sql.includes("CREATE TABLE IF NOT EXISTS parallel_ops_limits") ||
        sql.includes("CREATE INDEX IF NOT EXISTS parallel_ops_limits_scope_idx")
      ) {
        return { rowCount: 0, rows: [] };
      }

      if (
        sql.includes("SELECT worker_kind, scope_type, scope_id, limit_value") &&
        sql.includes("WHERE worker_kind=$1 AND scope_type=$2 AND scope_id=$3")
      ) {
        selectCount += 1;
        const key = `${params?.[0]}:${params?.[1]}:${params?.[2]}`;
        return { rows: rows.has(key) ? [rows.get(key)] : [] };
      }

      if (sql.includes("INSERT INTO parallel_ops_limits")) {
        const row: StoredOverride = {
          worker_kind: params?.[0],
          scope_type: params?.[1],
          scope_id: params?.[2],
          limit_value: params?.[3],
          enabled: true,
          updated_at: new Date("2026-03-18T21:00:00.000Z"),
          updated_by: params?.[4] ?? null,
          note: params?.[5] ?? null,
        };
        rows.set(`${row.worker_kind}:${row.scope_type}:${row.scope_id}`, row);
        return { rows: [row] };
      }

      if (
        sql.includes("DELETE FROM parallel_ops_limits") &&
        sql.includes("WHERE worker_kind=$1 AND scope_type=$2 AND scope_id=$3")
      ) {
        rows.delete(`${params?.[0]}:${params?.[1]}:${params?.[2]}`);
        return { rowCount: 1, rows: [] };
      }

      throw new Error(`unexpected query: ${sql}`);
    });
  });

  it("returns the default limit and caches repeated lookups", async () => {
    const { clearParallelOpsLimitCache, getEffectiveParallelOpsLimit } =
      await import("./worker-config");

    clearParallelOpsLimitCache();
    await expect(
      getEffectiveParallelOpsLimit({
        worker_kind: "project-move",
        default_limit: 1,
      }),
    ).resolves.toEqual({ value: 1, source: "default" });
    await expect(
      getEffectiveParallelOpsLimit({
        worker_kind: "project-move",
        default_limit: 1,
      }),
    ).resolves.toEqual({ value: 1, source: "default" });
    expect(selectCount).toBe(1);
  });

  it("applies and clears a global override", async () => {
    const {
      clearParallelOpsLimitCache,
      clearParallelOpsLimitOverride,
      getEffectiveParallelOpsLimit,
      setParallelOpsLimitOverride,
    } = await import("./worker-config");

    clearParallelOpsLimitCache();
    await expect(
      setParallelOpsLimitOverride({
        worker_kind: "project-backup",
        limit_value: 17,
        updated_by: "62bb9ea3-41df-4539-bd42-d14dfe80a7e0",
        note: "raise for canary",
      }),
    ).resolves.toMatchObject({
      worker_kind: "project-backup",
      scope_type: "global",
      scope_id: "",
      limit_value: 17,
      enabled: true,
      updated_by: "62bb9ea3-41df-4539-bd42-d14dfe80a7e0",
      note: "raise for canary",
    });

    await expect(
      getEffectiveParallelOpsLimit({
        worker_kind: "project-backup",
        default_limit: 10,
      }),
    ).resolves.toEqual({ value: 17, source: "db-override" });

    await clearParallelOpsLimitOverride({
      worker_kind: "project-backup",
    });

    await expect(
      getEffectiveParallelOpsLimit({
        worker_kind: "project-backup",
        default_limit: 10,
      }),
    ).resolves.toEqual({ value: 10, source: "default" });
  });

  it("applies and clears a per-project-host override", async () => {
    const {
      clearParallelOpsLimitCache,
      clearParallelOpsLimitOverride,
      getEffectiveParallelOpsLimit,
      setParallelOpsLimitOverride,
    } = await import("./worker-config");

    clearParallelOpsLimitCache();
    await expect(
      setParallelOpsLimitOverride({
        worker_kind: "project-host-backup-execution",
        scope_type: "project_host",
        scope_id: "host-123",
        limit_value: 14,
        updated_by: "62bb9ea3-41df-4539-bd42-d14dfe80a7e0",
        note: "raise host-local slots",
      }),
    ).resolves.toMatchObject({
      worker_kind: "project-host-backup-execution",
      scope_type: "project_host",
      scope_id: "host-123",
      limit_value: 14,
      enabled: true,
    });

    await expect(
      getEffectiveParallelOpsLimit({
        worker_kind: "project-host-backup-execution",
        default_limit: 10,
        scope_type: "project_host",
        scope_id: "host-123",
      }),
    ).resolves.toEqual({ value: 14, source: "db-override" });

    await clearParallelOpsLimitOverride({
      worker_kind: "project-host-backup-execution",
      scope_type: "project_host",
      scope_id: "host-123",
    });

    await expect(
      getEffectiveParallelOpsLimit({
        worker_kind: "project-host-backup-execution",
        default_limit: 10,
        scope_type: "project_host",
        scope_id: "host-123",
      }),
    ).resolves.toEqual({ value: 10, source: "default" });
  });
});
