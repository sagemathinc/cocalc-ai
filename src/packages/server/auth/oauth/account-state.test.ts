/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const mockQuery = jest.fn();
const mockDirectory = jest.fn();
const mockRemote = jest.fn();
const mockCreateClient = jest.fn((_opts: any) => ({
  getOAuthAccountState: mockRemote,
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: mockQuery }),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-0",
}));
jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountById: (...args: any[]) => mockDirectory(...args),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => "fabric",
}));
jest.mock("@cocalc/conat/inter-bay/api", () => ({
  createInterBayAccountLocalClient: (opts: any) => mockCreateClient(opts),
}));
jest.mock("@cocalc/server/membership/resolve", () => ({
  resolveMembershipForAccount: async () => ({ class: "pro" }),
}));

import {
  getOAuthAccountState,
  getOAuthAccountStateLocal,
} from "./account-state";

const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const ROW = {
  email_address: "ada@example.com",
  email_address_verified: { "ada@example.com": "2026-10-13" },
  banned: false,
  deleted: false,
  home_bay_id: "bay-0",
  first_name: "Ada",
  last_name: "Lovelace",
};

beforeEach(() => {
  mockQuery.mockReset();
  mockDirectory.mockReset();
  mockRemote.mockReset();
  mockCreateClient.mockClear();
});

describe("getOAuthAccountStateLocal", () => {
  it("reads a live account from the primary", async () => {
    mockQuery.mockResolvedValue({ rows: [ROW] });
    expect(
      await getOAuthAccountStateLocal({
        account_id: ACCOUNT,
        include_membership: true,
      }),
    ).toEqual({
      state: "live",
      email_address: "ada@example.com",
      email_verified: true,
      display_name: "Ada Lovelace",
      membership: { class: "pro" },
    });
  });

  it("is missing for a deleted, banned or email-less account", async () => {
    for (const change of [
      { deleted: true },
      { banned: true },
      { email_address: null },
    ]) {
      mockQuery.mockResolvedValue({ rows: [{ ...ROW, ...change }] });
      expect(await getOAuthAccountStateLocal({ account_id: ACCOUNT })).toEqual({
        state: "missing",
      });
    }
    mockQuery.mockResolvedValue({ rows: [] });
    expect(await getOAuthAccountStateLocal({ account_id: ACCOUNT })).toEqual({
      state: "missing",
    });
  });

  it("reports an unverified current email and a moved account", async () => {
    mockQuery.mockResolvedValue({
      rows: [{ ...ROW, email_address_verified: { "old@example.com": "x" } }],
    });
    expect(
      (await getOAuthAccountStateLocal({ account_id: ACCOUNT })) as any,
    ).toMatchObject({ state: "live", email_verified: false });
    mockQuery.mockResolvedValue({ rows: [{ ...ROW, home_bay_id: "bay-2" }] });
    expect(await getOAuthAccountStateLocal({ account_id: ACCOUNT })).toEqual({
      state: "moved",
      home_bay_id: "bay-2",
    });
  });
});

describe("getOAuthAccountState", () => {
  it("asks the home bay the directory names", async () => {
    mockDirectory.mockResolvedValue({
      account_id: ACCOUNT,
      home_bay_id: "bay-1",
    });
    mockRemote.mockResolvedValue({ state: "missing" });
    expect(await getOAuthAccountState(ACCOUNT)).toEqual({ state: "missing" });
    expect(mockCreateClient).toHaveBeenCalledWith({
      client: "fabric",
      dest_bay: "bay-1",
    });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("follows one move to the new home bay", async () => {
    mockDirectory.mockResolvedValue({
      account_id: ACCOUNT,
      home_bay_id: "bay-0",
    });
    mockQuery.mockResolvedValue({ rows: [{ ...ROW, home_bay_id: "bay-2" }] });
    mockRemote.mockResolvedValue({ state: "live", email_address: "x" });
    expect(await getOAuthAccountState(ACCOUNT)).toMatchObject({
      state: "live",
    });
    expect(mockCreateClient).toHaveBeenCalledWith({
      client: "fabric",
      dest_bay: "bay-2",
    });
  });

  it("throws, rather than reporting a deleted account, while a rehome is in progress", async () => {
    mockDirectory.mockResolvedValue({
      account_id: ACCOUNT,
      home_bay_id: "bay-1",
    });
    mockRemote.mockResolvedValue({ state: "moved", home_bay_id: "bay-2" });
    await expect(getOAuthAccountState(ACCOUNT)).rejects.toThrow(
      "home bay is changing",
    );
  });

  it("is missing when the directory does not know the account", async () => {
    mockDirectory.mockResolvedValue(null);
    expect(await getOAuthAccountState(ACCOUNT)).toEqual({ state: "missing" });
    expect(await getOAuthAccountState("not-a-uuid")).toEqual({
      state: "missing",
    });
  });
});
