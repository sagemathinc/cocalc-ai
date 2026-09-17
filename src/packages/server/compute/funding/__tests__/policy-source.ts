/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { PoolClient } from "@cocalc/database/pool";
import type { AccountLocalDedicatedHostPolicySnapshot } from "@cocalc/conat/inter-bay/api";
import getBalance from "@cocalc/server/purchases/get-balance";
import {
  getDedicatedHostWindowUsageLocal,
  getDedicatedHostPostpaidUnbilledExposureLocal,
} from "@cocalc/server/project-host/spend";

type PolicySettings = Pick<
  AccountLocalDedicatedHostPolicySnapshot,
  | "can_create_hosts"
  | "has_active_second_factor"
  | "has_payment_method"
  | "has_usage_subscription"
  | "effective_limits"
  | "admin_override"
>;

const settings = new Map<string, Partial<PolicySettings>>();
const failures = new Map<string, Error>();
const readinessWaiters = new Map<string, () => Promise<void>>();

export function setPolicyFailure(account: string, error?: Error) {
  if (error) failures.set(account, error);
  else failures.delete(account);
}

export function setPolicy(account: string, value: Partial<PolicySettings>) {
  settings.set(account, value);
}

export function setPolicyReadinessWaiter(
  account: string,
  waiter?: () => Promise<void>,
) {
  if (waiter) readinessWaiters.set(account, waiter);
  else readinessWaiters.delete(account);
}

// Only membership/payment configuration is faked. All financial quantities,
// window identities and reservations still come from the real transaction.
export function mockPolicySource() {
  return {
    async getDedicatedHostProviderReadinessLocal(account_id: string) {
      if (failures.has(account_id)) throw failures.get(account_id);
      await readinessWaiters.get(account_id)?.();
      return {
        has_payment_method:
          settings.get(account_id)?.has_payment_method ?? true,
      };
    },
    async getDedicatedHostAdmissionSnapshotForAccount(account_id: string) {
      if (failures.has(account_id)) throw failures.get(account_id);
      return {
        account_id,
        membership_class: "member",
        funding_mode: "account-prepaid",
        can_create_hosts: true,
        has_active_second_factor: true,
        effective_limits: {
          prepaid_host_usage_limit_5h_usd: 1000,
          prepaid_host_usage_limit_7d_usd: 10000,
          credit_spend_limit_5h_usd: 1000,
          credit_spend_limit_7d_usd: 10000,
        },
        ...settings.get(account_id),
      };
    },
    async getDedicatedHostPolicySnapshotLocal(
      account_id: string,
      opts: {
        client: PoolClient;
        funding_mode_override: AccountLocalDedicatedHostPolicySnapshot["funding_mode"];
        admission_snapshot?: AccountLocalDedicatedHostPolicySnapshot;
        has_payment_method_override?: boolean;
      },
    ): Promise<AccountLocalDedicatedHostPolicySnapshot> {
      if (!opts.client)
        throw new Error("Funding policy requires a transaction");
      return {
        account_id,
        membership_class: "member",
        funding_mode: opts.funding_mode_override,
        can_create_hosts: true,
        has_active_second_factor: true,
        has_payment_method: opts.has_payment_method_override ?? true,
        has_usage_subscription: true,
        effective_limits: {
          prepaid_host_usage_limit_5h_usd: 1000,
          prepaid_host_usage_limit_7d_usd: 10000,
          credit_spend_limit_5h_usd: 1000,
          credit_spend_limit_7d_usd: 10000,
        },
        ...settings.get(account_id),
        balance: await getBalance({
          account_id,
          client: opts.client,
          noSave: true,
        }),
        dedicated_host_window_usage: await getDedicatedHostWindowUsageLocal(
          account_id,
          opts,
        ),
        postpaid_unbilled_exposure_usd:
          await getDedicatedHostPostpaidUnbilledExposureLocal(account_id, opts),
      };
    },
  };
}
