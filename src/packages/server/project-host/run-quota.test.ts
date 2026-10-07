/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  applyHostRuntimePolicy,
  applySetupProfileNetworkPolicy,
} from "./run-quota";

describe("applyHostRuntimePolicy", () => {
  it("uses maximum safe host RAM by default on a private host", () => {
    expect(
      applyHostRuntimePolicy({
        run_quota: { memory_limit: 8_000 },
        host: {
          tier: null,
          metadata: { host_ram_mb: 44_032 },
        },
      }),
    ).toMatchObject({ memory_limit: 40_960 });
  });

  it("detects private-host RAM from the machine specification", () => {
    expect(
      applyHostRuntimePolicy({
        run_quota: { memory_limit: 8_000 },
        host: {
          tier: null,
          metadata: { machine: { metadata: { ram_gb: 64 } } },
        },
      }),
    ).toMatchObject({ memory_limit: 62_464 });
  });

  it("uses the configured private-host project RAM limit as an entitlement", () => {
    expect(
      applyHostRuntimePolicy({
        run_quota: { memory_limit: 16_000 },
        host: {
          tier: null,
          metadata: { resources: { project_ram_limit_mb: 50_000 } },
        },
      }),
    ).toMatchObject({ memory_limit: 50_000 });
  });

  it("only caps shared-pool projects downward", () => {
    const host = {
      tier: 0,
      metadata: { resources: { project_ram_limit_mb: 50_000 } },
    };
    expect(
      applyHostRuntimePolicy({
        run_quota: { memory_limit: 16_000 },
        host,
      }),
    ).toMatchObject({ memory_limit: 16_000 });
    expect(
      applyHostRuntimePolicy({
        run_quota: { memory_limit: 64_000 },
        host,
      }),
    ).toMatchObject({ memory_limit: 50_000 });
  });
});

describe("applySetupProfileNetworkPolicy", () => {
  it("always grants network access on CoCalc Star", () => {
    expect(
      applySetupProfileNetworkPolicy({ network: false }, "star"),
    ).toMatchObject({ network: true });
    expect(applySetupProfileNetworkPolicy({}, " star ")).toMatchObject({
      network: true,
    });
  });

  it("leaves the network quota alone elsewhere", () => {
    expect(
      applySetupProfileNetworkPolicy({ network: false }, undefined),
    ).toEqual({ network: false });
    expect(
      applySetupProfileNetworkPolicy({ network: false }, "rocket"),
    ).toEqual({
      network: false,
    });
  });
});
