/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { PoolClient } from "@cocalc/database/pool";
import type { CollaborationOwnedResource } from "@cocalc/conat/inter-bay/collaborators";
import {
  agentReferenceIds,
  canonicalAgentResource,
} from "@cocalc/util/collaboration-agent-identity";
import { withAccountRehomeWriteFence } from "./account-rehome-fence";
import { bumpCollaborationRevision } from "./collaborators-changes";
import { entryKey, uuid, validateResource } from "./collaborators-common";

/** Follow the persisted owner key, not the target echoed for an old authored reference. */
export function collaborationAgentPersonalResource<
  T extends CollaborationOwnedResource,
>(resource: T): T {
  return resource.kind === "agent" && resource.agent_catalog_resource_id
    ? { ...resource, resource_id: resource.agent_catalog_resource_id }
    : canonicalAgentResource(resource);
}

/** Runs at the account home, never from the project owner's catalog transaction. */
export async function moveCollaborationAgentPersonalState(
  db: Pick<PoolClient, "query">,
  account_id: string,
  resource: CollaborationOwnedResource,
) {
  if (
    resource.kind !== "agent" ||
    !resource.agent_id ||
    resource.resource_id.startsWith("copy:") ||
    (resource.agent_catalog_resource_id !== undefined &&
      resource.agent_catalog_resource_id !== resource.agent_id)
  )
    return;
  uuid(resource.agent_id, "registered collaboration agent");
  const canonical = canonicalAgentResource(resource);
  const key = entryKey(canonical);
  const ids = agentReferenceIds(resource.agent_resource_ids ?? []);
  const oldKeys = ids
    .filter((id) => id !== canonical.resource_id)
    .map((resource_id) => entryKey({ ...canonical, resource_id }));
  if (!oldKeys.length) return;
  const { rows } = await db.query(
    `SELECT * FROM collaboration_personal WHERE account_id=$1 AND project_id=$2
    AND entry_key=ANY($3::text[]) ORDER BY (entry_key=$4) DESC,entry_key FOR UPDATE`,
    [account_id, resource.project_id, [...oldKeys, key], key],
  );
  if (!rows.some((row) => row.entry_key !== key)) return false;
  const current = rows.find((row) => row.entry_key === key);
  const choice = (field: "following" | "muted") =>
    rows.find((row) => row[`${field}_explicit`])?.[field] ??
    rows.some((row) => row[field]);
  const max = (field: string) =>
    Math.max(0, ...rows.map((row) => Number(row[field] ?? 0)));
  // Consume old fallback choices once. A later explicit clear/unfollow must not resurrect them.
  await db.query(
    "DELETE FROM collaboration_personal WHERE account_id=$1 AND project_id=$2 AND entry_key=ANY($3::text[])",
    [account_id, resource.project_id, oldKeys],
  );
  await db.query(
    `INSERT INTO collaboration_personal(account_id,entry_key,project_id,alias,collected,following,muted,read_through,
    following_explicit,muted_explicit,notify_after,last_mention,attention_generation,legacy_migrated)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT(account_id,entry_key) DO UPDATE SET alias=excluded.alias,collected=excluded.collected,
    following=excluded.following,muted=excluded.muted,read_through=excluded.read_through,
    following_explicit=excluded.following_explicit,muted_explicit=excluded.muted_explicit,
    notify_after=excluded.notify_after,last_mention=excluded.last_mention,legacy_migrated=excluded.legacy_migrated`,
    [
      account_id,
      key,
      resource.project_id,
      current ? current.alias : (rows.find((row) => row.alias)?.alias ?? null),
      rows.some((row) => row.collected),
      choice("following"),
      choice("muted"),
      max("read_through"),
      rows.some((row) => row.following_explicit),
      rows.some((row) => row.muted_explicit),
      max("notify_after"),
      max("last_mention"),
      current?.attention_generation ?? null,
      rows.some((row) => row.legacy_migrated),
    ],
  );
  // A point lookup can migrate choices before the next projection arrives.
  // Re-key an existing authorized index row so its shortcut never disappears.
  const metadata = validateResource(canonical);
  await db.query(
    `INSERT INTO collaboration_index(account_id,entry_key,project_id,generation,kind,activity,metadata,created_by,participant_ids,search_text)
    SELECT r.account_id,$3,r.project_id,r.generation,'agent',$4,$5::jsonb,$6,$7::uuid[],$8
    FROM collaboration_index r WHERE r.account_id=$1 AND r.project_id=$2 AND r.entry_key=ANY($9::text[])
    ORDER BY r.activity DESC,r.entry_key LIMIT 1 ON CONFLICT(account_id,entry_key) DO NOTHING`,
    [
      account_id,
      resource.project_id,
      key,
      metadata.updated_at,
      JSON.stringify(metadata),
      metadata.created_by ?? null,
      metadata.participant_ids,
      metadata.title,
      oldKeys,
    ],
  );
  await db.query(
    "DELETE FROM collaboration_index WHERE account_id=$1 AND project_id=$2 AND entry_key=ANY($3::text[])",
    [account_id, resource.project_id, oldKeys],
  );
  await db.query(
    `UPDATE collaboration_index r SET search_text=COALESCE(r.metadata->>'title','') || ' ' || COALESCE(p.alias,'')
    FROM collaboration_personal p WHERE r.account_id=$1 AND r.entry_key=$2 AND p.account_id=r.account_id AND p.entry_key=r.entry_key`,
    [account_id, key],
  );
  return true;
}

export async function reconcileCollaborationAgentPersonalState(
  account_id: string,
  resources: readonly CollaborationOwnedResource[],
) {
  const bound = resources.filter(
    (r) => r.kind === "agent" && r.agent_id && r.agent_resource_ids?.length,
  );
  if (!bound.length) return;
  await withAccountRehomeWriteFence({
    account_id,
    action: "reconcile collaboration agent identities",
    fn: async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `collaboration-account:${account_id}`,
      ]);
      const migrated = new Set<string>();
      for (const resource of bound)
        if (await moveCollaborationAgentPersonalState(db, account_id, resource))
          migrated.add(resource.project_id);
      if (migrated.size) {
        // Fence replies fetched before this read-side canonical migration.
        await db.query(
          "UPDATE collaboration_access SET claim_id=NULL,grant_request_id=NULL,claim_until=NULL,due_at=now() WHERE account_id=$1 AND project_id=ANY($2::uuid[])",
          [account_id, [...migrated]],
        );
        await bumpCollaborationRevision(db, account_id);
      }
    },
  });
}
