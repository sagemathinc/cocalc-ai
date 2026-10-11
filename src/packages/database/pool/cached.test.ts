/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

type PoolLike = {
  query: jest.Mock;
};

type CachedModule = {
  getCachedReadPool: (cacheTime: any, options?: any) => any;
};

// production: load the module as in production, where a query that is not a
// plain read runs uncached instead of throwing.
const loadCached = async ({ production = false } = {}) => {
  jest.resetModules();
  const nodeEnv = process.env.NODE_ENV;
  if (production) process.env.NODE_ENV = "production";
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
  process.env.NODE_ENV = nodeEnv;
  return { getCachedReadPool: cachedModule.getCachedReadPool, getPool, pool };
};

describe("getCachedReadPool", () => {
  it("forwards ensureExists to getPool and caches hits", async () => {
    const { getCachedReadPool, getPool, pool } = await loadCached();
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });

    const cached = getCachedReadPool("short", { ensureExists: false });
    await cached.query("SELECT 1");

    expect(getPool).toHaveBeenCalledWith({ ensureExists: false });
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it("reuses cached results for identical queries", async () => {
    const { getCachedReadPool, pool } = await loadCached();
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });

    const cached = getCachedReadPool("short");
    await cached.query("SELECT 1");
    await cached.query("SELECT 1");

    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it("does not cache empty results", async () => {
    const { getCachedReadPool, pool } = await loadCached();
    pool.query.mockResolvedValue({ rows: [] });

    const cached = getCachedReadPool("short");
    await cached.query("SELECT 1");
    await cached.query("SELECT 1");

    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it("refuses a write outside production", async () => {
    const { getCachedReadPool, pool } = await loadCached();
    const cached = getCachedReadPool("short");
    await expect(
      cached.query("UPDATE t SET n = n + 1 WHERE id=$1 RETURNING n", ["a"]),
    ).rejects.toThrow("not a plain read");
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("in production, never caches or merges writes", async () => {
    const { getCachedReadPool, pool } = await loadCached({ production: true });
    pool.query.mockResolvedValue({ rows: [{ count: 1 }] });

    const cached = getCachedReadPool("short");
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
    // Outside production it is refused...
    const strict = await loadCached();
    await expect(
      strict.getCachedReadPool("medium").query(query, ["x"]),
    ).rejects.toThrow("not a plain read");
    expect(strict.pool.query).not.toHaveBeenCalled();

    // ...and in production it runs, uncached.
    const { getCachedReadPool, pool } = await loadCached({ production: true });
    pool.query.mockResolvedValue({ rows: [{ a: 1 }] });
    const cached = getCachedReadPool("medium");
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
    const { getCachedReadPool, pool } = await loadCached();
    pool.query.mockResolvedValue({ rows: [{ a: 1 }] });

    const cached = getCachedReadPool("medium");
    await cached.query(query, ["x"]);
    await cached.query(query, ["x"]);

    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it("freezes cached rows outside production, since callers share them", async () => {
    const { getCachedReadPool, pool } = await loadCached();
    pool.query.mockResolvedValueOnce({
      rows: [
        { id: 1, users: { a: { group: "owner" } }, data: Buffer.from("x") },
      ],
    });

    const cached = getCachedReadPool("short");
    const { rows } = await cached.query("SELECT 1");

    expect(Object.isFrozen(rows[0])).toBe(true);
    expect(Object.isFrozen(rows[0].users.a)).toBe(true);
    expect(() => {
      rows[0].users.a.group = "collaborator";
    }).toThrow(TypeError);
    expect(Buffer.isBuffer(rows[0].data)).toBe(true);
  });

  it("gives each caller its own rows array", async () => {
    const { getCachedReadPool, pool } = await loadCached();
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });

    const cached = getCachedReadPool("short");
    const first = await cached.query("SELECT 1");
    first.rows.unshift({ id: 0 });
    first.rows.sort((a, b) => b.id - a.id);
    const second = await cached.query("SELECT 1");

    expect(second.rows).toEqual([{ id: 1 }]);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it("throws on invalid cache names", async () => {
    const { getCachedReadPool } = await loadCached();
    expect(() => getCachedReadPool("invalid" as any)).toThrow(
      'invalid cache "invalid"',
    );
    expect(() => getCachedReadPool("" as any)).toThrow("invalid cache");
  });

  it("offers only query(), not a pool", async () => {
    const { getCachedReadPool, pool } = await loadCached();
    const cached = getCachedReadPool("short");
    expect(cached).not.toBe(pool);
    expect(Object.keys(cached)).toEqual(["query"]);
  });
});
