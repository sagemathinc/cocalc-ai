/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Pool } from "pg";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
};

const defer = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

type PgMock = typeof import("pg") & {
  __reset: () => void;
  __getPoolQueryMock: () => jest.Mock;
  __getClientQueryMock: () => jest.Mock;
  __getClientInstances: () => Array<{ options: Record<string, unknown> }>;
  __setClientImpls: (impls: {
    connect?: jest.Mock;
    query?: jest.Mock;
    end?: jest.Mock;
  }) => void;
};

const originalEnv = {
  COCALC_DB: process.env.COCALC_DB,
  COCALC_TEST_USE_PGLITE: process.env.COCALC_TEST_USE_PGLITE,
  COCALC_PGLITE_DATA_DIR: process.env.COCALC_PGLITE_DATA_DIR,
};

beforeAll(() => {
  delete process.env.COCALC_DB;
  delete process.env.COCALC_TEST_USE_PGLITE;
  delete process.env.COCALC_PGLITE_DATA_DIR;
});

afterAll(() => {
  if (originalEnv.COCALC_DB == null) {
    delete process.env.COCALC_DB;
  } else {
    process.env.COCALC_DB = originalEnv.COCALC_DB;
  }
  if (originalEnv.COCALC_TEST_USE_PGLITE == null) {
    delete process.env.COCALC_TEST_USE_PGLITE;
  } else {
    process.env.COCALC_TEST_USE_PGLITE = originalEnv.COCALC_TEST_USE_PGLITE;
  }
  if (originalEnv.COCALC_PGLITE_DATA_DIR == null) {
    delete process.env.COCALC_PGLITE_DATA_DIR;
  } else {
    process.env.COCALC_PGLITE_DATA_DIR = originalEnv.COCALC_PGLITE_DATA_DIR;
  }
});

jest.mock("@cocalc/backend/data", () => ({
  pgdatabase: "cocalc",
  pghost: "db-host:1234",
  pguser: "smc",
  pgssl: false,
}));

jest.mock("@cocalc/backend/logger", () => {
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

jest.mock("./password", () => ({
  __esModule: true,
  default: jest.fn(() => "pw"),
}));

jest.mock("@cocalc/database/postgres/schema", () => ({
  __esModule: true,
  schemaNeedsSync: jest.fn().mockResolvedValue(false),
  syncSchema: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("pg", () => {
  const poolInstances: any[] = [];
  const clientInstances: any[] = [];

  let poolQueryImpl = jest.fn().mockResolvedValue({ rows: [] });
  let poolConnectImpl = jest.fn().mockResolvedValue({
    release: jest.fn(),
    query: jest.fn(),
  });
  let poolEndImpl = jest.fn().mockResolvedValue(undefined);

  let clientConnectImpl = jest.fn().mockResolvedValue(undefined);
  let clientQueryImpl = jest.fn().mockResolvedValue({ rows: [] });
  let clientEndImpl = jest.fn().mockResolvedValue(undefined);

  class Pool {
    options: any;
    on = jest.fn();
    query = (...args: any[]) => poolQueryImpl(...args);
    connect = (...args: any[]) => poolConnectImpl(...args);
    end = (...args: any[]) => poolEndImpl(...args);

    constructor(options: any) {
      this.options = options;
      poolInstances.push(this);
    }
  }

  class Client {
    options: any;
    connect = (...args: any[]) => clientConnectImpl(...args);
    query = (...args: any[]) => clientQueryImpl(...args);
    end = (...args: any[]) => clientEndImpl(...args);

    constructor(options: any) {
      this.options = options;
      clientInstances.push(this);
    }
  }

  return {
    Pool,
    Client,
    types: {
      setTypeParser: jest.fn(),
    },
    __reset: () => {
      poolInstances.length = 0;
      clientInstances.length = 0;
      poolQueryImpl = jest.fn().mockResolvedValue({ rows: [] });
      poolConnectImpl = jest.fn().mockResolvedValue({
        release: jest.fn(),
        query: jest.fn(),
      });
      poolEndImpl = jest.fn().mockResolvedValue(undefined);
      clientConnectImpl = jest.fn().mockResolvedValue(undefined);
      clientQueryImpl = jest.fn().mockResolvedValue({ rows: [] });
      clientEndImpl = jest.fn().mockResolvedValue(undefined);
    },
    __getPoolQueryMock: () => poolQueryImpl,
    __getClientQueryMock: () => clientQueryImpl,
    __getClientInstances: () => clientInstances,
    __setClientImpls: ({
      connect,
      query,
      end,
    }: {
      connect?: jest.Mock;
      query?: jest.Mock;
      end?: jest.Mock;
    }) => {
      if (connect) clientConnectImpl = connect;
      if (query) clientQueryImpl = query;
      if (end) clientEndImpl = end;
    },
  };
});

const loadPool = async () => {
  jest.resetModules();
  const pgMock = jest.requireMock("pg") as PgMock;
  pgMock.__reset();
  const schemaMock = jest.requireMock("@cocalc/database/postgres/schema") as {
    schemaNeedsSync: jest.Mock;
    syncSchema: jest.Mock;
  };
  schemaMock.schemaNeedsSync.mockReset();
  schemaMock.syncSchema.mockReset();
  schemaMock.schemaNeedsSync.mockResolvedValue(false);
  schemaMock.syncSchema.mockResolvedValue(undefined);
  const poolModule = await import("./pool");
  return { pgMock, poolModule, schemaMock };
};

describe("pool getPool ensureExists", () => {
  it("waits for ensureDatabaseExists before running queries", async () => {
    const { pgMock, poolModule } = await loadPool();
    const connectDeferred = defer<void>();
    const clientQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({});
    pgMock.__setClientImpls({
      connect: jest.fn(() => connectDeferred.promise),
      query: clientQuery,
      end: jest.fn().mockResolvedValue(undefined),
    });

    const getPool = poolModule.default as (options?: unknown) => Pool;
    const pool = getPool();
    const poolQueryMock = pgMock.__getPoolQueryMock();

    const queryPromise = pool.query("SELECT 1");
    expect(poolQueryMock).not.toHaveBeenCalled();

    const clientInstances = pgMock.__getClientInstances();
    expect(clientInstances).toHaveLength(1);
    expect(clientInstances[0].options).toMatchObject({
      database: "postgres",
      host: "db-host",
      port: 1234,
      user: "smc",
      ssl: false,
    });

    connectDeferred.resolve();
    await queryPromise;

    expect(clientQuery).toHaveBeenCalledWith(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      ["cocalc"],
    );
    expect(clientQuery).toHaveBeenCalledWith('CREATE DATABASE "cocalc"');
    expect(poolQueryMock).toHaveBeenCalledWith("SELECT 1");
  });

  it("skips ensureDatabaseExists when disabled", async () => {
    const { pgMock, poolModule } = await loadPool();
    const getPool = poolModule.default as (options?: unknown) => Pool;
    const pool = getPool({ ensureExists: false });
    const poolQueryMock = pgMock.__getPoolQueryMock();

    await pool.query("SELECT 1");

    expect(pgMock.__getClientInstances()).toHaveLength(0);
    expect(poolQueryMock).toHaveBeenCalledWith("SELECT 1");
  });

  it("surfaces ensureDatabaseExists failures to callbacks", async () => {
    const { pgMock, poolModule } = await loadPool();
    const failure = new Error("no db");
    pgMock.__setClientImpls({
      connect: jest.fn().mockRejectedValue(failure),
    });

    const getPool = poolModule.default as (options?: unknown) => Pool;
    const pool = getPool();
    const poolQueryMock = pgMock.__getPoolQueryMock();

    await new Promise<void>((resolve) => {
      pool.query("SELECT 1", (err: unknown) => {
        expect(err).toBe(failure);
        resolve();
      });
    });

    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it("runs schema sync under advisory lock when needed", async () => {
    const { pgMock, poolModule, schemaMock } = await loadPool();
    schemaMock.schemaNeedsSync.mockResolvedValue(true);

    const clientQuery = jest.fn(async (query: string) => {
      if (query.startsWith("SELECT pg_try_advisory_lock")) {
        return { rows: [{ locked: true }] };
      }
      if (query.startsWith("SELECT pg_advisory_unlock")) {
        return { rows: [{ pg_advisory_unlock: true }] };
      }
      if (query.includes("FROM pg_database")) {
        return { rows: [] };
      }
      if (query.startsWith("CREATE DATABASE")) {
        return {};
      }
      return { rows: [] };
    });
    pgMock.__setClientImpls({
      query: clientQuery,
    });

    const getPool = poolModule.default as (options?: unknown) => Pool;
    const pool = getPool();

    await pool.query("SELECT 1");

    expect(schemaMock.syncSchema).toHaveBeenCalledTimes(1);
    expect(clientQuery).toHaveBeenCalledWith(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [expect.any(Number)],
    );
    expect(clientQuery).toHaveBeenCalledWith("SELECT pg_advisory_unlock($1)", [
      expect.any(Number),
    ]);
  });
});
