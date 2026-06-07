/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { classifyManagedCpuAccountingScopeFromHost } from "./managed-cpu-scope";

describe("managed CPU accounting scope classification", () => {
  it("counts tiered shared hosts toward the managed CPU budget", () => {
    expect(
      classifyManagedCpuAccountingScopeFromHost({
        tier: 2,
        metadata: {},
      }),
    ).toMatchObject({
      scope: "shared_managed",
      counts_toward_managed_cpu_budget: true,
      host_tier_snapshot: 2,
    });
  });

  it("excludes account-prepaid dedicated hosts from the managed CPU budget", () => {
    expect(
      classifyManagedCpuAccountingScopeFromHost({
        tier: null,
        metadata: { billing: { funding_mode: "account-prepaid" } },
      }),
    ).toMatchObject({
      scope: "account_funded_dedicated",
      counts_toward_managed_cpu_budget: false,
      host_funding_mode_snapshot: "account-prepaid",
    });
  });

  it("excludes account-postpaid dedicated hosts from the managed CPU budget", () => {
    expect(
      classifyManagedCpuAccountingScopeFromHost({
        metadata: { billing: { funding_mode: "account-postpaid" } },
      }),
    ).toMatchObject({
      scope: "account_funded_dedicated",
      counts_toward_managed_cpu_budget: false,
      host_funding_mode_snapshot: "account-postpaid",
    });
  });

  it("keeps site-funded dedicated hosts budget-counting", () => {
    expect(
      classifyManagedCpuAccountingScopeFromHost({
        metadata: { billing: { funding_mode: "site-funded" } },
      }),
    ).toMatchObject({
      scope: "site_funded_dedicated",
      counts_toward_managed_cpu_budget: true,
      host_funding_mode_snapshot: "site-funded",
    });
  });

  it("excludes local and self-host project hosts from hosted managed CPU budgets", () => {
    expect(
      classifyManagedCpuAccountingScopeFromHost({
        metadata: { machine: { cloud: "self-host" } },
      }),
    ).toMatchObject({
      scope: "local_or_self_host",
      counts_toward_managed_cpu_budget: false,
      host_kind_snapshot: "self-host:local",
    });

    expect(
      classifyManagedCpuAccountingScopeFromHost({
        metadata: { provider: "star" },
      }),
    ).toMatchObject({
      scope: "local_or_self_host",
      counts_toward_managed_cpu_budget: false,
      host_kind_snapshot: "star",
    });
  });

  it("treats missing or unclassified hosts conservatively", () => {
    expect(classifyManagedCpuAccountingScopeFromHost(undefined)).toMatchObject({
      scope: "unknown",
      counts_toward_managed_cpu_budget: true,
    });

    expect(
      classifyManagedCpuAccountingScopeFromHost({ metadata: {} }),
    ).toMatchObject({
      scope: "unknown",
      counts_toward_managed_cpu_budget: true,
    });
  });
});
