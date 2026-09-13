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
import { verifyLocalSignInPassword } from "@cocalc/server/auth/verify-sign-in-password";
import { verifyFreshAuthCredentials } from "@cocalc/server/auth/two-factor";
import {
  fundingSessionHash,
  requireFundingApprovalSession,
  signInFundingApprover,
} from "./approval-auth";

jest.mock("@cocalc/server/auth/auth-sessions", () => ({
  getAuthSession: jest.fn(),
  requireFreshAuthForSessionHash: jest.fn(),
  recordNewAuthSession: jest.fn(),
}));
jest.mock("@cocalc/server/auth/verify-sign-in-password", () => ({
  verifyLocalSignInPassword: jest.fn(),
}));
jest.mock("@cocalc/server/auth/two-factor", () => ({
  verifyFreshAuthCredentials: jest.fn(),
}));
jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountById: async () => ({ home_bay_id: "bay-0" }),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-0",
}));

const account_id = randomUUID();
const intent_id = randomUUID();
const origin = "http://127.0.0.2:19200";
beforeEach(() => {
  jest.clearAllMocks();
});
it("binds the independently verified session to origin, payer and intent", async () => {
  (verifyLocalSignInPassword as jest.Mock).mockResolvedValue({ account_id });
  (verifyFreshAuthCredentials as jest.Mock).mockResolvedValue("totp");
  const result = await signInFundingApprover({
    email_address: "payer@example.test",
    password: "password",
    method: "totp",
    code: "123456",
    intent_id,
    origin,
  });
  expect(verifyFreshAuthCredentials).toHaveBeenCalledWith({
    account_id,
    current_password: "password",
    method: "totp",
    code: "123456",
  });
  expect(recordNewAuthSession).toHaveBeenCalledWith(
    expect.objectContaining({
      session_hash: fundingSessionHash(result.token),
      account_id,
      factor_level: "totp",
      metadata: {
        financial_approval_origin: origin,
        financial_intent_id: intent_id,
      },
    }),
  );
});
it("requires the enabled second factor even after successful password authentication", async () => {
  (verifyLocalSignInPassword as jest.Mock).mockResolvedValue({ account_id });
  (verifyFreshAuthCredentials as jest.Mock).mockRejectedValue(
    new Error("second factor required"),
  );
  await expect(
    signInFundingApprover({
      email_address: "payer@example.test",
      password: "password",
      intent_id,
      origin,
    }),
  ).rejects.toThrow("second factor");
  expect(recordNewAuthSession).not.toHaveBeenCalled();
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
