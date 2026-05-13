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
    expect(expireCall?.[0]).toContain("status <> ALL($1::text[])");
    expect(expireCall?.[0]).toContain("kind=$2");
    expect(expireCall?.[1]).toEqual([
      ["succeeded", "failed", "canceled", "expired"],
      "project-move",
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
    expect(expireCall?.[1]).toEqual([
      ["succeeded", "failed", "canceled", "expired"],
    ]);
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
  });
});
