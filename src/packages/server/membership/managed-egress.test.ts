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

describe("managed egress history", () => {
  beforeEach(() => {
    jest.resetModules();
    queryMock.mockReset();
    queryMock.mockImplementation(async (sql: string) => {
      if (
        sql.includes(
          "CREATE TABLE IF NOT EXISTS account_managed_egress_events",
        ) ||
        sql.includes(
          "ALTER TABLE account_managed_egress_events ALTER COLUMN project_id DROP NOT NULL",
        ) ||
        sql.includes(
          "CREATE INDEX IF NOT EXISTS account_managed_egress_events_",
        )
      ) {
        return { rows: [] };
      }
      throw new Error(`unhandled query: ${sql}`);
    });
  });

  it("aggregates account history into bounded time buckets", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (
        sql.includes(
          "CREATE TABLE IF NOT EXISTS account_managed_egress_events",
        ) ||
        sql.includes(
          "ALTER TABLE account_managed_egress_events ALTER COLUMN project_id DROP NOT NULL",
        ) ||
        sql.includes(
          "CREATE INDEX IF NOT EXISTS account_managed_egress_events_",
        )
      ) {
        return { rows: [] };
      }
      if (
        sql.includes(
          "SELECT events.category, COALESCE(SUM(events.bytes), 0) AS bytes",
        )
      ) {
        return {
          rows: [
            { category: "file-download", bytes: "200" },
            { category: "raw-network", bytes: "300" },
          ],
        };
      }
      if (sql.includes("GROUP BY bucket_start, events.category")) {
        return {
          rows: [
            {
              bucket_start: "2026-04-28T10:00:00.000Z",
              category: "file-download",
              bytes: "200",
            },
            {
              bucket_start: "2026-04-28T11:00:00.000Z",
              category: "raw-network",
              bytes: "300",
            },
          ],
        };
      }
      if (sql.includes("GROUP BY events.project_id, projects.title")) {
        return {
          rows: [
            {
              project_id: "project-1",
              project_title: "Lite One",
              bytes: "450",
            },
            {
              project_id: null,
              project_title: null,
              bytes: "50",
            },
          ],
        };
      }
      if (sql.includes("ORDER BY events.occurred_at DESC, events.id DESC")) {
        return {
          rows: [
            {
              account_id: "account-1",
              project_id: "project-1",
              project_title: "Lite One",
              category: "raw-network",
              bytes: "300",
              occurred_at: "2026-04-28T11:30:00.000Z",
              metadata: { interface_name: "ens4" },
            },
          ],
        };
      }
      throw new Error(`unhandled query: ${sql}`);
    });

    const { getManagedEgressHistoryForAccount } =
      await import("./managed-egress");
    const result = await getManagedEgressHistoryForAccount({
      account_id: "account-1",
      start: "2026-04-28T10:15:00.000Z",
      end: "2026-04-28T12:15:00.000Z",
      bucket: "1h",
      recent_event_limit: 5,
      top_project_limit: 5,
    });

    expect(result.account_id).toBe("account-1");
    expect(result.total_bytes).toBe(500);
    expect(result.categories_bytes).toEqual({
      "file-download": 200,
      "raw-network": 300,
    });
    expect(result.points).toHaveLength(3);
    expect(result.points[0]).toMatchObject({
      start: "2026-04-28T10:00:00.000Z",
      bytes: 200,
      categories_bytes: { "file-download": 200 },
    });
    expect(result.points[1]).toMatchObject({
      start: "2026-04-28T11:00:00.000Z",
      bytes: 300,
      categories_bytes: { "raw-network": 300 },
    });
    expect(result.points[2]).toMatchObject({
      start: "2026-04-28T12:00:00.000Z",
      bytes: 0,
      categories_bytes: {},
    });
    expect(result.top_projects).toEqual([
      {
        project_id: "project-1",
        project_title: "Lite One",
        bytes: 450,
      },
      {
        project_id: null,
        project_title: null,
        bytes: 50,
      },
    ]);
    expect(result.recent_events).toEqual([
      {
        account_id: "account-1",
        project_id: "project-1",
        project_title: "Lite One",
        category: "raw-network",
        bytes: 300,
        occurred_at: "2026-04-28T11:30:00.000Z",
        metadata: { interface_name: "ens4" },
      },
    ]);
  });

  it("rejects overly granular history requests", async () => {
    const { getManagedEgressHistoryForAccount } =
      await import("./managed-egress");
    await expect(
      getManagedEgressHistoryForAccount({
        account_id: "account-1",
        start: "2026-03-01T00:00:00.000Z",
        end: "2026-03-16T00:00:00.000Z",
        bucket: "5m",
      }),
    ).rejects.toThrow("history query is too granular");
  });
});
