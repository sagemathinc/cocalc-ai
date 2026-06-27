/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createHash } from "node:crypto";

let queryMock: jest.Mock;
let withAccountRehomeWriteFenceMock: jest.Mock;
let createClusterCliLoginSessionMock: jest.Mock;
let getClusterAccountByIdMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: (...args: any[]) => queryMock(...args) }),
}));

jest.mock("@cocalc/server/accounts/rehome-fence", () => ({
  withAccountRehomeWriteFence: (...args: any[]) =>
    withAccountRehomeWriteFenceMock(...args),
}));

jest.mock("@cocalc/server/auth/auth-sessions", () => ({
  getCurrentAuthSessionForSessionHash: jest.fn(),
  resolveFreshAuthDurationMs: jest.fn(() => 60_000),
  setSessionFreshAuth: jest.fn(),
}));

jest.mock("@cocalc/server/auth/set-sign-in-cookies", () => ({
  DEFAULT_MAX_AGE_MS: 30 * 24 * 60 * 60 * 1000,
}));

jest.mock("@cocalc/server/auth/two-factor", () => ({
  verifyFreshAuthCredentials: jest.fn(),
}));

jest.mock("@cocalc/server/auth/passkeys", () => ({
  finishFreshAuthPasskeyAuthentication: jest.fn(),
  startFreshAuthPasskeyAuthentication: jest.fn(),
}));

jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  createClusterCliLoginSession: (...args: any[]) =>
    createClusterCliLoginSessionMock(...args),
  getClusterAccountById: (...args: any[]) => getClusterAccountByIdMock(...args),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-0",
}));

jest.mock("@cocalc/server/bay-public-origin", () => ({
  getBayPublicOriginForRequest: jest.fn(async () => "https://cocalc.test"),
}));

jest.mock("@cocalc/backend/base-path", () => "/");

jest.mock("@cocalc/backend/data", () => ({
  conatPassword: "dev-password",
}));

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

describe("CLI auth login redemption", () => {
  const account_id = "00000000-1000-4000-8000-000000000001";
  const challenge_id = "00000000-1000-4000-8000-000000000010";
  const redeem_token = "00000000-1000-4000-8000-000000000099";
  const redeem_token_hash = hashToken(redeem_token);

  beforeEach(() => {
    jest.resetModules();
    queryMock = jest.fn();
    withAccountRehomeWriteFenceMock = jest.fn(
      async ({ fn }) =>
        await fn({ query: (...args: any[]) => queryMock(...args) }),
    );
    createClusterCliLoginSessionMock = jest.fn(async () => ({
      remember_me: "remember-me-cookie",
      session_hash: "session-hash",
      expire: new Date("2099-06-21T00:00:00.000Z"),
    }));
    getClusterAccountByIdMock = jest.fn(async () => ({
      account_id,
      home_bay_id: "bay-1",
      email_address: "user@example.com",
      display_name: "User Example",
      first_name: "User",
      last_name: "Example",
    }));
  });

  function mockApprovedChallenge(rowOverrides: Record<string, unknown> = {}) {
    queryMock.mockImplementation(async (sql) => {
      const text = `${sql}`;
      if (text.includes("SELECT *")) {
        return {
          rows: [
            {
              id: challenge_id,
              account_id,
              kind: "login",
              status: "approved",
              poll_token_hash: hashToken("poll-token"),
              redeem_token_hash,
              expire: new Date("2099-06-22T00:00:00.000Z"),
              created: new Date("2099-06-21T00:00:00.000Z"),
              metadata: { redeem_token },
              ...rowOverrides,
            },
          ],
        };
      }
      if (text.includes("UPDATE account_cli_auth_challenges")) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [] };
    });
  }

  it("creates a cluster CLI session and records the redeemed session hash", async () => {
    mockApprovedChallenge();
    const { redeemCliLoginChallenge } = await import("./cli-auth");

    await expect(
      redeemCliLoginChallenge({
        challenge_id,
        redeem_token,
        ip_address: "192.0.2.10",
        user_agent: "test-agent",
      }),
    ).resolves.toMatchObject({
      account_id,
      remember_me: "remember-me-cookie",
      home_bay_id: "bay-1",
    });

    const update = queryMock.mock.calls.find(([sql]) =>
      `${sql}`.includes("UPDATE account_cli_auth_challenges"),
    );
    expect(update).toBeTruthy();
    expect(update?.[0]).toContain("AND status = 'approved'");
    expect(update?.[0]).toContain("AND redeem_token_hash = $3::CHAR(64)");
    expect(update?.[1][2]).toBe(redeem_token_hash);
    expect(JSON.parse(update?.[1][1])).toEqual({
      redeemed_session_hash: "session-hash",
    });
    expect(createClusterCliLoginSessionMock).toHaveBeenCalledWith({
      account_id,
      approved_challenge_id: challenge_id,
      ip_address: "192.0.2.10",
      user_agent: "test-agent",
    });
  });

  it("surfaces an already redeemed challenge update failure", async () => {
    mockApprovedChallenge();
    queryMock.mockImplementation(async (sql) => {
      const text = `${sql}`;
      if (text.includes("SELECT *")) {
        return {
          rows: [
            {
              id: challenge_id,
              account_id,
              kind: "login",
              status: "approved",
              poll_token_hash: hashToken("poll-token"),
              redeem_token_hash,
              expire: new Date("2099-06-22T00:00:00.000Z"),
              created: new Date("2099-06-21T00:00:00.000Z"),
              metadata: { redeem_token },
            },
          ],
        };
      }
      if (text.includes("UPDATE account_cli_auth_challenges")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [] };
    });
    const { redeemCliLoginChallenge } = await import("./cli-auth");

    await expect(
      redeemCliLoginChallenge({ challenge_id, redeem_token }),
    ).rejects.toThrow("cli auth challenge has already been redeemed");

    expect(createClusterCliLoginSessionMock).toHaveBeenCalledTimes(1);
  });
});
