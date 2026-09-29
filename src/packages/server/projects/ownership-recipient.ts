import getPool from "@cocalc/database/pool";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getClusterAccountById } from "@cocalc/server/inter-bay/accounts";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { resolveMembershipForAccount } from "@cocalc/server/membership/resolve";
import { getEffectiveMembershipUsageLimits } from "@cocalc/server/membership/effective-limits";
import { listUsageProjectsForAccount } from "@cocalc/server/membership/project-usage";
import { listConfiguredBaysAuthoritative } from "@cocalc/server/bay-directory";
import type { OwnershipRecipientRequest } from "@cocalc/conat/inter-bay/api";

export async function getOwnershipUsageCountLocal(account_id: string) {
  return (
    await listUsageProjectsForAccount(
      account_id,
      undefined,
      getConfiguredBayId(),
    )
  ).length;
}

// Account state and membership policy must be checked at the recipient's home.
export async function assertOwnershipRecipientLocal(
  opts: OwnershipRecipientRequest,
) {
  const { account_id } = opts;
  const { rows } = await getPool().query<{
    deleted: boolean | null;
    banned: boolean | null;
    home_bay_id: string | null;
  }>("SELECT deleted, banned, home_bay_id FROM accounts WHERE account_id=$1", [
    account_id,
  ]);
  const row = rows[0];
  if (!row || row.deleted || row.banned) {
    throw new Error(
      "ownership recipient must be an active, non-banned account",
    );
  }
  if ((row.home_bay_id ?? getConfiguredBayId()) !== getConfiguredBayId()) {
    throw new Error("recipient account home changed; refresh and retry");
  }
  if (
    opts.resulting_usage_account_id !== account_id ||
    opts.current_usage_account_id === account_id
  )
    return;
  const { max_projects } = getEffectiveMembershipUsageLimits(
    await resolveMembershipForAccount(account_id),
  );
  if (max_projects == null) return;
  // Query authoritative project owners, not eventually consistent projections
  // or only the recipient's home DB. Any unavailable bay fails this preflight.
  const bays = new Set(
    (await listConfiguredBaysAuthoritative()).map((bay) => bay.bay_id),
  );
  bays.add(getConfiguredBayId());
  let count = 0;
  for (const bay of bays) {
    count +=
      bay === getConfiguredBayId()
        ? await getOwnershipUsageCountLocal(account_id)
        : await createInterBayAccountLocalClient({
            client: getInterBayFabricClient(),
            dest_bay: bay,
          }).getOwnershipUsageCount({ account_id });
  }
  if (count >= max_projects)
    throw new Error(
      `project limit reached (${count}/${max_projects}); recipient must free a project slot or upgrade membership`,
    );
}

export async function assertOwnershipRecipient(
  opts: OwnershipRecipientRequest,
) {
  const { account_id } = opts;
  const account = await getClusterAccountById(account_id);
  if (!account) throw new Error("ownership recipient account not found");
  const home = account.home_bay_id ?? getConfiguredBayId();
  if (home === getConfiguredBayId()) {
    await assertOwnershipRecipientLocal(opts);
  } else {
    await createInterBayAccountLocalClient({
      client: getInterBayFabricClient(),
      dest_bay: home,
    }).assertOwnershipRecipient(opts);
  }
}
