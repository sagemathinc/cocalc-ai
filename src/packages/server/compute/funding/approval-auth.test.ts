/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import {
  getAuthSession,
  requireFreshAuthForSessionHash,
  recordNewAuthSession,
} from "@cocalc/server/auth/auth-sessions";
import {
  fundingSessionHash,
  issueFundingApprovalSession,
  requireFundingApprovalSession,
} from "./approval-auth";

jest.mock("@cocalc/server/auth/auth-sessions", () => ({
  getAuthSession: jest.fn(),
  requireFreshAuthForSessionHash: jest.fn(),
  recordNewAuthSession: jest.fn(),
}));
jest.mock("@cocalc/server/inter-bay/accounts", () => ({}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-0",
}));

const account_id = randomUUID();
const intent_id = randomUUID();
const origin = "http://127.0.0.2:19200";
beforeEach(() => {
  jest.clearAllMocks();
});
it("binds the reusable independently verified session to origin and payer", async () => {
  const now = new Date().toISOString();
  const result = await issueFundingApprovalSession({
    auth: {
      state: "ready",
      account_id,
      primary_auth_method: "email_code",
      primary_verified_at: now,
      factor_level: "passkey",
      factor_verified_at: now,
    },
    intent_id,
    origin,
  });
  expect(recordNewAuthSession).toHaveBeenCalledWith(
    expect.objectContaining({
      session_hash: fundingSessionHash(result.token),
      account_id,
      primary_auth_method: "email_code",
      factor_level: "passkey",
      metadata: {
        financial_approval_origin: origin,
        financial_approval_scope: "account",
        authenticated_for_intent_id: intent_id,
      },
    }),
  );
  const created = (recordNewAuthSession as jest.Mock).mock.calls[0][0];
  const lifetime = created.fresh_auth_until.getTime() - Date.now();
  expect(lifetime).toBeGreaterThan(7.9 * 60 * 60_000);
  expect(lifetime).toBeLessThanOrEqual(8 * 60 * 60_000);
});
it("accepts the reusable approval session for another exact intent", async () => {
  (getAuthSession as jest.Mock).mockResolvedValue({
    account_id,
    metadata: {
      financial_approval_origin: origin,
      financial_approval_scope: "account",
    },
  });
  await expect(
    requireFundingApprovalSession({
      session_hash: "hash",
      payer_account_id: account_id,
      intent_id: randomUUID(),
      origin,
    }),
  ).resolves.toBe(account_id);
});
it("rejects ordinary, wrong-intent and wrong-origin sessions", async () => {
  for (const metadata of [
    {},
    { financial_approval_origin: origin, financial_intent_id: randomUUID() },
    {
      financial_approval_origin: "http://localhost:9100",
      financial_intent_id: intent_id,
    },
  ]) {
    (getAuthSession as jest.Mock).mockResolvedValue({ account_id, metadata });
    await expect(
      requireFundingApprovalSession({
        session_hash: "hash",
        payer_account_id: account_id,
        intent_id,
        origin,
      }),
    ).rejects.toThrow("Financial sign-in");
  }
  expect(requireFreshAuthForSessionHash).not.toHaveBeenCalled();
});
it("uses existing fresh-auth expiry/revocation verification without impersonation", async () => {
  (getAuthSession as jest.Mock).mockResolvedValue({
    account_id,
    metadata: {
      financial_approval_origin: origin,
      financial_intent_id: intent_id,
    },
  });
  (requireFreshAuthForSessionHash as jest.Mock).mockRejectedValue(
    new Error("expired"),
  );
  await expect(
    requireFundingApprovalSession({
      session_hash: "hash",
      payer_account_id: account_id,
      intent_id,
      origin,
    }),
  ).rejects.toThrow("expired");
  expect(requireFreshAuthForSessionHash).toHaveBeenCalledWith({
    session_hash: "hash",
    account_id,
    allow_actor_impersonation: false,
  });
});

it("rechecks expiry and revocation under a database lock before committing", async () => {
  const query = jest.fn().mockResolvedValue({ rows: [] });
  await expect(
    requireFundingApprovalSession({
      session_hash: "hash",
      payer_account_id: account_id,
      intent_id,
      origin,
      db: { query },
    }),
  ).rejects.toThrow("Financial sign-in required");
  expect(query).toHaveBeenCalledWith(
    expect.stringMatching(
      /revoked_at IS NULL[\s\S]*fresh_auth_until > clock_timestamp\(\)[\s\S]*FOR SHARE/,
    ),
    ["hash"],
  );
});
