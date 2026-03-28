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
  let prevDebugCap: string | undefined;

  beforeEach(() => {
    jest.resetModules();
    rows = new Map();
    selectCount = 0;
    prevDebugCap = process.env.COCALC_PARALLEL_OPS_DEBUG_CAP;
    delete process.env.COCALC_PARALLEL_OPS_DEBUG_CAP;
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

      if (
        sql.includes("SELECT worker_kind, scope_type, scope_id, limit_value") &&
        sql.includes("scope_id = ANY($3::text[])")
      ) {
        return {
          rows: (params?.[2] ?? [])
            .map(
              (scope_id: string) =>
                rows.get(`${params?.[0]}:${params?.[1]}:${scope_id}`) ?? null,
            )
            .filter(Boolean),
        };
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

  afterEach(() => {
    if (prevDebugCap == null) {
      delete process.env.COCALC_PARALLEL_OPS_DEBUG_CAP;
    } else {
      process.env.COCALC_PARALLEL_OPS_DEBUG_CAP = prevDebugCap;
    }
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

  it("caps global limits via the debug env", async () => {
    const { clearParallelOpsLimitCache, getEffectiveParallelOpsLimit } =
      await import("./worker-config");

    process.env.COCALC_PARALLEL_OPS_DEBUG_CAP = "1";
    clearParallelOpsLimitCache();
    await expect(
      getEffectiveParallelOpsLimit({
        worker_kind: "project-rootfs-publish",
        default_limit: 100,
      }),
    ).resolves.toEqual({ value: 1, source: "env-debug-cap" });
  });

  it("caps per-project-host limits via the debug env", async () => {
    const {
      clearParallelOpsLimitCache,
      getEffectiveParallelOpsLimit,
      getEffectiveParallelOpsLimits,
      setParallelOpsLimitOverride,
    } = await import("./worker-config");

    await setParallelOpsLimitOverride({
      worker_kind: "project-rootfs-publish-host",
      scope_type: "project_host",
      scope_id: "host-a",
      limit_value: 4,
    });
    process.env.COCALC_PARALLEL_OPS_DEBUG_CAP = "1";
    clearParallelOpsLimitCache();

    await expect(
      getEffectiveParallelOpsLimit({
        worker_kind: "project-rootfs-publish-host",
        default_limit: 2,
        scope_type: "project_host",
        scope_id: "host-a",
      }),
    ).resolves.toEqual({ value: 1, source: "env-debug-cap" });

    await expect(
      getEffectiveParallelOpsLimits({
        worker_kind: "project-rootfs-publish-host",
        default_limit: 2,
        scope_type: "project_host",
        scope_ids: ["host-a", "host-b"],
      }),
    ).resolves.toEqual(
      new Map([
        ["host-a", { value: 1, source: "env-debug-cap" }],
        ["host-b", { value: 1, source: "env-debug-cap" }],
      ]),
    );
  });

  it("resolves multiple per-project-host limits in one query", async () => {
    const {
      getEffectiveParallelOpsLimits,
      getEffectiveParallelOpsLimitsByDefaultMap,
      setParallelOpsLimitOverride,
    } = await import("./worker-config");

    await setParallelOpsLimitOverride({
      worker_kind: "project-move-source-host",
      scope_type: "project_host",
      scope_id: "host-b",
      limit_value: 3,
    });

    await expect(
      getEffectiveParallelOpsLimits({
        worker_kind: "project-move-source-host",
        default_limit: 1,
        scope_type: "project_host",
        scope_ids: ["host-a", "host-b"],
      }),
    ).resolves.toEqual(
      new Map([
        ["host-a", { value: 1, source: "default" }],
        ["host-b", { value: 3, source: "db-override" }],
      ]),
    );

    await expect(
      getEffectiveParallelOpsLimitsByDefaultMap({
        worker_kind: "project-move-source-host",
        default_limits: new Map([
          ["host-a", 2],
          ["host-b", 4],
        ]),
        scope_type: "project_host",
      }),
    ).resolves.toEqual(
      new Map([
        ["host-a", { value: 2, source: "default" }],
        ["host-b", { value: 3, source: "db-override" }],
      ]),
    );
  });
});
