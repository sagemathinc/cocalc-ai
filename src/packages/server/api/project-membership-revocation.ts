/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { withProjectRehomeWriteFence } from "@cocalc/database/postgres/project-rehome-fence";
import { isValidUUID } from "@cocalc/util/misc";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveProjectBay } from "@cocalc/server/inter-bay/directory";
import { getApiKeyIssuanceWatermark } from "./key-authorization-state";
import { normalizeApiKeyIssuanceSequence } from "./issuance-sequence";

// Generation matching prevents a delayed account-home response from clearing a
// newer loss. No database lock is held while waiting on the account's home bay.
export async function resolveProjectApiKeyRevocation({
  project_id,
  account_id,
  generation,
}: {
  project_id: string;
  account_id: string;
  generation: string;
}): Promise<boolean> {
  if (![project_id, account_id, generation].every(isValidUUID))
    throw Error("invalid project API revocation identity");
  const cutoff = normalizeApiKeyIssuanceSequence(
    await getApiKeyIssuanceWatermark({ account_id }),
  );
  return await withProjectRehomeWriteFence({
    project_id,
    action: "resolve API delegation revocation",
    fn: async (db) => {
      const bay = getConfiguredBayId();
      const owner = await resolveProjectBay(project_id);
      if (owner?.bay_id !== bay) throw Error("project owner changed");
      const { rows } = await db.query(
        `UPDATE projects SET
           api_key_membership_revocations=jsonb_set(
             api_key_membership_revocations,ARRAY[$2::text],
             jsonb_build_object('generation',$3::text,'pending',false,'cutoff',
               GREATEST(COALESCE((api_key_membership_revocations->$2->>'cutoff')::bigint,0),$4::bigint)::text)),
           api_key_membership_pending=EXISTS(
             SELECT 1 FROM jsonb_each(api_key_membership_revocations) AS member
             WHERE member.key<>$2 AND member.value->'pending'='true'::jsonb)
         WHERE project_id=$1 AND deleted IS NOT TRUE
           AND COALESCE(owning_bay_id,$5)=$5
           AND api_key_membership_revocations->$2->>'generation'=$3
           AND api_key_membership_revocations->$2->'pending'='true'::jsonb
         RETURNING project_id`,
        [project_id, account_id, generation, cutoff, bay],
      );
      return rows.length === 1;
    },
  });
}

// null means the authoritative project has no loss for this account. Missing
// or malformed state must not be interpreted as a compatible legacy grant.
export function assertApiKeyMembershipGrant(
  sequence: string,
  barrier: unknown,
): void {
  const issued = BigInt(normalizeApiKeyIssuanceSequence(sequence));
  if (barrier === null) return;
  if (barrier == null || typeof barrier !== "object" || Array.isArray(barrier))
    throw Error("API delegation revocation state unavailable");
  const { generation, pending, cutoff } = barrier as Record<string, unknown>;
  if (
    typeof generation !== "string" ||
    !isValidUUID(generation) ||
    pending !== false
  )
    throw Error("API delegation revoked or pending revalidation");
  if (issued <= BigInt(normalizeApiKeyIssuanceSequence(cutoff)))
    throw Error(
      "API delegation revoked by membership loss; authorize a new grant",
    );
}
