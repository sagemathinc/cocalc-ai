/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { AccountLocalDedicatedHostPolicySnapshot } from "@cocalc/conat/inter-bay/api";
import {
  buildDedicatedHostBillingEnforcementMetadata,
  evaluateDedicatedHostBillingEnforcement,
} from "./spend-enforcement";

function snapshot(
  overrides: Partial<AccountLocalDedicatedHostPolicySnapshot> = {},
): AccountLocalDedicatedHostPolicySnapshot {
  return {
    account_id: "acc-1",
    membership_class: "member",
    can_create_hosts: true,
    funding_mode: "account-prepaid",
    effective_limits: {
      prepaid_host_usage_limit_5h_usd: 300,
      prepaid_host_usage_limit_7d_usd: 1000,
    },
    has_active_second_factor: true,
    has_payment_method: true,
    has_usage_subscription: false,
    balance: "100",
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

describe("dedicated host billing enforcement", () => {
  it("keeps prepaid hosts ok when runway is above the warning window", () => {
    const decision = evaluateDedicatedHostBillingEnforcement({
      snapshot: snapshot({ balance: "100" }),
      funding_lane: "prepaid",
      hourly_cost_usd: "10",
      lane_allowed: true,
    });

    expect(decision).toEqual(
      expect.objectContaining({
        state: "ok",
        action: "none",
      }),
    );
  });

  it("marks prepaid hosts at risk when balance runway is low", () => {
    const decision = evaluateDedicatedHostBillingEnforcement({
      snapshot: snapshot({ balance: "15" }),
      funding_lane: "prepaid",
      hourly_cost_usd: "10",
      lane_allowed: true,
    });

    expect(decision).toEqual(
      expect.objectContaining({
        state: "at_risk",
        action: "mark_at_risk",
        reason_code: "prepaid_runway_low",
        limiting_window: "prepaid_balance",
      }),
    );
  });

  it("requests drain when prepaid lane is no longer allowed", () => {
    const decision = evaluateDedicatedHostBillingEnforcement({
      snapshot: snapshot({ balance: "0" }),
      funding_lane: "prepaid",
      hourly_cost_usd: "10",
      lane_allowed: false,
    });

    expect(decision).toEqual(
      expect.objectContaining({
        state: "draining",
        action: "request_drain",
        reason_code: "prepaid_balance_exhausted",
        recovery_actions: ["add_funds", "support_limit_increase"],
      }),
    );
  });

  it("requests drain when postpaid 7-day usage has too little runway", () => {
    const decision = evaluateDedicatedHostBillingEnforcement({
      snapshot: snapshot({
        funding_mode: "account-postpaid",
        effective_limits: {
          credit_spend_limit_5h_usd: 300,
          credit_spend_limit_7d_usd: 1000,
        },
        has_usage_subscription: true,
        dedicated_host_window_usage: {
          prepaid_5h_usd: "0",
          prepaid_7d_usd: "0",
          credit_5h_usd: "100",
          credit_7d_usd: "995",
        },
      }),
      funding_lane: "credit",
      hourly_cost_usd: "10",
      lane_allowed: true,
    });

    expect(decision).toEqual(
      expect.objectContaining({
        state: "draining",
        action: "request_drain",
        reason_code: "postpaid_usage_window_7d_exhausted",
        limiting_window: "credit_7d",
      }),
    );
  });

  it("preserves first-detected time when updating enforcement metadata", () => {
    const decision = evaluateDedicatedHostBillingEnforcement({
      snapshot: snapshot({ balance: "0" }),
      funding_lane: "prepaid",
      hourly_cost_usd: "10",
      lane_allowed: false,
    });
    const metadata = buildDedicatedHostBillingEnforcementMetadata({
      previous: {
        state: "at_risk",
        first_detected_at: "2026-05-09T01:00:00.000Z",
      },
      decision,
      hourly_cost_usd: "10",
      now: new Date("2026-05-09T02:00:00.000Z"),
    });

    expect(metadata).toEqual(
      expect.objectContaining({
        state: "draining",
        first_detected_at: "2026-05-09T01:00:00.000Z",
        drain_requested_at: "2026-05-09T02:00:00.000Z",
        final_backup_status: "running",
      }),
    );
  });
});
