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
  getBayPublicOrigin: jest.fn(async (bay_id: string) =>
    bay_id === "bay-1" ? "https://bay-1-cocalc.test" : "https://cocalc.test",
  ),
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
      home_bay_url: "https://bay-1-cocalc.test",
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

  it("creates an already-elevated CLI session from an elevated login", async () => {
    mockApprovedChallenge({
      requested_duration: "extended",
      metadata: {
        redeem_token,
        elevated_login: true,
        factor_level: "passkey",
        fresh_auth_until: "2099-06-21T08:00:00.000Z",
      },
    });
    const { redeemCliLoginChallenge } = await import("./cli-auth");

    await expect(
      redeemCliLoginChallenge({ challenge_id, redeem_token }),
    ).resolves.toMatchObject({
      factor_level: "passkey",
      fresh_auth_until: new Date("2099-06-21T08:00:00.000Z"),
    });
    expect(createClusterCliLoginSessionMock).toHaveBeenCalledWith({
      account_id,
      approved_challenge_id: challenge_id,
      factor_level: "passkey",
      fresh_auth_until: new Date("2099-06-21T08:00:00.000Z"),
      ip_address: null,
      user_agent: null,
    });
  });

  it("labels a redeemed mobile challenge as a mobile app session", async () => {
    mockApprovedChallenge({
      metadata: { redeem_token, auth_client: "mobile" },
    });
    const { redeemCliLoginChallenge } = await import("./cli-auth");

    await redeemCliLoginChallenge({ challenge_id, redeem_token });

    expect(createClusterCliLoginSessionMock).toHaveBeenCalledWith({
      account_id,
      approved_challenge_id: challenge_id,
      auth_client: "mobile",
      ip_address: null,
      user_agent: null,
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

describe("CLI elevated login approval", () => {
  const account_id = "00000000-1000-4000-8000-000000000001";
  const challenge_id = "00000000-1000-4000-8000-000000000010";

  beforeEach(() => {
    jest.resetModules();
    withAccountRehomeWriteFenceMock = jest.fn(
      async ({ fn }) =>
        await fn({ query: (...args: any[]) => queryMock(...args) }),
    );
    createClusterCliLoginSessionMock = jest.fn();
    getClusterAccountByIdMock = jest.fn();
  });

  it("persists signed fresh-auth proof on an elevated login challenge", async () => {
    const freshAuthUntil = new Date(Date.now() + 5 * 60_000);
    queryMock = jest.fn(async (sql) => {
      if (`${sql}`.includes("SELECT *")) {
        return {
          rows: [
            {
              id: challenge_id,
              account_id,
              kind: "login",
              status: "pending",
              poll_token_hash: hashToken("poll-token"),
              requested_duration: "default",
              expire: new Date("2099-06-22T00:00:00.000Z"),
              created: new Date("2099-06-21T00:00:00.000Z"),
              metadata: { elevated_login: true },
            },
          ],
        };
      }
      return { rows: [], rowCount: 1 };
    });
    const { approveCliLoginChallenge } = await import("./cli-auth");

    await expect(
      approveCliLoginChallenge({
        challenge_id,
        account_id,
        factor_level: "passkey",
        fresh_auth_until: freshAuthUntil,
      }),
    ).resolves.toEqual({ approved: true });

    const update = queryMock.mock.calls.find(([sql]) =>
      `${sql}`.includes("SET status = 'approved'"),
    );
    expect(update).toBeTruthy();
    expect(JSON.parse(update?.[1][2])).toMatchObject({
      elevated_login: true,
      factor_level: "passkey",
      fresh_auth_until: freshAuthUntil.toISOString(),
    });
  });

  it("rejects elevated approval without fresh-auth proof", async () => {
    queryMock = jest.fn(async (sql) => ({
      rows: `${sql}`.includes("SELECT *")
        ? [
            {
              id: challenge_id,
              account_id,
              kind: "login",
              status: "pending",
              poll_token_hash: hashToken("poll-token"),
              requested_duration: "default",
              expire: new Date("2099-06-22T00:00:00.000Z"),
              created: new Date("2099-06-21T00:00:00.000Z"),
              metadata: { elevated_login: true },
            },
          ]
        : [],
    }));
    const { approveCliLoginChallenge } = await import("./cli-auth");

    await expect(
      approveCliLoginChallenge({ challenge_id, account_id }),
    ).rejects.toThrow("valid factor level");
  });
});

describe("Codex fresh-auth attention status", () => {
  const account_id = "00000000-1000-4000-8000-000000000001";
  const project_id = "00000000-2000-4000-8000-000000000002";
  const challenge_id = "00000000-3000-4000-8000-000000000003";

  beforeEach(() => {
    jest.resetModules();
    queryMock = jest.fn(async () => ({
      rows: [
        {
          id: challenge_id,
          account_id,
          kind: "elevate",
          status: "pending",
          poll_token_hash: hashToken("poll-token"),
          target_session_hash: "session-hash",
          expire: new Date("2099-09-02T01:00:00.000Z"),
          created: new Date("2099-09-02T00:00:00.000Z"),
          metadata: {
            codex_attention_context: {
              project_id,
              path: "agent.chat",
              thread_id: "thread-1",
            },
          },
        },
      ],
    }));
  });

  it("normalizes bounded chat context", async () => {
    const { normalizeCodexFreshAuthAttentionContext } =
      await import("./cli-auth");
    expect(
      normalizeCodexFreshAuthAttentionContext({
        project_id,
        path: " agent.chat ",
        thread_id: " thread-1 ",
        purpose: " host delete ",
      }),
    ).toEqual({
      project_id,
      path: "agent.chat",
      thread_id: "thread-1",
      purpose: "host delete",
    });
    expect(() =>
      normalizeCodexFreshAuthAttentionContext({
        project_id: "not-a-project",
        path: "agent.chat",
        thread_id: "thread-1",
      }),
    ).toThrow("invalid Codex attention project id");
  });

  it("returns status only for the bound account and project", async () => {
    const { getCodexFreshAuthActionStatus } = await import("./cli-auth");
    await expect(
      getCodexFreshAuthActionStatus({
        challenge_id,
        account_id,
        project_id,
      }),
    ).resolves.toMatchObject({ challenge_id, state: "pending" });
    await expect(
      getCodexFreshAuthActionStatus({
        challenge_id,
        account_id: "00000000-4000-4000-8000-000000000004",
        project_id,
      }),
    ).rejects.toThrow("account mismatch");
    await expect(
      getCodexFreshAuthActionStatus({
        challenge_id,
        account_id,
        project_id: "00000000-5000-4000-8000-000000000005",
      }),
    ).rejects.toThrow("project mismatch");
  });

  it("reports expiry and authoritative approval state", async () => {
    const { getCodexFreshAuthActionStatus } = await import("./cli-auth");
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: challenge_id,
          account_id,
          kind: "elevate",
          status: "pending",
          expire: new Date("2000-01-01T00:00:00.000Z"),
          created: new Date("1999-01-01T00:00:00.000Z"),
          metadata: {
            codex_attention_context: {
              project_id,
              path: "agent.chat",
              thread_id: "thread-1",
            },
          },
        },
      ],
    });
    await expect(
      getCodexFreshAuthActionStatus({
        challenge_id,
        account_id,
        project_id,
      }),
    ).resolves.toMatchObject({ state: "expired" });

    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: challenge_id,
          account_id,
          kind: "elevate",
          status: "approved",
          expire: new Date("2099-09-02T01:00:00.000Z"),
          created: new Date("2099-09-02T00:00:00.000Z"),
          metadata: {
            codex_attention_context: {
              project_id,
              path: "agent.chat",
              thread_id: "thread-1",
            },
          },
        },
      ],
    });
    await expect(
      getCodexFreshAuthActionStatus({
        challenge_id,
        account_id,
        project_id,
      }),
    ).resolves.toMatchObject({ state: "approved" });
  });
});
