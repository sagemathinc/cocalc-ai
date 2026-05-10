/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

let sendSystemMessageMock: jest.Mock;

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    warn: jest.fn(),
  })),
}));

jest.mock("@cocalc/server/messages/send", () => ({
  __esModule: true,
  default: (...args: any[]) => sendSystemMessageMock(...args),
}));

describe("dedicated host billing notifications", () => {
  beforeEach(() => {
    jest.resetModules();
    sendSystemMessageMock = jest.fn(async () => 123);
  });

  it("sends a system message for billing enforcement transitions", async () => {
    const { notifyDedicatedHostBillingEnforcement } =
      await import("./billing-notifications");
    await notifyDedicatedHostBillingEnforcement({
      owner_account_id: "11111111-1111-4111-8111-111111111111",
      host_id: "22222222-2222-4222-8222-222222222222",
      host_name: "GPU Host",
      state: "stopped_billing_blocked",
      previous_state: "draining",
      reason: "prepaid balance is exhausted",
      final_backup_status: "succeeded",
      recovery_actions: ["add_funds", "support_limit_increase"],
    });

    expect(sendSystemMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to_ids: ["11111111-1111-4111-8111-111111111111"],
        subject:
          "Dedicated host GPU Host was stopped because billing needs attention",
        dedupMinutes: 24 * 60,
      }),
    );
    const input = sendSystemMessageMock.mock.calls[0][0];
    expect(input.body).toContain("prepaid balance is exhausted");
    expect(input.body).toContain("Final backup: succeeded");
    expect(input.body).toContain("add funds");
    expect(input.body).toContain("Open dedicated hosts: [/hosts](/hosts)");
  });

  it("does not notify when the state did not change", async () => {
    const { notifyDedicatedHostBillingEnforcement } =
      await import("./billing-notifications");
    await notifyDedicatedHostBillingEnforcement({
      owner_account_id: "11111111-1111-4111-8111-111111111111",
      host_id: "22222222-2222-4222-8222-222222222222",
      state: "at_risk",
      previous_state: "at_risk",
    });

    expect(sendSystemMessageMock).not.toHaveBeenCalled();
  });
});
