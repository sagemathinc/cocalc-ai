/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

let setMetadataMock: jest.Mock;

jest.mock("@cocalc/server/external-credentials/routing", () => ({
  __esModule: true,
  setExternalCredentialMetadataValueByIdRouted: (...args: any[]) =>
    setMetadataMock(...args),
}));

describe("which Claude subscriptions Auto may use", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
  const ID = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    setMetadataMock = jest.fn(async () => true);
  });

  it("marks only the signed-in account's own Claude subscription", async () => {
    const { setClaudeSubscriptionInPool } = await import("./system");
    await expect(
      setClaudeSubscriptionInPool({
        account_id: ACCOUNT_ID,
        id: ID,
        in_pool: false,
      }),
    ).resolves.toEqual({ updated: true });
    expect(setMetadataMock).toHaveBeenCalledWith({
      id: ID,
      selector: {
        provider: "anthropic",
        kind: "claude-subscription-home-v1",
        scope: "account",
        owner_account_id: ACCOUNT_ID,
      },
      key: "claude_pool_excluded",
      value: true,
    });
    await setClaudeSubscriptionInPool({
      account_id: ACCOUNT_ID,
      id: ID,
      in_pool: true,
    });
    expect(setMetadataMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ value: false }),
    );
  });

  it("requires a signed-in account and a boolean", async () => {
    const { setClaudeSubscriptionInPool } = await import("./system");
    await expect(
      setClaudeSubscriptionInPool({ id: ID, in_pool: true }),
    ).rejects.toThrow("must be signed in");
    await expect(
      setClaudeSubscriptionInPool({
        account_id: ACCOUNT_ID,
        id: ID,
        in_pool: "no" as any,
      }),
    ).rejects.toThrow("in_pool must be a boolean");
    expect(setMetadataMock).not.toHaveBeenCalled();
  });
});
