/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { after, before } from "@cocalc/server/test";
import { ensureCourseFundingApprovalSchema } from "./approvals";
import {
  fundingSessionHash,
  issueFundingApprovalSession,
  requireFundingApprovalSession,
} from "./approval-auth";

beforeAll(async () => {
  await before({ noConat: true });
  await ensureCourseFundingApprovalSchema();
}, 60_000);
afterAll(after);

it("issues and validates seed-owned approval sessions for attached-home accounts", async () => {
  const account_id = randomUUID();
  const intent_id = randomUUID();
  const origin = "https://approve.example.test";
  await getPool().query(
    "INSERT INTO accounts (account_id,home_bay_id) VALUES ($1,'attached-bay')",
    [account_id],
  );
  const issued = await issueFundingApprovalSession({
    auth: {
      state: "ready",
      account_id,
      primary_auth_method: "email_code",
      primary_verified_at: new Date().toISOString(),
      factor_level: "passkey",
      factor_verified_at: new Date().toISOString(),
    },
    intent_id,
    origin,
  });
  await expect(
    requireFundingApprovalSession({
      session_hash: fundingSessionHash(issued.token),
      payer_account_id: account_id,
      intent_id,
      origin,
    }),
  ).resolves.toBe(account_id);
  expect(
    (
      await getPool().query(
        "SELECT session_hash FROM financial_approval_sessions WHERE account_id=$1",
        [account_id],
      )
    ).rows[0].session_hash,
  ).toBe(fundingSessionHash(issued.token));
});
