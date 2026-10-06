/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Admin status is account-home state: other bays ask the home bay.

let multiBay = true;
// This bay's (bay-0) active `accounts` row for ACCOUNT, if any.
let localRow: { home_bay_id: string | null; groups?: string[] } | null = null;
const query = jest.fn(async (sql: string) => ({
  rows: localRow == null ? [] : [localRow],
  sql,
}));
const userIsInGroup = jest.fn();
const getClusterAccountById = jest.fn();
const remoteIsAdmin = jest.fn();
const createInterBayAccountFactsClient = jest.fn(() => ({
  isAdmin: remoteIsAdmin,
}));

jest.mock("@cocalc/server/cluster-config", () => ({
  isMultiBayCluster: () => multiBay,
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-0",
}));
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query }),
}));
jest.mock("./is-in-group", () => ({
  __esModule: true,
  default: (...args) => userIsInGroup(...args),
}));
jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountById: (...args) => getClusterAccountById(...args),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => ({ fabric: true }),
}));
jest.mock("@cocalc/conat/inter-bay/account-facts", () => ({
  createInterBayAccountFactsClient,
}));

import isAdmin from "./is-admin";
import { clearHomeBayCacheForTests } from "./home-bay";
import { accountFactsHome } from "./account-facts-service";

const ACCOUNT = "1f8d5b7c-3c55-4a43-9f43-3ef8b2b2d0a1";
const directory = (home_bay_id: string | null) =>
  getClusterAccountById.mockResolvedValue(
    home_bay_id == null ? null : { account_id: ACCOUNT, home_bay_id },
  );

beforeEach(() => {
  jest.clearAllMocks();
  clearHomeBayCacheForTests();
  multiBay = true;
  localRow = null;
});

describe("isAdmin", () => {
  it("reads the local row in a single-bay deployment", async () => {
    multiBay = false;
    userIsInGroup.mockResolvedValue(true);
    expect(await isAdmin(ACCOUNT)).toBe(true);
    expect(userIsInGroup).toHaveBeenCalledWith(ACCOUNT, "admin", undefined);
    expect(query).not.toHaveBeenCalled();
  });

  it("answers from the local row for an account explicitly homed here", async () => {
    localRow = { home_bay_id: "bay-0", groups: ["admin"] };
    expect(await isAdmin(ACCOUNT)).toBe(true);
    expect(getClusterAccountById).not.toHaveBeenCalled();
    expect(remoteIsAdmin).not.toHaveBeenCalled();
    // Only active rows count.
    expect(
      query.mock.calls.every(([sql]) => sql.includes("deleted IS NOT TRUE")),
    ).toBe(true);
  });

  it("asks the home bay for an account homed elsewhere", async () => {
    directory("bay-1");
    remoteIsAdmin.mockResolvedValue(true);
    expect(await isAdmin(ACCOUNT)).toBe(true);
    expect(createInterBayAccountFactsClient).toHaveBeenCalledWith(
      expect.objectContaining({ bay_id: "bay-1" }),
    );
    expect(remoteIsAdmin).toHaveBeenCalledWith({ account_id: ACCOUNT });
  });

  it("ignores a stale local copy of an account homed elsewhere", async () => {
    localRow = { home_bay_id: "bay-1", groups: ["admin"] };
    directory("bay-1");
    remoteIsAdmin.mockResolvedValue(false);
    expect(await isAdmin(ACCOUNT)).toBe(false);
  });

  it("never uses a rehomed-away row while the directory still points here", async () => {
    // Rehome race: the source row already names the destination, the
    // directory does not yet. Fail closed instead of using the old groups.
    localRow = { home_bay_id: "bay-1", groups: ["admin"] };
    directory("bay-0");
    await expect(isAdmin(ACCOUNT)).rejects.toMatchObject({ code: 409 });
    // Nothing was cached: once the directory flips, the home bay answers.
    directory("bay-1");
    remoteIsAdmin.mockResolvedValue(false);
    expect(await isAdmin(ACCOUNT)).toBe(false);
  });

  it("never uses a stale row for an account the directory does not know", async () => {
    localRow = { home_bay_id: "bay-1", groups: ["admin"] };
    directory(null);
    await expect(isAdmin(ACCOUNT)).rejects.toMatchObject({ code: 409 });
  });

  it("treats an account unknown to the directory as a non-admin", async () => {
    directory(null);
    expect(await isAdmin(ACCOUNT)).toBe(false);
    expect(remoteIsAdmin).not.toHaveBeenCalled();
  });

  it("accepts a legacy row without a home bay only if the directory confirms", async () => {
    localRow = { home_bay_id: null, groups: ["admin"] };
    directory("bay-0");
    expect(await isAdmin(ACCOUNT)).toBe(true);
    directory("bay-1");
    remoteIsAdmin.mockResolvedValue(false);
    expect(await isAdmin(ACCOUNT)).toBe(false);
  });

  it("fails rather than guessing when the directory is unavailable, even on 'not found' errors", async () => {
    getClusterAccountById.mockRejectedValue(new Error("timeout"));
    await expect(isAdmin(ACCOUNT)).rejects.toThrow("timeout");
    getClusterAccountById.mockRejectedValue(new Error("service not found"));
    await expect(isAdmin(ACCOUNT)).rejects.toThrow("service not found");
  });

  it("caches only remote answers, and forgets them when the bay refuses", async () => {
    directory("bay-1");
    remoteIsAdmin.mockResolvedValue(false);
    await isAdmin(ACCOUNT);
    await isAdmin(ACCOUNT);
    expect(getClusterAccountById).toHaveBeenCalledTimes(1);
    expect(remoteIsAdmin).toHaveBeenCalledTimes(2);

    remoteIsAdmin.mockRejectedValueOnce(
      Object.assign(new Error("account is not homed on this bay"), {
        code: 409,
      }),
    );
    await expect(isAdmin(ACCOUNT)).rejects.toMatchObject({ code: 409 });
    directory("bay-2");
    await isAdmin(ACCOUNT);
    expect(createInterBayAccountFactsClient).toHaveBeenLastCalledWith(
      expect.objectContaining({ bay_id: "bay-2" }),
    );
  });

  it("never caches a 'here' answer", async () => {
    localRow = { home_bay_id: null, groups: [] };
    directory("bay-0");
    await isAdmin(ACCOUNT);
    await isAdmin(ACCOUNT);
    expect(getClusterAccountById).toHaveBeenCalledTimes(2);
  });
});

describe("accountFactsHome on the home bay", () => {
  it("answers for its own accounts", async () => {
    localRow = { home_bay_id: "bay-0" };
    userIsInGroup.mockResolvedValue(true);
    expect(await accountFactsHome.isAdmin({ account_id: ACCOUNT })).toBe(true);
  });

  it("refuses accounts homed elsewhere instead of asking again", async () => {
    directory("bay-2");
    await expect(
      accountFactsHome.isAdmin({ account_id: ACCOUNT }),
    ).rejects.toMatchObject({ code: 409 });
    expect(userIsInGroup).not.toHaveBeenCalled();
    expect(remoteIsAdmin).not.toHaveBeenCalled();
  });

  it("refuses accounts it does not know", async () => {
    directory(null);
    await expect(
      accountFactsHome.isAdmin({ account_id: ACCOUNT }),
    ).rejects.toMatchObject({ code: 409 });
  });
});
