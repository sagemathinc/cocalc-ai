/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";

import getPool from "@cocalc/database/pool";
import {
  ensureClusterAccountDirectorySchema,
  updateClusterAccountEmailAddressDirect,
} from "@cocalc/server/accounts/cluster-directory";
import { after, before } from "@cocalc/server/test";

import { createResetLocal, redeemResetLocal } from "./password-reset";

beforeAll(async () => {
  await before({ noConat: true });
  await ensureClusterAccountDirectorySchema();
}, 60_000);
afterAll(after);

async function createAccount(account_id: string, email_address: string) {
  await getPool().query(
    `INSERT INTO accounts (account_id,email_address)
     VALUES ($1,$2)`,
    [account_id, email_address],
  );
  await updateClusterAccountEmailAddressDirect({ account_id, email_address });
}

it("binds a reset token to its original account and identity generation", async () => {
  const victim = randomUUID();
  const attacker = randomUUID();
  const original = `${randomUUID()}@example.test`;
  const replacement = `${randomUUID()}@example.test`;
  await createAccount(victim, original);

  const token = await createResetLocal(original, "192.0.2.40", 3600);
  await updateClusterAccountEmailAddressDirect({
    account_id: victim,
    email_address: replacement,
  });
  await getPool().query(
    `UPDATE accounts SET email_address=$2 WHERE account_id=$1`,
    [victim, replacement],
  );
  await createAccount(attacker, original);

  await expect(redeemResetLocal(token)).rejects.toThrow(
    "Password reset no longer valid.",
  );
  await expect(
    getPool().query(`SELECT account_id FROM password_reset WHERE id=$1`, [
      token,
    ]),
  ).resolves.toMatchObject({ rows: [{ account_id: victim }] });
});

it("fails closed for an existing reset token without an identity binding", async () => {
  const account_id = randomUUID();
  const email_address = `${randomUUID()}@example.test`;
  await createAccount(account_id, email_address);
  const token = randomUUID();
  await getPool().query(
    `INSERT INTO password_reset (id,email_address,expire)
     VALUES ($1,$2,NOW() + INTERVAL '1 hour')`,
    [token, email_address],
  );

  await expect(redeemResetLocal(token)).rejects.toThrow(
    "Password reset no longer valid.",
  );
});
