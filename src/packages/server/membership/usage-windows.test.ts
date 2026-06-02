/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const queryMock = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({
    query: (...args: any[]) => queryMock(...args),
  }),
}));

type EpochKey = string;

function epochKey(window: string): EpochKey {
  return `membership:${window}`;
}

describe("account usage fixed windows", () => {
  let epochs: Map<EpochKey, number>;
  let windows: any[];
  let resetRows: any[];

  beforeEach(() => {
    jest.resetModules();
    queryMock.mockReset();
    epochs = new Map();
    windows = [];
    resetRows = [];
    queryMock.mockImplementation(async (sql: string, params: any[] = []) => {
      if (
        sql.includes("CREATE TABLE IF NOT EXISTS account_usage_windows") ||
        sql.includes("CREATE TABLE IF NOT EXISTS account_usage_epochs") ||
        sql.includes("CREATE TABLE IF NOT EXISTS account_usage_epoch_resets") ||
        sql.includes("CREATE INDEX IF NOT EXISTS account_usage_windows_") ||
        sql.includes("CREATE INDEX IF NOT EXISTS account_usage_epoch_resets_")
      ) {
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO account_usage_epochs")) {
        const key = epochKey(params[1]);
        if (!epochs.has(key)) epochs.set(key, 1);
        return { rows: [] };
      }
      if (sql.includes("SELECT family, window, epoch")) {
        const key = epochKey(params[1]);
        return {
          rows: [
            {
              family: params[0],
              window: params[1],
              epoch: epochs.get(key) ?? 1,
            },
          ],
        };
      }
      if (sql.includes("SELECT id, account_id, family, window, epoch")) {
        const [account_id, family, window, epoch, at] = params;
        return {
          rows: windows
            .filter(
              (row) =>
                row.account_id === account_id &&
                row.family === family &&
                row.window === window &&
                row.epoch === epoch &&
                row.starts_at <= at &&
                row.resets_at > at,
            )
            .slice(0, 1),
        };
      }
      if (sql.includes("INSERT INTO account_usage_windows")) {
        const [account_id, family, window, epoch, starts_at, resets_at] =
          params;
        const row = {
          id: `window-${windows.length + 1}`,
          account_id,
          family,
          window,
          epoch,
          starts_at,
          resets_at,
        };
        windows.push(row);
        return { rows: [row] };
      }
      if (sql.includes("UPDATE account_usage_epochs")) {
        const [family, window, epoch] = params;
        expect(family).toBe("membership");
        epochs.set(epochKey(window), epoch);
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO account_usage_epoch_resets")) {
        resetRows.push(params);
        return { rows: [] };
      }
      throw new Error(`unhandled query: ${sql}`);
    });
  });

  it("starts fixed 5h and 7d windows at first metered usage", async () => {
    const { ensureAccountUsageWindowsForEvent } =
      await import("./usage-windows");
    const result = await ensureAccountUsageWindowsForEvent({
      account_id: "11111111-1111-4111-8111-111111111111",
      occurred_at: new Date("2026-06-01T10:00:00.000Z"),
    });

    expect(result["5h"].starts_at.toISOString()).toBe(
      "2026-06-01T10:00:00.000Z",
    );
    expect(result["5h"].resets_at.toISOString()).toBe(
      "2026-06-01T15:00:00.000Z",
    );
    expect(result["7d"].starts_at.toISOString()).toBe(
      "2026-06-01T10:00:00.000Z",
    );
    expect(result["7d"].resets_at.toISOString()).toBe(
      "2026-06-08T10:00:00.000Z",
    );
    expect(windows).toHaveLength(2);
  });

  it("reuses an active fixed window until it expires", async () => {
    const { ensureAccountUsageWindowsForEvent } =
      await import("./usage-windows");
    await ensureAccountUsageWindowsForEvent({
      account_id: "11111111-1111-4111-8111-111111111111",
      occurred_at: new Date("2026-06-01T10:00:00.000Z"),
    });
    const second = await ensureAccountUsageWindowsForEvent({
      account_id: "11111111-1111-4111-8111-111111111111",
      occurred_at: new Date("2026-06-01T11:00:00.000Z"),
    });

    expect(second["5h"].id).toBe("window-1");
    expect(second["7d"].id).toBe("window-2");
    expect(windows).toHaveLength(2);
  });

  it("shares the same account windows across all metered categories", async () => {
    const { ensureAccountUsageWindowsForEvent, getActiveAccountUsageWindows } =
      await import("./usage-windows");
    const first = await ensureAccountUsageWindowsForEvent({
      account_id: "11111111-1111-4111-8111-111111111111",
      occurred_at: new Date("2026-06-01T10:00:00.000Z"),
    });
    const second = await getActiveAccountUsageWindows({
      account_id: "11111111-1111-4111-8111-111111111111",
      at: new Date("2026-06-01T12:00:00.000Z"),
      create: true,
    });

    expect(second["5h"]?.id).toBe(first["5h"].id);
    expect(second["7d"]?.id).toBe(first["7d"].id);
    expect(windows).toHaveLength(2);
  });

  it("bumps epochs to globally reset a membership window", async () => {
    const { resetAccountUsageEpoch } = await import("./usage-windows");
    const result = await resetAccountUsageEpoch({
      window: "5h",
      reset_by: "22222222-2222-4222-8222-222222222222",
      reason: "bad tier configuration",
    });

    expect(result).toEqual({ scope: "membership", window: "5h", epoch: 2 });
    expect(resetRows).toHaveLength(1);
    expect(resetRows[0]).toEqual([
      "membership",
      "5h",
      1,
      2,
      "22222222-2222-4222-8222-222222222222",
      "bad tier configuration",
    ]);
  });
});
