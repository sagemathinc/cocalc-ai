/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const queryMock = jest.fn();
const listHostsMock = jest.fn();
const stopHostMock = jest.fn();
const cancelUsageSubscriptionMock = jest.fn();
const cancelPaymentIntentMock = jest.fn();
const getAllOpenPaymentsMock = jest.fn();
const getPaymentMethodsMock = jest.fn();
const deletePaymentMethodMock = jest.fn();
const recordAccountResourceQuarantineAuditEventMock = jest.fn();
const projectControlStopMock = jest.fn();
const bayOpsGetProjectRuntimeSlotReportMock = jest.fn();
const listClusterBayInfosMock = jest.fn();
const executeBillingAuthorityCommandMock = jest.fn();
const setBillingAccountFrozenMock = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: queryMock }),
}));

jest.mock("@cocalc/server/conat/api/hosts", () => ({
  listHosts: (...args: any[]) => listHostsMock(...args),
  stopHost: (...args: any[]) => stopHostMock(...args),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-1",
}));

jest.mock("@cocalc/server/bay-registry", () => ({
  listClusterBayInfos: (...args: any[]) => listClusterBayInfosMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  getInterBayBridge: () => ({
    projectControl: (bay_id: string) => ({
      stop: (opts: any) => projectControlStopMock({ bay_id, ...opts }),
    }),
    bayOps: (bay_id: string) => ({
      getProjectRuntimeSlotReport: (opts: any) =>
        bayOpsGetProjectRuntimeSlotReportMock({ bay_id, ...opts }),
    }),
  }),
}));

jest.mock("@cocalc/server/purchases/billing-authority/client", () => ({
  executeBillingAuthorityCommand: (...args: any[]) =>
    executeBillingAuthorityCommandMock(...args),
  setBillingAccountFrozen: (...args: any[]) =>
    setBillingAccountFrozenMock(...args),
}));

jest.mock("@cocalc/server/purchases/stripe-usage-based-subscription", () => ({
  cancelUsageSubscription: (...args: any[]) =>
    cancelUsageSubscriptionMock(...args),
}));

jest.mock("@cocalc/server/purchases/stripe/create-payment-intent", () => ({
  cancelPaymentIntent: (...args: any[]) => cancelPaymentIntentMock(...args),
}));

jest.mock("@cocalc/server/purchases/stripe/get-payments", () => ({
  getAllOpenPayments: (...args: any[]) => getAllOpenPaymentsMock(...args),
}));

jest.mock("@cocalc/server/purchases/stripe/get-payment-methods", () => ({
  __esModule: true,
  default: (...args: any[]) => getPaymentMethodsMock(...args),
}));

jest.mock("@cocalc/server/purchases/stripe/delete-payment-method", () => ({
  __esModule: true,
  default: (...args: any[]) => deletePaymentMethodMock(...args),
}));

jest.mock("./resource-quarantine-audit", () => ({
  recordAccountResourceQuarantineAuditEvent: (...args: any[]) =>
    recordAccountResourceQuarantineAuditEventMock(...args),
}));

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

describe("account resource quarantine", () => {
  beforeEach(() => {
    jest.resetModules();
    queryMock.mockReset().mockImplementation(async (sql: string) => {
      if (sql.includes("UPDATE accounts") && sql.includes("auto_balance")) {
        return { rows: [{ auto_balance: null }], rowCount: 1 };
      }
      if (sql.includes("UPDATE subscriptions")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("stripe_usage_subscription")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("FROM project_runtime_slots")) {
        return {
          rows: [{ project_id: "project-1", owning_bay_id: "bay-1" }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    listClusterBayInfosMock
      .mockReset()
      .mockResolvedValue([{ bay_id: "bay-1" }, { bay_id: "bay-2" }]);
    bayOpsGetProjectRuntimeSlotReportMock.mockReset().mockResolvedValue({
      slots: [{ project_id: "project-2", owning_bay_id: "bay-2" }],
    });
    listHostsMock.mockReset().mockResolvedValue([]);
    stopHostMock.mockReset().mockResolvedValue(undefined);
    cancelUsageSubscriptionMock.mockReset().mockResolvedValue(undefined);
    cancelPaymentIntentMock.mockReset().mockResolvedValue(undefined);
    getAllOpenPaymentsMock.mockReset().mockResolvedValue({ data: [] });
    getPaymentMethodsMock
      .mockReset()
      .mockResolvedValue({ data: [], has_more: false });
    deletePaymentMethodMock.mockReset().mockResolvedValue(undefined);
    executeBillingAuthorityCommandMock
      .mockReset()
      .mockImplementation(async (command) => {
        if (command.kind === "quarantine-account-stripe-cleanup") {
          await cancelUsageSubscriptionMock(command.account_id);
          return {
            usage_subscription_canceled: true,
            payment_intents_canceled: 0,
            payment_methods_detached: 0,
          };
        }
        throw Error(`unexpected billing command '${command.kind}'`);
      });
    setBillingAccountFrozenMock.mockReset().mockResolvedValue({
      account_id: ACCOUNT_ID,
      frozen: true,
      generation: 1,
    });
    recordAccountResourceQuarantineAuditEventMock
      .mockReset()
      .mockResolvedValue(undefined);
    projectControlStopMock.mockReset().mockResolvedValue(undefined);
  });

  it("stops projects that consume the account runtime slot", async () => {
    const { quarantineAccountBillingResourcesLocal } =
      await import("./resource-quarantine");
    const result = await quarantineAccountBillingResourcesLocal({
      account_id: ACCOUNT_ID,
      actor_account_id: "22222222-2222-4222-8222-222222222222",
      reason: "ban",
      home_bay_id: "bay-1",
    });

    expect(projectControlStopMock).toHaveBeenCalledWith({
      bay_id: "bay-1",
      project_id: "project-1",
    });
    expect(projectControlStopMock).toHaveBeenCalledWith({
      bay_id: "bay-2",
      project_id: "project-2",
    });
    expect(bayOpsGetProjectRuntimeSlotReportMock).toHaveBeenCalledWith({
      bay_id: "bay-2",
      account_id: "22222222-2222-4222-8222-222222222222",
      sponsor_account_id: ACCOUNT_ID,
      active_only: true,
      limit: 1000,
    });
    expect(result.projects_stop_requested).toBe(2);
    expect(result.project_ids).toEqual(["project-1", "project-2"]);
    expect(setBillingAccountFrozenMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      frozen: true,
      cause: "quarantine",
      reason: "ban",
      actor_account_id: "22222222-2222-4222-8222-222222222222",
    });
    expect(
      setBillingAccountFrozenMock.mock.invocationCallOrder[0],
    ).toBeLessThan(
      executeBillingAuthorityCommandMock.mock.invocationCallOrder[0],
    );
  });

  it("stops active solely owned free projects and deduplicates slot projects", async () => {
    listClusterBayInfosMock.mockResolvedValue([{ bay_id: "bay-1" }]);
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("UPDATE accounts") && sql.includes("auto_balance")) {
        return { rows: [{ auto_balance: null }], rowCount: 1 };
      }
      if (sql.includes("UPDATE subscriptions")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("stripe_usage_subscription")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("FROM project_runtime_slots")) {
        return {
          rows: [{ project_id: "shared-project", owning_bay_id: "bay-1" }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM account_project_index")) {
        return {
          rows: [
            { project_id: "shared-project", owning_bay_id: "bay-1" },
            { project_id: "free-project", owning_bay_id: "bay-2" },
          ],
          rowCount: 2,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const { quarantineAccountBillingResourcesLocal } =
      await import("./resource-quarantine");
    const result = await quarantineAccountBillingResourcesLocal({
      account_id: ACCOUNT_ID,
      actor_account_id: "22222222-2222-4222-8222-222222222222",
      reason: "ban",
      home_bay_id: "bay-1",
    });

    expect(projectControlStopMock).toHaveBeenCalledTimes(2);
    expect(projectControlStopMock).toHaveBeenCalledWith({
      bay_id: "bay-1",
      project_id: "shared-project",
      sole_owner_account_id: ACCOUNT_ID,
    });
    expect(projectControlStopMock).toHaveBeenCalledWith({
      bay_id: "bay-2",
      project_id: "free-project",
      sole_owner_account_id: ACCOUNT_ID,
    });
    expect(result.projects_stop_requested).toBe(2);
    expect(result.project_ids).toEqual(["shared-project", "free-project"]);

    const ownershipSql = queryMock.mock.calls.find(([sql]) =>
      `${sql}`.includes("FROM account_project_index"),
    )?.[0];
    expect(ownershipSql).toContain(
      "users_summary #>> ARRAY[$1::TEXT, 'group'] = 'owner'",
    );
    expect(ownershipSql).toContain("member.key <> $1::TEXT");
    expect(ownershipSql).toContain("FROM projects");
    expect(ownershipSql).toContain("IN ('opened', 'running', 'starting')");
  });

  it("still stops slot projects when owned-project discovery fails", async () => {
    listClusterBayInfosMock.mockResolvedValue([{ bay_id: "bay-1" }]);
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("UPDATE accounts") && sql.includes("auto_balance")) {
        return { rows: [{ auto_balance: null }], rowCount: 1 };
      }
      if (sql.includes("UPDATE subscriptions")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("stripe_usage_subscription")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("FROM project_runtime_slots")) {
        return {
          rows: [{ project_id: "slot-project", owning_bay_id: "bay-1" }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM account_project_index")) {
        throw new Error("projection unavailable");
      }
      return { rows: [], rowCount: 0 };
    });

    const { quarantineAccountBillingResourcesLocal } =
      await import("./resource-quarantine");
    const result = await quarantineAccountBillingResourcesLocal({
      account_id: ACCOUNT_ID,
      actor_account_id: "22222222-2222-4222-8222-222222222222",
      reason: "ban",
      home_bay_id: "bay-1",
    });

    expect(projectControlStopMock).toHaveBeenCalledWith({
      bay_id: "bay-1",
      project_id: "slot-project",
    });
    expect(result.projects_stop_requested).toBe(1);
    expect(result.errors).toEqual([
      "list solely owned active projects: Error: projection unavailable",
    ]);
  });

  it("continues containment when installing the billing fence fails", async () => {
    listHostsMock.mockResolvedValue([
      {
        billing_owner_account_id: ACCOUNT_ID,
        id: "host-1",
        status: "running",
      },
    ]);
    setBillingAccountFrozenMock.mockRejectedValueOnce(
      new Error("authority unavailable"),
    );

    const { quarantineAccountBillingResourcesLocal } =
      await import("./resource-quarantine");
    const result = await quarantineAccountBillingResourcesLocal({
      account_id: ACCOUNT_ID,
      actor_account_id: "22222222-2222-4222-8222-222222222222",
      reason: "ban",
      home_bay_id: "bay-1",
    });

    expect(executeBillingAuthorityCommandMock).toHaveBeenCalledWith({
      kind: "quarantine-account-stripe-cleanup",
      account_id: ACCOUNT_ID,
    });
    expect(stopHostMock).toHaveBeenCalledWith({
      account_id: "22222222-2222-4222-8222-222222222222",
      id: "host-1",
    });
    expect(projectControlStopMock).toHaveBeenCalled();
    expect(result.errors).toContain(
      "freeze account billing: Error: authority unavailable",
    );
  });
});
