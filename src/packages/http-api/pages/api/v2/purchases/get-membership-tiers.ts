/*
Return membership tier configuration for the store UI.
*/

import { getMembershipTiers } from "@cocalc/server/membership/tiers";
import { buildMembershipTierPresentation } from "@cocalc/util/membership-tier-presentation";

export default async function handle(_req, res) {
  try {
    res.json(await get());
  } catch (err) {
    res.json({ error: `${err.message}` });
    return;
  }
}

async function get() {
  const tiers = await getMembershipTiers({ includeDisabled: true });
  return {
    tiers: tiers.map((tier) => ({
      ...tier,
      presentation: buildMembershipTierPresentation(tier),
    })),
  };
}
