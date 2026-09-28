/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { Pool, PoolClient } from "@cocalc/database/pool";
import {
  assertAccountNotRehoming,
  assertAccountWriteOnHomeBay,
} from "@cocalc/database/postgres/account-rehome-fence";
import { isValidUUID } from "@cocalc/util/misc";

const MAX_SEQUENCE = BigInt("9223372036854775807");

export async function withApiKeyIssuance<T>(
  pool: Pool,
  account_id: string,
  mutate: (client: PoolClient, sequence: string) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sequence = await allocateApiKeyIssuanceSequence(client, account_id);
    const result = await mutate(client, sequence);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Preserve PostgreSQL BIGINT precision across JSON and inter-bay transports.
export function normalizeApiKeyIssuanceSequence(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(value))
    throw Error("invalid API key issuance sequence");
  if (BigInt(value) > MAX_SEQUENCE)
    throw Error("invalid API key issuance sequence");
  return value;
}

/** Caller must hold an open transaction through the associated key mutation.
 * Acquiring the account fence before its row lock matches account rehome.
 */
export async function allocateApiKeyIssuanceSequence(
  client: PoolClient,
  account_id: string,
): Promise<string> {
  if (!isValidUUID(account_id)) throw Error("invalid API key owner");
  await assertAccountNotRehoming({
    db: client,
    account_id,
    action: "issue API key authority",
  });
  await assertAccountWriteOnHomeBay({
    db: client,
    account_id,
    action: "issue API key authority",
  });
  const { rows } = await client.query(
    `UPDATE accounts
     SET api_key_issuance_sequence=COALESCE(api_key_issuance_sequence,0)+1
     WHERE account_id=$1 AND deleted IS NOT TRUE
       AND COALESCE(api_key_issuance_sequence,0)>=0
       AND COALESCE(api_key_issuance_sequence,0)<9223372036854775807
     RETURNING api_key_issuance_sequence::TEXT AS sequence`,
    [account_id],
  );
  if (!rows[0])
    throw Error("API key issuance sequence is unavailable or exhausted");
  return normalizeApiKeyIssuanceSequence(rows[0].sequence);
}
