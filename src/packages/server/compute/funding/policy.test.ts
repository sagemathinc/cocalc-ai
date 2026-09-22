/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import type { AccountLocalDedicatedHostPolicySnapshot } from "@cocalc/conat/inter-bay/api";
import {
  assertComputeFundingServicePolicy,
  evaluateComputeFundingPolicy,
} from "./policy";

function fixture(lane: "prepaid" | "postpaid" = "prepaid") {
  const payer = randomUUID();
  const snapshot: AccountLocalDedicatedHostPolicySnapshot = {
    account_id: payer,
    membership_class: "member",
    can_create_hosts: true,
    funding_mode: lane === "prepaid" ? "account-prepaid" : "account-postpaid",
    effective_limits: {
      prepaid_host_usage_limit_5h_usd: 300,
      prepaid_host_usage_limit_7d_usd: 1000,
      credit_spend_limit_5h_usd: 300,
      credit_spend_limit_7d_usd: 1000,
    },
    has_active_second_factor: true,
    has_payment_method: true,
    has_usage_subscription: true,
    balance: "1000",
    postpaid_unbilled_exposure_usd: "0",
    dedicated_host_window_usage: {
      prepaid_5h_usd: "20",
      prepaid_7d_usd: "100",
      credit_5h_usd: "20",
      credit_7d_usd: "100",
    },
  };
  return {
    payer_account_id: payer,
    lane,
    snapshot,
    backing: {
      ledger_balance_usd: "1000",
      prepaid_held_usd: "1000",
      postpaid_committed_usd: "700",
      spendable_prepaid_usd: "0",
    },
    outstanding_resource_usd: "30",
    windows: {
      "5h": {
        id: randomUUID(),
        account_id: payer,
        scope: "membership" as const,
        window: "5h" as const,
        epoch: 1,
        starts_at: new Date("2026-09-12T00:00:00Z"),
        resets_at: new Date("2026-09-12T05:00:00Z"),
      },
      "7d": {
        id: randomUUID(),
        account_id: payer,
        scope: "membership" as const,
        window: "7d" as const,
        epoch: 1,
        starts_at: new Date("2026-09-12T00:00:00Z"),
        resets_at: new Date("2026-09-19T00:00:00Z"),
      },
    },
  };
}

describe("course funding policy", () => {
  it("does not subtract a pool's full backing again from resource window headroom", () => {
    const policy = evaluateComputeFundingPolicy(fixture());
    expect(policy).toMatchObject({
      backing_capacity_usd: "1000.0000000000",
      available_backing_usd: "0.0000000000",
      backing_valid: true,
      outstanding_resource_usd: "30.0000000000",
      service_headroom_usd: "250.0000000000",
    });
    expect(() =>
      assertComputeFundingServicePolicy(policy, {
        authorized_usd: "50",
        authorized_until: "2026-09-12T04:00:00Z",
      }),
    ).not.toThrow();
  });

  it("backs postpaid with the 7-day limit minus usage and existing commitments", () => {
    const policy = evaluateComputeFundingPolicy(fixture("postpaid"));
    expect(policy).toMatchObject({
      backing_capacity_usd: "900.0000000000",
      available_backing_usd: "200.0000000000",
      backing_valid: true,
      service_headroom_usd: "250.0000000000",
    });
  });

  it("preserves outstanding commitments across usage-window resets", () => {
    const f = fixture("postpaid");
    f.snapshot.dedicated_host_window_usage.credit_5h_usd = "0";
    f.snapshot.dedicated_host_window_usage.credit_7d_usd = "0";
    f.windows["5h"].epoch = 2;
    f.windows["7d"].epoch = 2;
    const policy = evaluateComputeFundingPolicy(f);
    expect(policy.available_backing_usd).toBe("300.0000000000");
    expect(policy.service_headroom_usd).toBe("270.0000000000");
  });

  it("detects invalid backing after a balance loss or credit-line reduction", () => {
    for (const lane of ["prepaid", "postpaid"] as const) {
      const f = fixture(lane);
      if (lane === "prepaid") f.backing.ledger_balance_usd = "900";
      else f.snapshot.effective_limits.credit_spend_limit_7d_usd = 500;
      const policy = evaluateComputeFundingPolicy(f);
      expect(policy.backing_valid).toBe(false);
      expect(policy.available_backing_usd).toBe("0.0000000000");
      expect(() =>
        assertComputeFundingServicePolicy(policy, {
          authorized_usd: "1",
          authorized_until: "2026-09-12T04:00:00Z",
        }),
      ).toThrow(/backing/);
    }
  });

  it.each([0, -1, NaN, Infinity, undefined])(
    "does not infer unlimited spending from an invalid 7-day limit (%s)",
    (limit) => {
      const f = fixture("postpaid");
      f.snapshot.effective_limits.credit_spend_limit_7d_usd = limit;
      expect(() => evaluateComputeFundingPolicy(f)).toThrow(
        /positive 5-hour and 7-day/,
      );
    },
  );

  it("requires both windows even when the other has a large allowance", () => {
    const f = fixture();
    f.snapshot.effective_limits.prepaid_host_usage_limit_5h_usd = 0;
    expect(() => evaluateComputeFundingPolicy(f)).toThrow(/spending limits/);
  });

  it("does not confuse prepaid deposits with postpaid billing readiness", () => {
    const f = fixture("postpaid");
    f.snapshot.has_payment_method = false;
    expect(() => evaluateComputeFundingPolicy(f)).toThrow(
      /approved automatic billing/,
    );
    f.snapshot.has_payment_method = true;
    f.snapshot.has_usage_subscription = false;
    expect(() => evaluateComputeFundingPolicy(f)).toThrow(
      /approved automatic billing/,
    );
  });

  it("retains the explicit trusted-admin manual-collection exception", () => {
    const f = fixture("postpaid");
    f.snapshot.has_payment_method = false;
    f.snapshot.has_usage_subscription = false;
    f.snapshot.admin_override = {
      dedicated_hosts: { funding_mode: { value: "account-postpaid" } },
    };
    expect(evaluateComputeFundingPolicy(f).backing_valid).toBe(true);
  });

  it("does not require the prepaid payer to have a card", () => {
    const f = fixture();
    f.snapshot.has_payment_method = false;
    f.snapshot.has_usage_subscription = false;
    expect(evaluateComputeFundingPolicy(f).backing_valid).toBe(true);
  });

  it("requires the actual payer's compute permission and second factor", () => {
    for (const patch of [
      { can_create_hosts: false },
      { has_active_second_factor: false },
      { account_id: randomUUID() },
    ]) {
      const f = fixture();
      Object.assign(f.snapshot, patch);
      expect(() => evaluateComputeFundingPolicy(f)).toThrow();
    }
  });

  it("distinguishes missing membership permission from missing two-factor authentication", () => {
    const f = fixture();
    f.snapshot.can_create_hosts = false;
    expect(() => evaluateComputeFundingPolicy(f)).toThrow(
      /membership does not allow/,
    );
    f.snapshot.can_create_hosts = true;
    f.snapshot.has_active_second_factor = false;
    expect(() => evaluateComputeFundingPolicy(f)).toThrow(
      /enable two-factor authentication in account settings/,
    );
  });

  it("rejects additional reservations beyond either window, not just the course total", () => {
    const f = fixture();
    f.snapshot.dedicated_host_window_usage.prepaid_7d_usd = "960";
    const policy = evaluateComputeFundingPolicy(f);
    expect(policy.service_headroom_usd).toBe("10.0000000000");
    expect(() =>
      assertComputeFundingServicePolicy(policy, {
        authorized_usd: "11",
        authorized_until: "2026-09-12T04:00:00Z",
      }),
    ).toThrow(/usage windows/);
  });

  it("does not authorize future windows or use another account's window identity", () => {
    const policy = evaluateComputeFundingPolicy(fixture());
    expect(() =>
      assertComputeFundingServicePolicy(policy, {
        authorized_usd: "1",
        authorized_until: "2026-09-12T06:00:00Z",
      }),
    ).toThrow(/current usage windows/);
    policy.windows["5h"].window!.account_id = randomUUID();
    expect(() =>
      assertComputeFundingServicePolicy(policy, {
        authorized_usd: "1",
        authorized_until: "2026-09-12T04:00:00Z",
      }),
    ).toThrow(/current usage windows/);
    delete policy.windows["5h"].window;
    expect(() =>
      assertComputeFundingServicePolicy(policy, {
        authorized_usd: "1",
        authorized_until: "2026-09-12T04:00:00Z",
      }),
    ).toThrow(/current usage windows/);
  });
});
