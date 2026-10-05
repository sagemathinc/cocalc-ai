import userIsInGroup from "./is-in-group";
import getPool, { type PoolClient } from "@cocalc/database/pool";
import { isMultiBayCluster } from "@cocalc/server/cluster-config";
import { directoryRemoteHomeBay, homedHere } from "./home-bay";

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
  const { rows } = await (client ?? getPool("long")).query<{
    groups: string[] | null;
    home_bay_id: string | null;
  }>("SELECT groups, home_bay_id FROM accounts WHERE account_id=$1", [
    account_id,
  ]);
  const local = rows[0];
  if (local != null && homedHere(local.home_bay_id)) {
    return !!local.groups?.includes("admin");
  }
  const home = await directoryRemoteHomeBay(account_id);
  if (home == null) {
    return !!local?.groups?.includes("admin");
  }
  const { createInterBayAccountFactsClient } =
    await import("@cocalc/conat/inter-bay/account-facts");
  const { getInterBayFabricClient } =
    await import("@cocalc/server/inter-bay/fabric");
  return (
    (await createInterBayAccountFactsClient({
      client: getInterBayFabricClient(),
      bay_id: home,
    }).isAdmin({ account_id })) === true
  );
}

export async function getAdmins(): Promise<Set<string>> {
  const pool = getPool("long");
  const { rows } = await pool.query(
    "SELECT account_id FROM accounts WHERE 'admin' = ANY(groups)",
  );
  return new Set(rows.map((x) => x.account_id));
}
