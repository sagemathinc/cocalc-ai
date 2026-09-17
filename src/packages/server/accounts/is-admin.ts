import userIsInGroup from "./is-in-group";
import getPool, { type PoolClient } from "@cocalc/database/pool";

export default async function isAdmin(
  account_id?: string,
  client?: PoolClient,
): Promise<boolean> {
  if (!account_id) {
    throw Error("invalid account");
  }
  return await userIsInGroup(account_id, "admin", client);
}

export async function getAdmins(): Promise<Set<string>> {
  const pool = getPool("long");
  const { rows } = await pool.query(
    "SELECT account_id FROM accounts WHERE 'admin' = ANY(groups)",
  );
  return new Set(rows.map((x) => x.account_id));
}
