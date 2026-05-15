/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let queryMock: jest.Mock;
let connectMock: jest.Mock;
let releaseMock: jest.Mock;
let resolveMembershipForAccountMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    connect: connectMock,
  })),
}));

jest.mock("@cocalc/server/membership/resolve", () => ({
  __esModule: true,
  resolveMembershipForAccount: (...args: any[]) =>
    resolveMembershipForAccountMock(...args),
}));

function makeSlot(project_id: string) {
  return {
    sponsor_account_id: "sponsor",
    project_id,
    owning_bay_id: "bay-0",
    state: "running",
    acquired_at: new Date(),
    heartbeat_at: new Date(),
    expires_at: new Date(Date.now() + 60_000),
    metadata: {},
  };
}

describe("runtime slot admission", () => {
  beforeEach(() => {
    releaseMock = jest.fn();
    queryMock = jest.fn(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: null };
      }
      if (sql.includes("UPDATE project_runtime_slots")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("SELECT sponsor_account_id")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("INSERT INTO project_runtime_slots")) {
        return { rows: [makeSlot("project-1")], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    connectMock = jest.fn(async () => ({
      query: queryMock,
      release: releaseMock,
    }));
    resolveMembershipForAccountMock = jest.fn(async () => ({
      class: "member",
      source: "subscription",
      entitlements: {
        usage_limits: { max_sponsored_running_projects: 1 },
      },
    }));
  });

  it("reserves a slot when the sponsor is below the limit", async () => {
    const { reserveProjectRuntimeSlotLocal } = await import("./runtime-slots");
    const result = await reserveProjectRuntimeSlotLocal({
      sponsor_account_id: "sponsor",
      project_id: "project-1",
      owning_bay_id: "bay-0",
      actor_account_id: "actor",
    });

    expect(result.limit).toBe(1);
    expect(result.current).toBe(1);
    expect(queryMock).toHaveBeenCalledWith("COMMIT");
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it("denies a new project when the sponsor is at the limit", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: null };
      }
      if (sql.includes("UPDATE project_runtime_slots")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("SELECT sponsor_account_id")) {
        return { rows: [makeSlot("other-project")], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const {
      RuntimeSponsorSlotsExhaustedError,
      reserveProjectRuntimeSlotLocal,
    } = await import("./runtime-slots");
    await expect(
      reserveProjectRuntimeSlotLocal({
        sponsor_account_id: "sponsor",
        project_id: "project-1",
        owning_bay_id: "bay-0",
      }),
    ).rejects.toBeInstanceOf(RuntimeSponsorSlotsExhaustedError);
    expect(queryMock).toHaveBeenCalledWith("ROLLBACK");
  });
});
