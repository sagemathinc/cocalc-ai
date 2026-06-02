/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { normalizeMembershipProjectDefaults } from "./project-defaults";

describe("normalizeMembershipProjectDefaults", () => {
  it("keeps cocalc-ai project resource defaults and filters legacy knobs", () => {
    expect(
      normalizeMembershipProjectDefaults({
        memory: "4000",
        memory_request: 500,
        disk_quota: true,
        cores: 32,
        cpu_shares: 1024,
        network: 0,
        member_host: 0,
        mintime: 3600,
        always_running: 1,
        ephemeral_state: 1,
        ephemeral_disk: 1,
      } as any),
    ).toEqual({
      memory: 4000,
      memory_request: 500,
      disk_quota: 1,
    });
  });
});
