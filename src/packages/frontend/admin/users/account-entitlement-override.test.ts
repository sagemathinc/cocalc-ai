/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { __test__, buildOverride } from "./account-entitlement-override";

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

  it("serializes ACP usage-limit overrides", () => {
    expect(
      buildOverride({
        enabled: true,
        acp_running_per_account_mode: "maximum",
        acp_running_per_account_value: 3,
      }),
    ).toEqual({
      enabled: true,
      expires_at: null,
      usage_limits: {
        acp_max_running_per_account: {
          mode: "maximum",
          value: 3,
        },
      },
    });
  });

  it("serializes independent abuse enforcement exemptions", () => {
    expect(
      buildOverride({
        enabled: true,
        bandwidth_relay_abuse_exempt: "true",
        cryptomining_abuse_exempt: "false",
      }),
    ).toEqual({
      enabled: true,
      expires_at: null,
      features: {
        bandwidth_relay_abuse_exempt: true,
        cryptomining_abuse_exempt: false,
      },
    });
  });
});

describe("control-plane egress overrides", () => {
  const stored = {
    enabled: true,
    expires_at: null,
    usage_limits: {
      control_plane_egress_5h_bytes: { mode: "set", value: 0 },
      control_plane_egress_7d_bytes: { mode: "set", value: 200_000_000_000 },
    },
  } as any;

  it("survives loading into the form and saving an unrelated change", () => {
    let values: Record<string, any> = {};
    __test__.resetFormFields(
      { setFieldsValue: (v: Record<string, any>) => (values = v) } as any,
      stored,
    );
    // shown in GB, like the shared egress limits
    expect(values.control_plane_egress_7d_mode).toBe("set");
    expect(values.control_plane_egress_7d_value).toBe(200);
    expect(values.control_plane_egress_5h_value).toBe(0);
    const saved = buildOverride({ ...values, create_hosts: "true" });
    expect(saved.usage_limits).toEqual(stored.usage_limits);
    expect(saved.features).toEqual({ create_hosts: true });
  });

  it("is described in the override summary", () => {
    const effects = __test__.describeOverride(stored);
    expect(
      effects.some(
        (line) => /control traffic, 7-day/i.test(line) && /200/.test(line),
      ),
    ).toBe(true);
    expect(
      effects.some(
        (line) => /control traffic, 5-hour/i.test(line) && / 0 /.test(line),
      ),
    ).toBe(true);
  });
});
