/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Project hosts never use Nebius Spot, even once dedicated VMs may (#684).
// These run with NEBIUS_SPOT_OFFERED on.

jest.mock("@cocalc/util/consts/nebius-spot", () => ({
  ...jest.requireActual("@cocalc/util/consts/nebius-spot"),
  NEBIUS_SPOT_OFFERED: true,
  assertNebiusSpotOffered: () => undefined,
}));
// no database here: the rest of each action fails fast after the checks
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
jest.mock("@cocalc/server/cloud/project-host-provider-offered", () => ({
  assertProjectHostProviderOffered: async () => undefined,
}));

import {
  createHostInternalHelper,
  restartHostInternalHelper,
  startHostInternalHelper,
} from "./hosts-cloud-lifecycle";

const HOST_ID = "33333333-3333-4333-8333-333333333333";

function host(pricing: "spot" | "on_demand", status = "off") {
  return {
    id: HOST_ID,
    status,
    metadata: {
      owner: "owner",
      machine: { cloud: "nebius" },
      desired_pricing_model: pricing,
      pricing_model: pricing,
    },
  };
}

const lifecycle = (pricing: "spot" | "on_demand", status = "off") => ({
  account_id: "owner",
  id: HOST_ID,
  loadHostForStartStop: async () => host(pricing, status),
  markHostActionPending: jest.fn(async () => {
    throw new Error("stop here");
  }),
  logStatusUpdate: jest.fn(),
  parseRow: jest.fn(),
});

const create = (pricing: "spot" | "on_demand") =>
  createHostInternalHelper({
    owner: "owner",
    name: "host",
    region: "eu-north1",
    size: "custom",
    gpu: true,
    pricing_model: pricing,
    machine: { cloud: "nebius" } as any,
    normalizeHostPricingModel: (value: unknown) =>
      value === "spot" || value === "on_demand" ? value : undefined,
    normalizeHostInterruptionRestorePolicy: () => undefined,
    defaultInterruptionRestorePolicy: () => "none" as any,
    parseRow: jest.fn(),
  });

async function errorOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "";
  } catch (err) {
    return `${err}`;
  }
}

describe("Nebius Spot project hosts with Spot offered for VMs (#684)", () => {
  it("refuses to create, start or restart a Nebius Spot project host", async () => {
    expect(await errorOf(() => create("spot"))).toMatch(/Nebius Spot/);
    expect(
      await errorOf(() => startHostInternalHelper(lifecycle("spot"))),
    ).toMatch(/Nebius Spot/);
    expect(
      await errorOf(() =>
        restartHostInternalHelper(lifecycle("spot", "running")),
      ),
    ).toMatch(/Nebius Spot/);
  });

  it("(control) Standard project hosts get past the check", async () => {
    expect(await errorOf(() => create("on_demand"))).not.toMatch(/Nebius Spot/);
    expect(
      await errorOf(() => startHostInternalHelper(lifecycle("on_demand"))),
    ).not.toMatch(/Nebius Spot/);
    expect(
      await errorOf(() =>
        restartHostInternalHelper(lifecycle("on_demand", "running")),
      ),
    ).not.toMatch(/Nebius Spot/);
  });
});
