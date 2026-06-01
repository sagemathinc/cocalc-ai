import {
  analyzeMembershipTierPricingRisk,
  normalizeMembershipTierPricingAssumptions,
} from "./membership-tier-pricing-risk";

describe("membership tier pricing risk", () => {
  it("models weekly hard-cost budgets as monthly exposure", () => {
    const analysis = analyzeMembershipTierPricingRisk(
      {
        priceMonthlyUsd: 20,
        aiUnits7d: 70,
        egress7dGb: 14,
        blobStorageGb: 100,
        rootfsStorageGb: 50,
        creditSpendLimit7dUsd: 7,
        prepaidHostUsageLimit7dUsd: 3,
        cpu7dHours: 168,
        projectMemoryMb: 2000,
        maxSponsoredRunningProjects: 2,
      },
      {
        targetGrossMargin: 0.5,
        overheadReserve: 0.1,
        aiUnitCostUsd: 0.1,
        egressCostPerGb: 0.2,
        blobStorageCostPerGbMonth: 0.01,
        rootfsStorageCostPerGbMonth: 0.02,
        sharedHostUsableVcpu: 16,
        targetCpuOversubscription: 8,
      },
    );

    expect(analysis.targetHardCostBudgetUsd).toBeCloseTo(8);
    expect(analysis.hardCosts.aiMonthlyUsd).toBeCloseTo(30);
    expect(analysis.hardCosts.egressMonthlyUsd).toBeCloseTo(12);
    expect(analysis.hardCosts.blobStorageMonthlyUsd).toBeCloseTo(1);
    expect(analysis.hardCosts.rootfsStorageMonthlyUsd).toBeCloseTo(1);
    expect(analysis.hardCosts.dedicatedHostGuardrailMonthlyUsd).toBeCloseTo(30);
    expect(analysis.capacity.cpuHoursMonthlyBudget).toBeCloseTo(720);
    expect(analysis.capacity.averageCpuEntitlement).toBeCloseTo(1);
    expect(analysis.capacity.activeProjectRamGb).toBeCloseTo(4);
    expect(analysis.messages[0]?.severity).toBe("danger");
  });

  it("uses yearly price when monthly price is absent", () => {
    const analysis = analyzeMembershipTierPricingRisk(
      {
        priceYearlyUsd: 120,
        aiUnits7d: 0,
      },
      {
        targetGrossMargin: 0.7,
        overheadReserve: 0.1,
      },
    );

    expect(analysis.monthlyRevenueUsd).toBe(0);
    expect(analysis.annualizedMonthlyRevenueUsd).toBe(10);
    expect(analysis.targetHardCostBudgetUsd).toBeCloseTo(2);
    expect(analysis.messages[0]?.severity).toBe("ok");
  });

  it("normalizes invalid assumptions to safe defaults", () => {
    const assumptions = normalizeMembershipTierPricingAssumptions({
      targetGrossMargin: 2,
      overheadReserve: -1,
      sharedHostUsableRamGb: 0,
      targetCpuOversubscription: -5,
    });

    expect(assumptions.targetGrossMargin).toBe(1);
    expect(assumptions.overheadReserve).toBe(0);
    expect(assumptions.sharedHostUsableRamGb).toBeGreaterThan(0);
    expect(assumptions.targetCpuOversubscription).toBeGreaterThan(0);
  });
});
