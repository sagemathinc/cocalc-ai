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
    funding_mode: "account-prepaid",
    effective_limits: {
      prepaid_host_usage_limit_5h_usd: 300,
      prepaid_host_usage_limit_7d_usd: 1000,
      credit_spend_limit_5h_usd: undefined,
      credit_spend_limit_7d_usd: undefined,
    },
    has_active_second_factor: true,
    has_payment_method: true,
    has_usage_subscription: false,
    balance: "25",
    postpaid_unbilled_exposure_usd: "0",
    dedicated_host_window_usage: {
      prepaid_5h_usd: "0",
      prepaid_7d_usd: "0",
      credit_5h_usd: "0",
      credit_7d_usd: "0",
    },
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

  it("allows site-funded dedicated host actions without payment-method or prepaid checks", () => {
    expect(
      evaluateDedicatedHostAdmission({
        action: "start",
        machine_cloud: "gcp",
        snapshot: snapshot({
          funding_mode: "site-funded",
          has_payment_method: false,
          balance: "0",
          effective_limits: {},
        }) as any,
      }),
    ).toMatchObject({
      allowed: true,
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

  it("allows postpaid-funded dedicated host actions when the tier enables automatic billing", () => {
    expect(
      evaluateDedicatedHostAdmission({
        action: "start",
        machine_cloud: "gcp",
        snapshot: snapshot({
          funding_mode: "account-postpaid",
          effective_limits: {
            credit_spend_limit_5h_usd: 300,
            credit_spend_limit_7d_usd: 1000,
          },
          balance: "0",
          has_usage_subscription: true,
        }) as any,
      }),
    ).toMatchObject({
      allowed: true,
      funding_lane: "credit",
    });
  });

  it("requires automatic billing for postpaid dedicated host actions", () => {
    expect(
      evaluateDedicatedHostAdmission({
        action: "start",
        machine_cloud: "gcp",
        snapshot: snapshot({
          funding_mode: "account-postpaid",
          effective_limits: {
            credit_spend_limit_5h_usd: 300,
            credit_spend_limit_7d_usd: 1000,
          },
          balance: "0",
          has_usage_subscription: false,
        }) as any,
      }),
    ).toMatchObject({
      allowed: false,
      code: "automatic_billing_required",
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

  it("denies prepaid-funded actions when the prepaid usage window is exhausted", () => {
    expect(
      evaluateDedicatedHostAdmission({
        action: "start",
        machine_cloud: "gcp",
        snapshot: snapshot({
          dedicated_host_window_usage: {
            prepaid_5h_usd: "300",
            prepaid_7d_usd: "400",
            credit_5h_usd: "0",
            credit_7d_usd: "0",
          },
        }) as any,
      }),
    ).toMatchObject({
      allowed: false,
      code: "prepaid_usage_window_exceeded",
    });
  });

  it("does not fall through to credit when prepaid is exhausted", () => {
    expect(
      evaluateDedicatedHostAdmission({
        action: "start",
        machine_cloud: "gcp",
        snapshot: snapshot({
          effective_limits: {
            prepaid_host_usage_limit_5h_usd: 300,
            prepaid_host_usage_limit_7d_usd: 1000,
            credit_spend_limit_5h_usd: 300,
            credit_spend_limit_7d_usd: 1000,
          },
          dedicated_host_window_usage: {
            prepaid_5h_usd: "300",
            prepaid_7d_usd: "400",
            credit_5h_usd: "0",
            credit_7d_usd: "0",
          },
        }) as any,
      }),
    ).toMatchObject({
      allowed: false,
      code: "prepaid_usage_window_exceeded",
    });
  });

  it("denies postpaid-funded actions when the credit usage window is exhausted", () => {
    expect(
      evaluateDedicatedHostAdmission({
        action: "start",
        machine_cloud: "gcp",
        snapshot: snapshot({
          funding_mode: "account-postpaid",
          effective_limits: {
            credit_spend_limit_5h_usd: 300,
            credit_spend_limit_7d_usd: 1000,
          },
          balance: "0",
          has_usage_subscription: true,
          dedicated_host_window_usage: {
            prepaid_5h_usd: "0",
            prepaid_7d_usd: "0",
            credit_5h_usd: "300",
            credit_7d_usd: "400",
          },
        }) as any,
      }),
    ).toMatchObject({
      allowed: false,
      code: "postpaid_usage_window_exceeded",
    });
  });
});
