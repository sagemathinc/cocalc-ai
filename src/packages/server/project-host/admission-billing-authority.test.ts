/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { getDedicatedHostPolicySnapshotLocal } from "./admission";

const executeBillingAuthorityCommand = jest.fn();

jest.mock("@cocalc/server/purchases/billing-authority/config", () => ({
  isBillingAuthorityEnabled: () => true,
}));
jest.mock("@cocalc/server/purchases/billing-authority/client", () => ({
  executeBillingAuthorityCommand: (...args: unknown[]) =>
    executeBillingAuthorityCommand(...args),
}));
jest.mock("@cocalc/server/membership/resolve", () => ({
  resolveMembershipForAccount: async () => ({
    class: "member",
    entitlements: { features: { create_hosts: true } },
  }),
}));
jest.mock("@cocalc/server/membership/effective-limits", () => ({
  getEffectiveMembershipUsageLimits: () => ({
    prepaid_host_usage_limit_5h_usd: 100,
  }),
}));
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => ({
    project_hosts_funding_mode: "account-prepaid",
  }),
}));
jest.mock("@cocalc/server/membership/entitlement-overrides", () => ({
  getActiveAccountEntitlementOverride: async () => undefined,
}));
jest.mock("@cocalc/server/auth/two-factor", () => ({
  hasActiveSecondFactor: async () => true,
}));

it("combines home-bay policy with seed-authoritative financial state", async () => {
  const financial = {
    has_payment_method: false,
    has_usage_subscription: false,
    balance: "25.0000000000",
    prepaid_spendable_balance: "20.0000000000",
    postpaid_committed_usd: "0.0000000000",
    postpaid_unbilled_exposure_usd: "0.0000000000",
    dedicated_host_window_usage: {
      prepaid_5h_usd: "1.0000000000",
      prepaid_7d_usd: "2.0000000000",
      credit_5h_usd: "0.0000000000",
      credit_7d_usd: "0.0000000000",
    },
  };
  executeBillingAuthorityCommand.mockResolvedValue(financial);

  await expect(
    getDedicatedHostPolicySnapshotLocal("account-1"),
  ).resolves.toMatchObject({
    account_id: "account-1",
    membership_class: "member",
    can_create_hosts: true,
    has_active_second_factor: true,
    ...financial,
  });
  expect(executeBillingAuthorityCommand).toHaveBeenCalledWith(
    {
      kind: "account-local",
      operation: "get-dedicated-host-financial-snapshot",
      input: {
        account_id: "account-1",
        needs_postpaid_snapshot: false,
      },
      actor_account_id: "account-1",
    },
    { read: true },
  );
});
