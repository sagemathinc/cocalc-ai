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
import {
  getFinancialApprovalIdentityDirect,
  updateClusterAccountEmailAddressDirect,
  updateClusterAccountEmailAddressVerifiedDirect,
} from "@cocalc/server/accounts/cluster-directory";

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
    "INSERT INTO accounts (account_id,email_address,home_bay_id) VALUES ($1,$2,'attached-bay')",
    [account_id, `${account_id}@example.test`],
  );
  await getPool().query(
    "INSERT INTO financial_approval_identities (account_id,email_address,generation) VALUES ($1,$2,1)",
    [account_id, `${account_id}@example.test`],
  );
  const issued = await issueFundingApprovalSession({
    auth: {
      state: "ready",
      account_id,
      email_address: `${account_id}@example.test`,
      identity_generation: 1,
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

it("invalidates pending and issued approval across an email change away and back", async () => {
  const account_id = randomUUID();
  const intent_id = randomUUID();
  const origin = "https://approve.example.test";
  const original = `${account_id}@example.test`;
  const replacement = `new-${account_id}@example.test`;
  await getPool().query(
    "INSERT INTO accounts (account_id,email_address,home_bay_id) VALUES ($1,$2,'attached-bay')",
    [account_id, original],
  );
  await updateClusterAccountEmailAddressDirect({
    account_id,
    email_address: original,
  });
  const identity = await getFinancialApprovalIdentityDirect({
    account_id,
    email_address: original,
  });
  const auth = {
    state: "ready" as const,
    account_id,
    email_address: original,
    identity_generation: identity.generation,
    primary_auth_method: "email_code" as const,
    primary_verified_at: new Date().toISOString(),
    factor_level: "none" as const,
  };
  const issued = await issueFundingApprovalSession({ auth, intent_id, origin });

  await updateClusterAccountEmailAddressDirect({
    account_id,
    email_address: replacement,
  });
  await expect(
    updateClusterAccountEmailAddressVerifiedDirect({
      account_id,
      email_address: original,
      email_address_verified: true,
    }),
  ).rejects.toThrow(`account ${account_id} not found`);
  await updateClusterAccountEmailAddressDirect({
    account_id,
    email_address: original,
  });

  await expect(
    issueFundingApprovalSession({ auth, intent_id: randomUUID(), origin }),
  ).rejects.toThrow("identity changed");
  await expect(
    requireFundingApprovalSession({
      session_hash: fundingSessionHash(issued.token),
      payer_account_id: account_id,
      intent_id,
      origin,
    }),
  ).rejects.toThrow("Financial sign-in required");
  await expect(
    getFinancialApprovalIdentityDirect({
      account_id,
      email_address: original,
    }),
  ).resolves.toMatchObject({ generation: identity.generation + 2 });
});
