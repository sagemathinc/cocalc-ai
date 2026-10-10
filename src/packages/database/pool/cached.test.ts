/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

type PoolLike = {
  query: jest.Mock;
};

type CachedModule = {
  default: (options?: any) => any;
};

const loadCached = async () => {
  jest.resetModules();
  const pool: PoolLike = {
    query: jest.fn(),
  };
  const getPool = jest.fn(() => pool);

  jest.doMock("./pool", () => ({
    __esModule: true,
    default: getPool,
    shouldSkipEnsureExists: () => false,
  }));

  jest.doMock("@cocalc/backend/logger", () => {
    const makeLogger = () => ({
      debug: jest.fn(),
      error: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
    });
    const getLogger = () => makeLogger();
    return {
      __esModule: true,
      default: getLogger,
      getLogger,
    };
  });

  const cachedModule = (await import("./cached")) as CachedModule;
  return { getCachedPool: cachedModule.default, getPool, pool };
};

describe("getCachedPool", () => {
  it("forwards ensureExists to getPool and caches hits", async () => {
    const { getCachedPool, getPool, pool } = await loadCached();
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });

    const cached = getCachedPool({ cacheTime: "short", ensureExists: false });
    await cached.query("SELECT 1");

    expect(getPool).toHaveBeenCalledWith({ ensureExists: false });
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it("reuses cached results for identical queries", async () => {
    const { getCachedPool, pool } = await loadCached();
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });

    const cached = getCachedPool("short");
    await cached.query("SELECT 1");
    await cached.query("SELECT 1");

    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it("does not cache empty results", async () => {
    const { getCachedPool, pool } = await loadCached();
    pool.query.mockResolvedValue({ rows: [] });

    const cached = getCachedPool("short");
    await cached.query("SELECT 1");
    await cached.query("SELECT 1");

    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it("never caches or merges writes", async () => {
    const { getCachedPool, pool } = await loadCached();
    pool.query.mockResolvedValue({ rows: [{ count: 1 }] });

    const cached = getCachedPool("short");
    const write =
      "UPDATE email_counter SET count = count + 1 WHERE id=$1 RETURNING count";
    // Concurrent identical calls each reach the database...
    await Promise.all([cached.query(write, ["a"]), cached.query(write, ["a"])]);
    // ...and so does a later identical one.
    await cached.query(write, ["a"]);

    expect(pool.query).toHaveBeenCalledTimes(3);
  });

  it.each([
    "INSERT INTO t (a) VALUES ($1) RETURNING a",
    "DELETE FROM t WHERE id=$1 RETURNING id",
    "WITH doomed AS (SELECT id FROM t) DELETE FROM t USING doomed WHERE t.id=doomed.id RETURNING t.id",
    "SELECT * FROM t WHERE id=$1 FOR UPDATE",
    "SELECT * FROM t WHERE id=$1 FOR NO KEY UPDATE",
    "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
    "SELECT nextval('seq')",
    // a "--" inside a literal is not a comment
    "WITH label AS (SELECT '--' AS marker), changed AS (UPDATE t SET n=n+1 RETURNING n) SELECT n FROM changed",
    // functions not known to be read-only, e.g. one that deletes
    "SELECT lo_unlink($1)",
    "SELECT my_app_function($1) AS result",
    'SELECT "lo_unlink"($1)',
    "SELECT public.do_something($1)",
    // an unterminated literal
    "SELECT 'oops",
    { text: "UPDATE t SET a=1 WHERE id=$1 RETURNING a" },
  ])("does not cache %p", async (query) => {
    const { getCachedPool, pool } = await loadCached();
    pool.query.mockResolvedValue({ rows: [{ a: 1 }] });

    const cached = getCachedPool("medium");
    await cached.query(query, ["x"]);
    await cached.query(query, ["x"]);

    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it.each([
    "SELECT title FROM projects WHERE project_id=$1",
    "  -- a comment mentioning update\n  SELECT a FROM t WHERE note = 'delete me'",
    'WITH x AS (SELECT 1 AS "update") SELECT * FROM x',
    "SELECT $tag$ update t set a=1; $tag$ AS text, E'it\\'s -- not a comment' AS s",
    "SELECT COUNT(*), coalesce(max(created), now()) FROM t WHERE id = ANY($1::UUID[])",
    "SELECT e.key FROM jsonb_each($1::jsonb) AS e(key, value)",
    { text: "SELECT 1" },
  ])("caches the read %p", async (query) => {
    const { getCachedPool, pool } = await loadCached();
    pool.query.mockResolvedValue({ rows: [{ a: 1 }] });

    const cached = getCachedPool("medium");
    await cached.query(query, ["x"]);
    await cached.query(query, ["x"]);

    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it("freezes cached rows outside production, since callers share them", async () => {
    const { getCachedPool, pool } = await loadCached();
    pool.query.mockResolvedValueOnce({
      rows: [
        { id: 1, users: { a: { group: "owner" } }, data: Buffer.from("x") },
      ],
    });

    const cached = getCachedPool("short");
    const { rows } = await cached.query("SELECT 1");

    expect(Object.isFrozen(rows[0])).toBe(true);
    expect(Object.isFrozen(rows[0].users.a)).toBe(true);
    expect(() => {
      rows[0].users.a.group = "collaborator";
    }).toThrow(TypeError);
    expect(Buffer.isBuffer(rows[0].data)).toBe(true);
  });

  it("throws on invalid cache names", async () => {
    const { getCachedPool } = await loadCached();
    const cached = getCachedPool("invalid" as any);

    await expect(cached.query("SELECT 1")).rejects.toThrow(
      'invalid cache "invalid"',
    );
  });

  it("returns the underlying pool when cache is disabled", async () => {
    const { getCachedPool, getPool, pool } = await loadCached();
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });

    const cached = getCachedPool({ cacheTime: "short", ensureExists: false });
    expect(cached).not.toBe(pool);
    await cached.query("SELECT 1");

    const direct = getCachedPool();
    expect(direct).toBe(pool);
    expect(getPool).toHaveBeenLastCalledWith({ ensureExists: true });
  });
});
