/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

const poolQueryMock = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: poolQueryMock }),
}));

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("account security state cache", () => {
  beforeEach(() => {
    jest.resetModules();
    poolQueryMock.mockReset();
  });

  it("updates the in-memory cache when recording local ban state", async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [] });
    poolQueryMock.mockResolvedValueOnce({ rows: [] });
    poolQueryMock.mockResolvedValueOnce({ rows: [] });
    poolQueryMock.mockResolvedValueOnce({
      rows: [
        {
          banned: true,
          revoked_before_ms: 1000,
          updated_ms: 2000,
        },
      ],
    });
    const {
      isAccountBannedCached,
      getAccountRevokedBeforeCached,
      recordAccountSecurityState,
    } = await import("./security-state");

    await recordAccountSecurityState({
      account_id: ACCOUNT_ID,
      banned: true,
      revoked_before_ms: 1000,
    });

    expect(isAccountBannedCached(ACCOUNT_ID)).toBe(true);
    expect(getAccountRevokedBeforeCached(ACCOUNT_ID)).toBe(1000);
  });

  it("syncs account security state deltas into the in-memory cache", async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [] });
    poolQueryMock.mockResolvedValueOnce({ rows: [] });
    poolQueryMock.mockResolvedValueOnce({ rows: [] });
    poolQueryMock.mockResolvedValueOnce({
      rows: [
        {
          account_id: ACCOUNT_ID,
          banned: true,
          revoked_before_ms: null,
          updated_ms: 3000,
        },
      ],
    });
    const { isAccountBannedCached, syncAccountSecurityStateOnce } =
      await import("./security-state");

    await expect(syncAccountSecurityStateOnce()).resolves.toBe(1);

    expect(isAccountBannedCached(ACCOUNT_ID)).toBe(true);
  });

  it("loads account security state once for runtime callers that need readiness", async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [] });
    poolQueryMock.mockResolvedValueOnce({ rows: [] });
    poolQueryMock.mockResolvedValueOnce({ rows: [] });
    poolQueryMock.mockResolvedValueOnce({
      rows: [
        {
          account_id: ACCOUNT_ID,
          banned: true,
          revoked_before_ms: null,
          updated_ms: 3000,
        },
      ],
    });
    const { ensureAccountSecurityStateReady, isAccountBannedCached } =
      await import("./security-state");

    await ensureAccountSecurityStateReady();
    await ensureAccountSecurityStateReady();

    expect(isAccountBannedCached(ACCOUNT_ID)).toBe(true);
    expect(poolQueryMock).toHaveBeenCalledTimes(4);
  });

  it("waits for an already-running sync before reporting readiness", async () => {
    const selectResult = deferred<{
      rows: Array<{
        account_id: string;
        banned: boolean;
        revoked_before_ms: null;
        updated_ms: number;
      }>;
    }>();
    poolQueryMock.mockImplementation((sql: string) => {
      if (sql.includes("SELECT") && sql.includes("account_id::text")) {
        return selectResult.promise;
      }
      return Promise.resolve({ rows: [] });
    });
    const {
      ensureAccountSecurityStateReady,
      isAccountBannedCached,
      syncAccountSecurityStateOnce,
    } = await import("./security-state");

    const sync = syncAccountSecurityStateOnce();
    await Promise.resolve();
    const ready = ensureAccountSecurityStateReady();
    let readyDone = false;
    void ready.then(() => {
      readyDone = true;
    });
    await Promise.resolve();

    expect(readyDone).toBe(false);
    expect(isAccountBannedCached(ACCOUNT_ID)).toBe(false);

    selectResult.resolve({
      rows: [
        {
          account_id: ACCOUNT_ID,
          banned: true,
          revoked_before_ms: null,
          updated_ms: 3000,
        },
      ],
    });
    await ready;
    await sync;

    expect(readyDone).toBe(true);
    expect(isAccountBannedCached(ACCOUNT_ID)).toBe(true);
  });
});
