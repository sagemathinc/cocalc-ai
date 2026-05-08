/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { evaluateDedicatedHostAdmission } from "./admission";

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    account_id: "acc-1",
    membership_class: "member",
    can_create_hosts: true,
    effective_limits: {
      prepaid_host_usage_limit_5h_usd: 300,
      prepaid_host_usage_limit_7d_usd: 1000,
      credit_spend_limit_5h_usd: undefined,
      credit_spend_limit_7d_usd: undefined,
    },
    has_active_second_factor: true,
    has_payment_method: true,
    balance: "25",
    min_balance: "0",
    ...overrides,
  };
}

describe("evaluateDedicatedHostAdmission", () => {
  it("allows self-host actions without billable-host checks", () => {
    expect(
      evaluateDedicatedHostAdmission({
        action: "create",
        machine_cloud: "self-host",
        snapshot: snapshot({
          can_create_hosts: false,
          has_active_second_factor: false,
          has_payment_method: false,
        }) as any,
      }),
    ).toEqual({ allowed: true });
  });

  it("requires dedicated-host membership entitlement for billable clouds", () => {
    expect(
      evaluateDedicatedHostAdmission({
        action: "start",
        machine_cloud: "gcp",
        snapshot: snapshot({ can_create_hosts: false }) as any,
      }),
    ).toMatchObject({
      allowed: false,
      code: "membership_hosts_not_allowed",
    });
  });

  it("requires two-factor authentication for billable clouds", () => {
    expect(
      evaluateDedicatedHostAdmission({
        action: "create",
        machine_cloud: "gcp",
        snapshot: snapshot({ has_active_second_factor: false }) as any,
      }),
    ).toMatchObject({
      allowed: false,
      code: "two_factor_required",
    });
  });

  it("requires a payment method for billable clouds", () => {
    expect(
      evaluateDedicatedHostAdmission({
        action: "resize",
        machine_cloud: "gcp",
        snapshot: snapshot({ has_payment_method: false }) as any,
      }),
    ).toMatchObject({
      allowed: false,
      code: "payment_method_required",
    });
  });

  it("allows prepaid-funded dedicated host actions when the tier enables prepaid use", () => {
    expect(
      evaluateDedicatedHostAdmission({
        action: "start",
        machine_cloud: "gcp",
        snapshot: snapshot() as any,
      }),
    ).toMatchObject({
      allowed: true,
      funding_lane: "prepaid",
    });
  });

  it("allows credit-funded dedicated host actions when the tier enables credit and the account has headroom", () => {
    expect(
      evaluateDedicatedHostAdmission({
        action: "start",
        machine_cloud: "gcp",
        snapshot: snapshot({
          effective_limits: {
            credit_spend_limit_5h_usd: 300,
            credit_spend_limit_7d_usd: 1000,
          },
          balance: "-25",
          min_balance: "-100",
        }) as any,
      }),
    ).toMatchObject({
      allowed: true,
      funding_lane: "credit",
    });
  });

  it("denies billable clouds when no dedicated-host spending lane is configured", () => {
    expect(
      evaluateDedicatedHostAdmission({
        action: "create",
        machine_cloud: "gcp",
        snapshot: snapshot({
          effective_limits: {},
          balance: "0",
        }) as any,
      }),
    ).toMatchObject({
      allowed: false,
      code: "membership_host_spend_not_configured",
    });
  });
});
