/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Admin status is account-home state: other bays ask the home bay.

let multiBay = true;
const query = jest.fn();
const userIsInGroup = jest.fn();
const resolveAccountHomeBay = jest.fn();
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
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: (...args) => resolveAccountHomeBay(...args),
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

beforeEach(() => {
  jest.clearAllMocks();
  clearHomeBayCacheForTests();
  multiBay = true;
});

describe("isAdmin", () => {
  it("reads the local row in a single-bay deployment", async () => {
    multiBay = false;
    userIsInGroup.mockResolvedValue(true);
    expect(await isAdmin(ACCOUNT)).toBe(true);
    expect(userIsInGroup).toHaveBeenCalledWith(ACCOUNT, "admin", undefined);
    expect(query).not.toHaveBeenCalled();
  });

  it("answers from the local row for an account homed here", async () => {
    query.mockResolvedValue({
      rows: [{ groups: ["admin"], home_bay_id: "bay-0" }],
    });
    expect(await isAdmin(ACCOUNT)).toBe(true);
    expect(resolveAccountHomeBay).not.toHaveBeenCalled();
    expect(remoteIsAdmin).not.toHaveBeenCalled();
  });

  it("asks the home bay for an account homed elsewhere", async () => {
    query.mockResolvedValue({ rows: [] });
    resolveAccountHomeBay.mockResolvedValue({ home_bay_id: "bay-1" });
    remoteIsAdmin.mockResolvedValue(true);
    expect(await isAdmin(ACCOUNT)).toBe(true);
    expect(createInterBayAccountFactsClient).toHaveBeenCalledWith(
      expect.objectContaining({ bay_id: "bay-1" }),
    );
    expect(remoteIsAdmin).toHaveBeenCalledWith({ account_id: ACCOUNT });
  });

  it("ignores a stale local copy of an account homed elsewhere", async () => {
    query.mockResolvedValue({
      rows: [{ groups: ["admin"], home_bay_id: "bay-1" }],
    });
    resolveAccountHomeBay.mockResolvedValue({ home_bay_id: "bay-1" });
    remoteIsAdmin.mockResolvedValue(false);
    expect(await isAdmin(ACCOUNT)).toBe(false);
  });

  it("treats an account unknown to the directory as a non-admin", async () => {
    query.mockResolvedValue({ rows: [] });
    resolveAccountHomeBay.mockRejectedValue(
      new Error(`account '${ACCOUNT}' not found`),
    );
    expect(await isAdmin(ACCOUNT)).toBe(false);
    expect(remoteIsAdmin).not.toHaveBeenCalled();
  });

  it("fails rather than guessing when the directory is unavailable", async () => {
    query.mockResolvedValue({ rows: [] });
    resolveAccountHomeBay.mockRejectedValue(new Error("timeout"));
    await expect(isAdmin(ACCOUNT)).rejects.toThrow("timeout");
  });

  it("caches the home bay briefly", async () => {
    query.mockResolvedValue({ rows: [] });
    resolveAccountHomeBay.mockResolvedValue({ home_bay_id: "bay-1" });
    remoteIsAdmin.mockResolvedValue(false);
    await isAdmin(ACCOUNT);
    await isAdmin(ACCOUNT);
    expect(resolveAccountHomeBay).toHaveBeenCalledTimes(1);
    expect(remoteIsAdmin).toHaveBeenCalledTimes(2);
  });
});

describe("accountFactsHome on the home bay", () => {
  it("answers for its own accounts", async () => {
    query.mockResolvedValue({ rows: [{ home_bay_id: "bay-0" }] });
    userIsInGroup.mockResolvedValue(true);
    expect(await accountFactsHome.isAdmin({ account_id: ACCOUNT })).toBe(true);
  });

  it("refuses accounts homed elsewhere instead of asking again", async () => {
    query.mockResolvedValue({ rows: [] });
    resolveAccountHomeBay.mockResolvedValue({ home_bay_id: "bay-2" });
    await expect(
      accountFactsHome.isAdmin({ account_id: ACCOUNT }),
    ).rejects.toMatchObject({ code: 409 });
    expect(userIsInGroup).not.toHaveBeenCalled();
    expect(remoteIsAdmin).not.toHaveBeenCalled();
  });
});
