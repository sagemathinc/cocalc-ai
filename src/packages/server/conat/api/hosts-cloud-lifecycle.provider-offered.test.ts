/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const mockAssertOffered = jest.fn();
jest.mock("@cocalc/server/cloud/project-host-provider-offered", () => ({
  assertProjectHostProviderOffered: (...args: any[]) =>
    mockAssertOffered(...args),
}));

// no database here: the rest of the start fails fast after the checks
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({
    query: async () => {
      throw new Error("no database in this test");
    },
    connect: async () => {
      throw new Error("no database in this test");
    },
  }),
}));

import { startHostInternalHelper } from "./hosts-cloud-lifecycle";

describe("an existing host on a provider no longer offered for new hosts", () => {
  const row = {
    id: "33333333-3333-4333-8333-333333333333",
    status: "off",
    metadata: { owner: "owner", machine: { cloud: "nebius" } },
  };

  beforeEach(() => {
    mockAssertOffered.mockReset();
    mockAssertOffered.mockRejectedValue(
      new Error("Nebius is not offered for project hosts"),
    );
  });

  it.each([false, true])(
    "can still be started by its owner (billing rescue: %s)",
    async (billing_rescue) => {
      // whatever the rest of the start does here, the offer check is not
      // applied: existing hosts are never stranded
      await startHostInternalHelper({
        account_id: "owner",
        id: row.id,
        billing_rescue,
        loadHostForStartStop: async () => row,
        markHostActionPending: jest.fn(async () => {
          throw new Error("stop here");
        }),
        logStatusUpdate: jest.fn(),
        parseRow: jest.fn(),
      }).catch((err) => expect(`${err}`).not.toMatch(/not offered/));
      expect(mockAssertOffered).not.toHaveBeenCalled();
    },
  );
});
