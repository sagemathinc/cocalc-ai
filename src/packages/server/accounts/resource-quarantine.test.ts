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

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: queryMock }),
}));

jest.mock("@cocalc/server/conat/api/hosts", () => ({
  listHosts: (...args: any[]) => listHostsMock(...args),
  stopHost: (...args: any[]) => stopHostMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  getInterBayBridge: () => ({
    projectControl: (bay_id: string) => ({
      stop: (opts: any) => projectControlStopMock({ bay_id, ...opts }),
    }),
  }),
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
          rows: [
            { project_id: "project-1", owning_bay_id: "bay-1" },
            { project_id: "project-2", owning_bay_id: "bay-2" },
          ],
          rowCount: 2,
        };
      }
      return { rows: [], rowCount: 0 };
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
    expect(result.projects_stop_requested).toBe(2);
    expect(result.project_ids).toEqual(["project-1", "project-2"]);
  });
});
