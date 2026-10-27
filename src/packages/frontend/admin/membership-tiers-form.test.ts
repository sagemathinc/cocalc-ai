/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {},
}));

import {
  buildMembershipTierPayload,
  MODELED_TIER_JSON_KEYS,
  tierToFormValues,
} from "./membership-tiers";

const tier = {
  id: "pro",
  label: "Pro",
  usage_limits: {
    acp_max_created_5h_per_account: 500,
    acp_max_created_7d_per_account: 2000,
    acp_max_running_per_account: 4,
    blob_account_total_gb: 10,
  },
  features: { create_hosts: true, some_flag: "x" },
  ai_limits: { units_5h: 100, units_7d: 500, model_overrides: { a: 1 } },
  project_defaults: { memory: 2000, other_default: 2 },
} as any;

describe("membership tier form", () => {
  it("shows modeled keys only in their fields, not in the JSON editors", () => {
    const values = tierToFormValues(tier);
    expect(values.usage_limits).toEqual({ blob_account_total_gb: 10 });
    expect(values.usage_limit_acp_max_created_7d_per_account).toBe(2000);
    expect(values.features).toEqual({ some_flag: "x" });
    expect(values.feature_create_hosts).toBe(true);
    expect(values.ai_limits).toEqual({ model_overrides: { a: 1 } });
    expect(values.ai_limit_units_7d).toBe(500);
    expect(values.project_defaults).toEqual({ other_default: 2 });
    expect(values.project_default_memory_mb).toBe(2000);
  });

  it("round-trips a tier unchanged", () => {
    const payload = buildMembershipTierPayload(tierToFormValues(tier));
    expect(payload.usage_limits).toEqual(tier.usage_limits);
    expect(payload.features).toEqual(tier.features);
    expect(payload.ai_limits).toEqual(tier.ai_limits);
    expect(payload.project_defaults).toEqual(tier.project_defaults);
  });

  it("saves the value set in a modeled field", () => {
    // The lost edit: 2500/10000 must not revert to the stored 500/2000.
    const payload = buildMembershipTierPayload({
      ...tierToFormValues(tier),
      usage_limit_acp_max_created_5h_per_account: 2500,
      usage_limit_acp_max_created_7d_per_account: 10000,
    });
    expect(payload.usage_limits).toMatchObject({
      acp_max_created_5h_per_account: 2500,
      acp_max_created_7d_per_account: 10000,
    });
  });

  it("keeps an edit to an unmodeled key in the JSON", () => {
    const values = tierToFormValues(tier);
    const payload = buildMembershipTierPayload({
      ...values,
      usage_limits: { ...values.usage_limits, blob_account_total_gb: 50 },
    });
    expect(payload.usage_limits).toMatchObject({ blob_account_total_gb: 50 });
  });

  it("refuses a modeled key typed into the JSON instead of dropping it", () => {
    const values = tierToFormValues(tier);
    expect(() =>
      buildMembershipTierPayload({
        ...values,
        usage_limits: {
          ...values.usage_limits,
          acp_max_created_7d_per_account: 10000,
        },
      }),
    ).toThrow(/usage_limits\.acp_max_created_7d_per_account has its own field/);
    for (const field of ["features", "ai_limits", "project_defaults"]) {
      const key = MODELED_TIER_JSON_KEYS[field][0];
      expect(() =>
        buildMembershipTierPayload({
          ...values,
          [field]: { ...values[field], [key]: 1 },
        }),
      ).toThrow(`${field}.${key}`);
    }
  });
});
