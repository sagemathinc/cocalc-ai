/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

export {};

let rows: any[] = [];
let admin = false;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: async () => ({ rows }) }),
}));
jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: async () => admin,
}));

describe("loadHostForDrainInternal", () => {
  beforeEach(() => {
    admin = false;
  });

  it.each([
    ["no owner", {}],
    ["a blank owner", { owner: " " }],
    ["another owner", { owner: "acct-other" }],
  ])("refuses a non-admin for a host with %s", async (_label, metadata) => {
    rows = [{ id: "host-1", metadata }];
    const { loadHostForDrainInternal } = await import("./hosts-drain");
    await expect(
      loadHostForDrainInternal({ id: "host-1", owner: "acct-1" }),
    ).rejects.toThrow("not authorized");
  });

  it("lets the host's owner and an admin through", async () => {
    rows = [{ id: "host-1", metadata: { owner: "acct-1" } }];
    const { loadHostForDrainInternal } = await import("./hosts-drain");
    await expect(
      loadHostForDrainInternal({ id: "host-1", owner: "acct-1" }),
    ).resolves.toEqual(rows[0]);
    admin = true;
    rows = [{ id: "host-1", metadata: {} }];
    await expect(
      loadHostForDrainInternal({ id: "host-1", owner: "acct-admin" }),
    ).resolves.toEqual(rows[0]);
  });
});
