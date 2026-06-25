/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { Host } from "@cocalc/conat/hub/api/hosts";
import { hostIsVisibleForRegionFilter } from "./pick-host";

function host(overrides: Partial<Host> = {}): Host {
  return {
    id: "host-1",
    name: "Host 1",
    owner: "account-1",
    region: "us-west1",
    size: "small",
    gpu: false,
    status: "running",
    can_place: true,
    scope: "pool",
    ...overrides,
  };
}

describe("hostIsVisibleForRegionFilter", () => {
  it("keeps pool hosts constrained by region", () => {
    expect(hostIsVisibleForRegionFilter(host(), "wnam")).toBe(true);
    expect(hostIsVisibleForRegionFilter(host(), "enam")).toBe(false);
  });

  it("keeps owned hosts visible across regions", () => {
    expect(hostIsVisibleForRegionFilter(host({ scope: "owned" }), "enam")).toBe(
      true,
    );
  });

  it("keeps delegated collaborator hosts visible across regions", () => {
    expect(
      hostIsVisibleForRegionFilter(host({ scope: "collab" }), "enam"),
    ).toBe(true);
  });
});
