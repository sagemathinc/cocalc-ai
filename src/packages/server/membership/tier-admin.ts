/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { db } from "@cocalc/database";
import {
  deleteMembershipTier as deleteMembershipTier0,
  upsertMembershipTier,
} from "@cocalc/database/postgres/membership-tiers";
import type {
  AdminMembershipTierPayload,
  MembershipClass,
} from "@cocalc/conat/hub/api/purchases";

export async function createMembershipTier({
  tier,
}: {
  tier: AdminMembershipTierPayload;
}): Promise<{ id: MembershipClass }> {
  await upsertMembershipTier(db(), tier, { rejectExisting: true });
  return { id: tier.id };
}

export async function updateMembershipTier({
  tier,
}: {
  tier: AdminMembershipTierPayload;
}): Promise<{ id: MembershipClass }> {
  await upsertMembershipTier(db(), tier, { requireExisting: true });
  return { id: tier.id };
}

export async function importMembershipTiers({
  tiers,
}: {
  tiers: AdminMembershipTierPayload[];
}): Promise<{ ids: MembershipClass[] }> {
  for (const tier of tiers) {
    await upsertMembershipTier(db(), tier);
  }
  return { ids: tiers.map((tier) => tier.id) };
}

export async function deleteMembershipTier({
  id,
}: {
  id: MembershipClass;
}): Promise<{ id: MembershipClass }> {
  await deleteMembershipTier0(db(), id);
  return { id };
}
