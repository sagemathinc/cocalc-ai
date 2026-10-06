import userIsInGroup from "./is-in-group";
import getPool, { type PoolClient } from "@cocalc/database/pool";
import { isMultiBayCluster } from "@cocalc/server/cluster-config";
import { forgetAccountHomeOn409, resolveAccountHome } from "./home-bay";

export default async function isAdmin(
  account_id?: string,
  client?: PoolClient,
): Promise<boolean> {
  if (!account_id) {
    throw Error("invalid account");
  }
  if (!isMultiBayCluster()) {
    return await userIsInGroup(account_id, "admin", client);
  }
  // Admin status is account-home state: answer from the local row only when
  // the account is homed here, otherwise ask its home bay.
  const home = await resolveAccountHome(account_id, client);
  if (home.kind === "absent") return false;
  if (home.kind === "here") {
    const { rows } = await (client ?? getPool("long")).query<{
      groups: string[] | null;
    }>(
      "SELECT groups FROM accounts WHERE account_id=$1 AND deleted IS NOT TRUE",
      [account_id],
    );
    return !!rows[0]?.groups?.includes("admin");
  }
  const { createInterBayAccountFactsClient } =
    await import("@cocalc/conat/inter-bay/account-facts");
  const { getInterBayFabricClient } =
    await import("@cocalc/server/inter-bay/fabric");
  try {
    return (
      (await createInterBayAccountFactsClient({
        client: getInterBayFabricClient(),
        bay_id: home.bay_id,
      }).isAdmin({ account_id })) === true
    );
  } catch (err) {
    return forgetAccountHomeOn409(account_id, err);
  }
}

export async function getAdmins(): Promise<Set<string>> {
  const pool = getPool("long");
  const { rows } = await pool.query(
    "SELECT account_id FROM accounts WHERE 'admin' = ANY(groups)",
  );
  return new Set(rows.map((x) => x.account_id));
}
