/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetAccountId = jest.fn();
const mockGetRememberMeHash = jest.fn();
const mockNormalizeContext = jest.fn((value) => value);
const mockStartChallenge = jest.fn();
const mockRegisterAttention = jest.fn();
const mockAttentionEnabled = jest.fn(() => true);

jest.mock("@cocalc/http-api/lib/account/get-account", () => ({
  __esModule: true,
  default: (...args) => mockGetAccountId(...args),
}));
jest.mock("@cocalc/server/auth/remember-me", () => ({
  getRememberMeHash: (...args) => mockGetRememberMeHash(...args),
}));
jest.mock("@cocalc/server/auth/cli-auth", () => ({
  normalizeCodexFreshAuthAttentionContext: (...args) =>
    mockNormalizeContext(...args),
  startCliElevateChallenge: (...args) => mockStartChallenge(...args),
}));
jest.mock("@cocalc/server/auth/codex-attention", () => ({
  codexFreshAuthAttentionEnabled: () => mockAttentionEnabled(),
  registerCodexFreshAuthAttention: (...args) => mockRegisterAttention(...args),
}));

describe("/api/v2/auth/cli/elevate/start Codex attention", () => {
  const account_id = "00000000-1000-4000-8000-000000000001";
  const challenge_id = "00000000-3000-4000-8000-000000000003";
  const context = {
    project_id: "00000000-2000-4000-8000-000000000002",
    path: "agent.chat",
    thread_id: "thread-1",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAccountId.mockResolvedValue(account_id);
    mockGetRememberMeHash.mockReturnValue("session-hash");
    mockStartChallenge.mockResolvedValue({
      challenge_id,
      poll_token: "poll-token",
      approval_url: `https://cocalc.test/auth/cli-elevate/${challenge_id}`,
      expires_at: new Date("2099-09-02T01:00:00.000Z"),
    });
    mockRegisterAttention.mockResolvedValue(undefined);
    mockAttentionEnabled.mockReturnValue(true);
  });

  it("registers a contextual challenge before returning it", async () => {
    const { req, res } = createMocks({
      method: "POST",
      body: { duration: "default", codex_attention_context: context },
    });
    const { default: handler } = await import("./start");
    await handler(req, res);

    expect(mockStartChallenge).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id,
        session_hash: "session-hash",
        codex_attention_context: context,
      }),
    );
    expect(mockRegisterAttention).toHaveBeenCalledWith({
      account_id,
      challenge_id,
      context,
    });
    expect(res._getJSONData()).toMatchObject({
      challenge_id,
      attention_registered: true,
    });
    expect(res._getJSONData()).not.toHaveProperty("approval_url");
  });

  it("keeps ordinary browser elevation unchanged", async () => {
    const { req, res } = createMocks({
      method: "POST",
      body: { duration: "extended" },
    });
    const { default: handler } = await import("./start");
    await handler(req, res);

    expect(mockRegisterAttention).not.toHaveBeenCalled();
    expect(res._getJSONData()).toMatchObject({
      challenge_id,
      approval_url: `https://cocalc.test/auth/cli-elevate/${challenge_id}`,
      attention_registered: false,
    });
  });

  it("rejects contextual elevation before creating a challenge when disabled", async () => {
    mockAttentionEnabled.mockReturnValue(false);
    const { req, res } = createMocks({
      method: "POST",
      body: { duration: "default", codex_attention_context: context },
    });
    const { default: handler } = await import("./start");
    await handler(req, res);

    expect(mockStartChallenge).not.toHaveBeenCalled();
    expect(mockRegisterAttention).not.toHaveBeenCalled();
    expect(res._getJSONData()).toEqual({
      error: "Codex fresh-auth attention is disabled",
    });
  });
});
