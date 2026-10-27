/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

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

describe("starting a Nebius Spot project host while Nebius Spot is off", () => {
  const host = (pricing: "spot" | "on_demand") => ({
    id: "33333333-3333-4333-8333-333333333333",
    status: "off",
    metadata: {
      owner: "owner",
      machine: { cloud: "nebius" },
      desired_pricing_model: pricing,
      pricing_model: pricing,
    },
  });
  const start = (pricing: "spot" | "on_demand", billing_rescue = false) =>
    startHostInternalHelper({
      account_id: "owner",
      id: host(pricing).id,
      billing_rescue,
      loadHostForStartStop: async () => host(pricing),
      markHostActionPending: jest.fn(async () => {
        throw new Error("stop here");
      }),
      logStatusUpdate: jest.fn(),
      parseRow: jest.fn(),
    });

  it("is refused", async () => {
    await expect(start("spot")).rejects.toThrow(/Nebius Spot is unavailable/);
  });

  it("(control) is not refused for an on-demand host or a billing rescue", async () => {
    // whatever the rest of the start does here, the Spot check passes
    for (const run of [() => start("on_demand"), () => start("spot", true)]) {
      await run().catch((err) =>
        expect(`${err}`).not.toMatch(/Nebius Spot is unavailable/),
      );
    }
  });
});
