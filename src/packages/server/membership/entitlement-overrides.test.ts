/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  applyAccountEntitlementOverride,
  applyNumericLimitRule,
  normalizeAccountEntitlementOverride,
} from "./entitlement-overrides";
import type { MembershipResolution } from "@cocalc/conat/hub/api/purchases";

function membership(
  overrides: Partial<MembershipResolution> = {},
): MembershipResolution {
  return {
    class: "member",
    source: "subscription",
    entitlements: {
      features: { create_hosts: false },
      project_defaults: {
        disk_quota: 10000,
        memory: 8000,
        memory_request: 1000,
      },
      ai_limits: {
        units_5h: 50,
        units_7d: 200,
      },
      usage_limits: {
        max_projects: 10,
        max_sponsored_running_projects: 3,
        credit_spend_limit_7d_usd: 100,
      },
    },
    effective_limits: {
      max_projects: 10,
      max_sponsored_running_projects: 3,
      credit_spend_limit_7d_usd: 100,
    },
    ...overrides,
  };
}

function override(payload: Record<string, unknown>) {
  return normalizeAccountEntitlementOverride({
    account_id: "account-1",
    enabled: true,
    updated_by: "admin-1",
    updated_at: new Date("2026-05-09T00:00:00Z"),
    ...payload,
  })!;
}

describe("admin entitlement overrides", () => {
  it("applies numeric minimum, maximum, and set rules", () => {
    expect(applyNumericLimitRule(100, { mode: "minimum", value: 300 })).toBe(
      300,
    );
    expect(applyNumericLimitRule(500, { mode: "minimum", value: 300 })).toBe(
      500,
    );
    expect(applyNumericLimitRule(500, { mode: "maximum", value: 300 })).toBe(
      300,
    );
    expect(applyNumericLimitRule(500, { mode: "set", value: 125 })).toBe(125);
  });

  it("merges feature, usage, project default, and ai limit overrides", () => {
    const result = applyAccountEntitlementOverride({
      membership: membership(),
      override: override({
        features: { create_hosts: true },
        usage_limits: {
          max_projects: { mode: "maximum", value: 5 },
          max_sponsored_running_projects: { mode: "set", value: 2 },
          credit_spend_limit_7d_usd: { mode: "minimum", value: 300 },
        },
        project_defaults: {
          disk_quota: { mode: "minimum", value: 20000 },
          memory: { mode: "set", value: 12000 },
        },
        ai_limits: {
          units_5h: { mode: "maximum", value: 25 },
          units_7d: { mode: "minimum", value: 500 },
        },
      }),
    });

    expect(result.entitlements.features?.create_hosts).toBe(true);
    expect(result.effective_limits).toMatchObject({
      max_projects: 5,
      max_sponsored_running_projects: 2,
      credit_spend_limit_7d_usd: 300,
    });
    expect(result.entitlements.project_defaults).toMatchObject({
      disk_quota: 20000,
      memory: 12000,
      memory_request: 1000,
    });
    expect(result.entitlements.ai_limits).toMatchObject({
      units_5h: 25,
      units_7d: 500,
    });
  });

  it("does not let a support minimum cap a later higher membership", () => {
    const result = applyAccountEntitlementOverride({
      membership: membership({
        effective_limits: { credit_spend_limit_7d_usd: 500 },
        entitlements: {
          usage_limits: { credit_spend_limit_7d_usd: 500 },
        },
      }),
      override: override({
        usage_limits: {
          credit_spend_limit_7d_usd: { mode: "minimum", value: 300 },
        },
      }),
    });

    expect(result.effective_limits?.credit_spend_limit_7d_usd).toBe(500);
  });

  it("keeps an admin maximum cap across a later higher membership", () => {
    const result = applyAccountEntitlementOverride({
      membership: membership({
        effective_limits: { credit_spend_limit_7d_usd: 500 },
        entitlements: {
          usage_limits: { credit_spend_limit_7d_usd: 500 },
        },
      }),
      override: override({
        usage_limits: {
          credit_spend_limit_7d_usd: { mode: "maximum", value: 50 },
        },
      }),
    });

    expect(result.effective_limits?.credit_spend_limit_7d_usd).toBe(50);
  });

  it("rejects unknown keys so JSON typos do not silently do nothing", () => {
    expect(() =>
      override({
        ai_limits: {
          units_5hr: { mode: "set", value: 10 },
        },
      }),
    ).toThrow("ai_limits.units_5hr is not a supported override key");
  });
});
