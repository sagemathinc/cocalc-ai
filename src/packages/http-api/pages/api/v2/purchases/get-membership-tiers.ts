/*
Return membership tier configuration for the store UI.
*/

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import userIsInGroup from "@cocalc/server/accounts/is-in-group";
import { getMembershipTiers } from "@cocalc/server/membership/tiers";
import { buildMembershipTierPresentation } from "@cocalc/util/membership-tier-presentation";

export default async function handle(req, res) {
  try {
    res.json(await get(req));
  } catch (err) {
    res.json({ error: `${err.message}` });
    return;
  }
}

async function get(req) {
  const account_id = await getAccountId(req);
  const isAdmin =
    account_id != null ? await userIsInGroup(account_id, "admin") : false;
  const tiers = await getMembershipTiers({ includeDisabled: isAdmin });
  const visibleTiers =
    account_id != null
      ? tiers
      : tiers.filter(
          (tier) =>
            tier.store_visible ||
            tier.team_visible ||
            tier.course_store_visible,
        );
  return {
    tiers: visibleTiers.map((tier) => ({
      ...tier,
      presentation: buildMembershipTierPresentation(tier),
    })),
  };
}
