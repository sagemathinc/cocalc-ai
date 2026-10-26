/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const cancelEverythingMock = jest.fn();
const poolQueryMock = jest.fn();

jest.mock("@cocalc/server/stripe/client", () => ({
  __esModule: true,
  StripeClient: jest.fn(() => ({ cancelEverything: cancelEverythingMock })),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: poolQueryMock }),
}));

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

describe("account-stripe-cleanup (sent only by account deletion)", () => {
  it("cancels stripe and clears the authoritative transient billing controls", async () => {
    const calls: string[] = [];
    cancelEverythingMock.mockImplementation(async () => {
      calls.push("cancel");
      return { canceled: true };
    });
    poolQueryMock.mockImplementation(async (sql) => {
      calls.push(sql);
      return { rows: [], rowCount: 1 };
    });
    const { dispatchBillingAuthorityCommand } = await import("./dispatch");
    await expect(
      dispatchBillingAuthorityCommand({
        kind: "account-stripe-cleanup",
        account_id: ACCOUNT_ID,
      }),
    ).resolves.toEqual({ canceled: true });
    expect(calls).toEqual([
      "cancel",
      "UPDATE billing_accounts SET auto_balance=NULL, stripe_checkout_session=NULL, stripe_customer=NULL WHERE account_id=$1",
    ]);
    expect(poolQueryMock.mock.calls[0][1]).toEqual([ACCOUNT_ID]);
  });
});
