/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let queryMock: jest.Mock;
let assertAccountWriteOnHomeBayMock: jest.Mock;

jest.mock("@cocalc/server/accounts/rehome-fence", () => ({
  assertAccountWriteOnHomeBay: (...args: any[]) =>
    assertAccountWriteOnHomeBayMock(...args),
  withAccountRehomeWriteFence: async ({ fn }: { fn: Function }) =>
    await fn({ query: (...args: any[]) => queryMock(...args) }),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: (...args: any[]) => queryMock(...args) }),
}));

describe("auth session ownership writes", () => {
  const account_id = "00000000-1000-4000-8000-000000000001";
  const session_hash = "session-hash";

  beforeEach(() => {
    queryMock = jest.fn(async () => ({ rows: [], rowCount: 1 }));
    assertAccountWriteOnHomeBayMock = jest.fn(async () => undefined);
  });

  it("scopes fresh-auth promotion to the owning account", async () => {
    const { setSessionFreshAuth } = await import("./auth-sessions");

    await setSessionFreshAuth({
      account_id,
      session_hash,
      factor_level: "totp",
      fresh_auth_until: new Date("2099-06-21T00:15:00.000Z"),
    });

    const update = queryMock.mock.calls.find(([sql]) =>
      `${sql}`.includes("UPDATE account_auth_sessions"),
    );
    expect(update?.[0]).toContain("AND account_id = $5::UUID");
    expect(update?.[0]).toContain("AND revoked_at IS NULL");
    expect(update?.[0]).toContain("AND expire > NOW()");
    expect(update?.[0]).not.toContain("revoked_at = NULL");
    expect(update?.[0]).not.toMatch(/,\s*WHERE/i);
    expect(update?.[1][4]).toBe(account_id);
  });

  it("rejects fresh-auth promotion when the session is not owned by the account", async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const { setSessionFreshAuth } = await import("./auth-sessions");

    await expect(
      setSessionFreshAuth({
        account_id,
        session_hash,
        factor_level: "totp",
        fresh_auth_until: new Date("2099-06-21T00:15:00.000Z"),
      }),
    ).rejects.toThrow("current browser session not found");
  });

  it("scopes single-session revocation to the owning account", async () => {
    const { revokeAuthSession } = await import("./auth-sessions");

    await revokeAuthSession({ account_id, session_hash });

    const update = queryMock.mock.calls.find(([sql]) =>
      `${sql}`.includes("UPDATE account_auth_sessions"),
    );
    expect(update?.[0]).toContain("AND account_id = $2::UUID");
    expect(update?.[1]).toEqual([session_hash, account_id]);
  });
});
