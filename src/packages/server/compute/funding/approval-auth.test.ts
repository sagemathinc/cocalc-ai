/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import {
  fundingSessionHash,
  issueFundingApprovalSession,
  requireFundingApprovalSession,
} from "./approval-auth";

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("@cocalc/server/inter-bay/accounts", () => ({}));
jest.mock("@cocalc/server/accounts/cluster-directory", () => ({
  getFinancialApprovalIdentityDirect: jest.fn(),
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
it("binds the reusable independently verified session to origin and payer", async () => {
  const query = jest.fn().mockResolvedValue({ rows: [{ account_id }] });
  (getPool as jest.Mock).mockReturnValue({ query });
  const now = new Date().toISOString();
  const result = await issueFundingApprovalSession({
    auth: {
      state: "ready",
      account_id,
      email_address: "payer@example.test",
      identity_generation: 7,
      primary_auth_method: "email_code",
      primary_verified_at: now,
      factor_level: "passkey",
      factor_verified_at: now,
    },
    intent_id,
    origin,
  });
  expect(query).toHaveBeenCalledWith(
    expect.stringContaining("INSERT INTO financial_approval_sessions"),
    expect.arrayContaining([
      fundingSessionHash(result.token),
      account_id,
      origin,
      "email_code",
      "passkey",
      intent_id,
    ]),
  );
  const created = query.mock.calls[0][1];
  const lifetime = created[8].getTime() - Date.now();
  expect(lifetime).toBeGreaterThan(7.9 * 60 * 60_000);
  expect(lifetime).toBeLessThanOrEqual(8 * 60 * 60_000);
  expect(query.mock.calls[0][0]).toContain(
    "WHERE account_id=$2 AND email_address=$10 AND generation=$11",
  );
});
it("does not issue a session after the financial identity changes", async () => {
  const query = jest.fn().mockResolvedValue({ rows: [] });
  (getPool as jest.Mock).mockReturnValue({ query });
  await expect(
    issueFundingApprovalSession({
      auth: {
        state: "ready",
        account_id,
        email_address: "old@example.test",
        identity_generation: 4,
        primary_auth_method: "email_code",
        primary_verified_at: new Date().toISOString(),
        factor_level: "none",
      },
      intent_id,
      origin,
    }),
  ).rejects.toThrow("identity changed");
});
it("accepts the reusable approval session for another exact intent", async () => {
  const query = jest.fn().mockResolvedValue({
    rows: [
      {
        account_id,
        approval_origin: origin,
      },
    ],
  });
  (getPool as jest.Mock).mockReturnValue({ query });
  await expect(
    requireFundingApprovalSession({
      session_hash: "hash",
      payer_account_id: account_id,
      intent_id: randomUUID(),
      origin,
    }),
  ).resolves.toBe(account_id);
});
it("rejects missing, wrong-payer and wrong-origin sessions", async () => {
  for (const session of [
    undefined,
    { account_id: randomUUID(), approval_origin: origin },
    { account_id, approval_origin: "http://localhost:9100" },
  ]) {
    (getPool as jest.Mock).mockReturnValue({
      query: jest.fn().mockResolvedValue({ rows: session ? [session] : [] }),
    });
    await expect(
      requireFundingApprovalSession({
        session_hash: "hash",
        payer_account_id: account_id,
        intent_id,
        origin,
      }),
    ).rejects.toThrow("Financial sign-in");
  }
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
      /JOIN financial_approval_identities[\s\S]*revoked_at IS NULL[\s\S]*expire > clock_timestamp\(\)[\s\S]*FOR SHARE/,
    ),
    ["hash"],
  );
});
