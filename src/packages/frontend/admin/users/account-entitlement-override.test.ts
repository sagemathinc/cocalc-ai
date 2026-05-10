/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { buildOverride } from "./account-entitlement-override";

describe("buildOverride", () => {
  it("does not serialize inherited dedicated-host creation as block", () => {
    expect(
      buildOverride({
        enabled: true,
        project_disk_quota_mode: "minimum",
        project_disk_quota_value: 45000,
      }),
    ).toEqual({
      enabled: true,
      expires_at: null,
      project_defaults: {
        disk_quota: {
          mode: "minimum",
          value: 45000,
        },
      },
    });
  });

  it("serializes explicit dedicated-host creation overrides", () => {
    expect(
      buildOverride({
        enabled: true,
        create_hosts: "false",
      }),
    ).toEqual({
      enabled: true,
      expires_at: null,
      features: {
        create_hosts: false,
      },
    });
  });
});
