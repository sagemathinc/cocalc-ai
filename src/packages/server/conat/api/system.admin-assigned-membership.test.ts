/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

let isAdminMock: jest.Mock;
let requireDangerousSessionAuthMock: jest.Mock;
let resolveAccountHomeBayMock: jest.Mock;
let getConfiguredBayIdMock: jest.Mock;
let createInterBayAccountLocalClientMock: jest.Mock;
let getInterBayFabricClientMock: jest.Mock;
let queryMock: jest.Mock;

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: any[]) => isAdminMock(...args),
}));

jest.mock("./dangerous-session-auth", () => ({
  __esModule: true,
  requireDangerousSessionAuth: (...args: any[]) =>
    requireDangerousSessionAuthMock(...args),
}));

jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: (...args: any[]) => resolveAccountHomeBayMock(...args),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: (...args: any[]) => getConfiguredBayIdMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: (...args: any[]) =>
    getInterBayFabricClientMock(...args),
}));

jest.mock("@cocalc/conat/inter-bay/api", () => ({
  createInterBayAccountLocalClient: (...args: any[]) =>
    createInterBayAccountLocalClientMock(...args),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: queryMock }),
}));

jest.mock("@cocalc/database", () => ({
  db: () => ({
    async_query: jest.fn(async () => ({ rows: [] })),
    get_server_setting: jest.fn(),
    set_server_setting: jest.fn(),
  }),
}));

describe("admin assigned membership account-home routing", () => {
  const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
  const USER_ID = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    jest.resetModules();
    isAdminMock = jest.fn(async () => true);
    requireDangerousSessionAuthMock = jest.fn(async () => undefined);
    resolveAccountHomeBayMock = jest.fn(async () => ({
      home_bay_id: "bay-1",
    }));
    getConfiguredBayIdMock = jest.fn(() => "bay-1");
    getInterBayFabricClientMock = jest.fn(() => "fabric");
    queryMock = jest.fn(async () => ({ rows: [] }));
    createInterBayAccountLocalClientMock = jest.fn(() => ({
      getAdminAssignedMembership: jest.fn(async () => undefined),
      setAdminAssignedMembership: jest.fn(async () => undefined),
      clearAdminAssignedMembership: jest.fn(async () => undefined),
    }));
  });

  it("reads local account-home admin assignments from the local bay", async () => {
    queryMock = jest.fn(async () => ({
      rows: [
        {
          account_id: USER_ID,
          membership_class: "pro",
          assigned_by: ADMIN_ID,
          assigned_at: new Date("2026-01-01T00:00:00Z"),
          expires_at: null,
          notes: "test",
        },
      ],
    }));
    const { getAdminAssignedMembership } = await import("./system");

    const row = await getAdminAssignedMembership({
      account_id: ADMIN_ID,
      user_account_id: USER_ID,
    });

    expect(row?.membership_class).toBe("pro");
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("FROM admin_assigned_memberships"),
      [USER_ID],
    );
    expect(createInterBayAccountLocalClientMock).not.toHaveBeenCalled();
  });

  it("forwards remote account-home reads through account-local inter-bay", async () => {
    resolveAccountHomeBayMock = jest.fn(async () => ({
      home_bay_id: "bay-2",
    }));
    const remoteGet = jest.fn(async () => ({
      account_id: USER_ID,
      membership_class: "team",
      assigned_by: ADMIN_ID,
      assigned_at: new Date("2026-01-01T00:00:00Z"),
    }));
    createInterBayAccountLocalClientMock = jest.fn(() => ({
      getAdminAssignedMembership: remoteGet,
    }));
    const { getAdminAssignedMembership } = await import("./system");

    await getAdminAssignedMembership({
      account_id: ADMIN_ID,
      user_account_id: USER_ID,
    });

    expect(createInterBayAccountLocalClientMock).toHaveBeenCalledWith({
      client: "fabric",
      dest_bay: "bay-2",
    });
    expect(remoteGet).toHaveBeenCalledWith({ account_id: USER_ID });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("requires fresh auth before forwarding remote admin assignment writes", async () => {
    resolveAccountHomeBayMock = jest.fn(async () => ({
      home_bay_id: "bay-2",
    }));
    const remoteSet = jest.fn(async () => undefined);
    createInterBayAccountLocalClientMock = jest.fn(() => ({
      setAdminAssignedMembership: remoteSet,
    }));
    const { setAdminAssignedMembership } = await import("./system");

    await setAdminAssignedMembership({
      account_id: ADMIN_ID,
      browser_id: "browser-1",
      session_hash: "session-1",
      user_account_id: USER_ID,
      membership_class: "pro",
      expires_at: null,
      notes: "manual comp",
    });

    expect(requireDangerousSessionAuthMock).toHaveBeenCalledWith({
      account_id: ADMIN_ID,
      browser_id: "browser-1",
      session_hash: "session-1",
      require_second_factor: true,
    });
    expect(remoteSet).toHaveBeenCalledWith({
      account_id: USER_ID,
      actor_account_id: ADMIN_ID,
      membership_class: "pro",
      expires_at: null,
      notes: "manual comp",
    });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("forwards remote admin assignment clears", async () => {
    resolveAccountHomeBayMock = jest.fn(async () => ({
      home_bay_id: "bay-2",
    }));
    const remoteClear = jest.fn(async () => undefined);
    createInterBayAccountLocalClientMock = jest.fn(() => ({
      clearAdminAssignedMembership: remoteClear,
    }));
    const { clearAdminAssignedMembership } = await import("./system");

    await clearAdminAssignedMembership({
      account_id: ADMIN_ID,
      user_account_id: USER_ID,
    });

    expect(remoteClear).toHaveBeenCalledWith({
      account_id: USER_ID,
      actor_account_id: ADMIN_ID,
    });
    expect(queryMock).not.toHaveBeenCalled();
  });
});
