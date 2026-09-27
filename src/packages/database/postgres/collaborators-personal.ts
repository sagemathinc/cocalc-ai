/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import getPool from "@cocalc/database/pool";
import { collaborationAgentPersonalResource } from "./collaborators-agent-personal";
import type { PoolClient } from "@cocalc/database/pool";
import { withAccountRehomeWriteFence } from "./account-rehome-fence";
import { entryKey, hash, MAX_ARTIFACT_ENTRY_IDS } from "./collaborators-common";
import type { CollaborationOwnedResource } from "@cocalc/conat/inter-bay/collaborators";
import { PERSONAL_LIBRARY_MAX_PINS } from "@cocalc/util/personal-library";
import type {
  CollaborationPersonalState,
  CollaborationResource,
} from "@cocalc/util/collaborators";

// Existing web/native account preference; do not create a second pin registry.
export const AGENT_ORGANIZATION_SETTING =
  "experimental_my_agents_organization_v1";
export const RETAIN_PERSONAL_CHOICE = `(COALESCE(alias,'')<>'' OR collected OR following OR muted
  OR following_explicit OR muted_explicit OR attention_generation IS NULL)`;

/** Baseline-only rows are rebuildable; explicit choices survive disappearance. */
export async function pruneCollaborationAttentionBaselines(
  db: Pick<PoolClient, "query">,
  account_id: string,
  project_id: string,
) {
  await db.query(
    `DELETE FROM collaboration_personal s WHERE account_id=$1 AND project_id=$2
    AND NOT ${RETAIN_PERSONAL_CHOICE}
    AND NOT EXISTS(SELECT 1 FROM collaboration_index r WHERE r.account_id=s.account_id AND r.entry_key=s.entry_key)`,
    [account_id, project_id],
  );
}
export function agentPinnedIds(value: unknown): string[] {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  const values = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.entries(value)
          .filter(([key]) => /^\d+$/.test(key))
          .sort(([a], [b]) => Number(a) - Number(b))
          .map(([, id]) => id)
      : [];
  return [
    ...new Set(values.filter((id): id is string => typeof id === "string")),
  ].slice(0, 500);
}
export async function collaborationAgentPins(account_id: string) {
  const row = (
    await getPool().query(
      "SELECT other_settings->$2 AS organization FROM accounts WHERE account_id=$1",
      [account_id, AGENT_ORGANIZATION_SETTING],
    )
  ).rows[0];
  return agentPinnedIds(row?.organization?.pinned);
}
export function collaborationArtifactPin(resource: CollaborationResource) {
  return JSON.stringify([
    resource.project_id,
    resource.chat_path,
    resource.thread_id,
    resource.artifact_id,
  ]);
}
/** Keep only Library-backed identity bindings, not a second alias/pin registry.
 * Capture before dropping an index generation so rename + rejoin still preserves
 * existing Library names. Library's existing quotas bound this table per account.
 */
export async function rememberCollaborationArtifactBindings(
  db: Pick<PoolClient, "query">,
  account_id: string,
  project_id: string,
) {
  await db.query(
    `DELETE FROM collaboration_artifact_bindings b WHERE b.account_id=$1 AND b.project_id=$2
    AND NOT EXISTS(SELECT 1 FROM personal_library_aliases a WHERE a.account_id=b.account_id AND a.project_id=b.project_id AND a.entry_id=b.entry_id)
    AND NOT EXISTS(SELECT 1 FROM personal_library_pins p WHERE p.account_id=b.account_id AND p.pin_key=b.pin_key)`,
    [account_id, project_id],
  );
  await db.query(
    `INSERT INTO collaboration_artifact_bindings(account_id,entry_key,project_id,entry_id,pin_key)
    SELECT r.account_id,r.entry_key,r.project_id,r.metadata->>'entry_id',
      '[' || to_json(r.project_id::text)::text || ',' || to_json(r.metadata->>'chat_path')::text || ',' || to_json(r.metadata->>'thread_id')::text || ',' || to_json(r.metadata->>'artifact_id')::text || ']'
    FROM collaboration_index r WHERE r.account_id=$1 AND r.project_id=$2 AND r.kind='artifact' AND r.metadata->>'entry_id' IS NOT NULL
    AND (EXISTS(SELECT 1 FROM personal_library_aliases a WHERE a.account_id=r.account_id AND a.project_id=r.project_id AND a.entry_id=r.metadata->>'entry_id')
      OR EXISTS(SELECT 1 FROM personal_library_pins p WHERE p.account_id=r.account_id AND p.pin_key::jsonb=jsonb_build_array(r.project_id,r.metadata->>'chat_path',r.metadata->>'thread_id',r.metadata->>'artifact_id')))
    ON CONFLICT(account_id,entry_key) DO UPDATE SET entry_id=excluded.entry_id,pin_key=excluded.pin_key`,
    [account_id, project_id],
  );
}
export async function moveCollaborationArtifactPersonalState(
  db: Pick<PoolClient, "query">,
  account_id: string,
  resource: CollaborationOwnedResource,
  entry_key: string,
) {
  if (
    resource.kind !== "artifact" ||
    !resource.entry_id ||
    !resource.artifact_id
  )
    return;
  const predecessors = resource.artifact_entry_ids ?? [];
  if (
    !Array.isArray(predecessors) ||
    predecessors.length > MAX_ARTIFACT_ENTRY_IDS ||
    predecessors.some(
      (id) => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id),
    )
  )
    throw Error("invalid artifact relocation history");
  // Share the native Library edit lock, not a competing personal-state namespace.
  const lock = await db.query(
    "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired",
    [`personal-library:${account_id}`],
  );
  if (!lock.rows[0].acquired)
    throw Error("Personal library is busy; retry the change");
  const old = (
    await db.query(
      "SELECT entry_id,pin_key FROM collaboration_artifact_bindings WHERE account_id=$1 AND entry_key=$2 AND project_id=$3 FOR UPDATE",
      [account_id, entry_key, resource.project_id],
    )
  ).rows[0];
  if (!old && !predecessors.length) return;
  const key = collaborationArtifactPin(resource);
  const oldEntries = [
    ...new Set<string>([...predecessors, ...(old ? [old.entry_id] : [])]),
  ].filter((id) => id !== resource.entry_id);
  if (oldEntries.length) {
    // A deliberate name already assigned at the current locator wins. Retain
    // every historic alias binding, but only one may remain active at a target.
    await db.query(
      `WITH ranked AS (SELECT name,row_number() OVER(
        ORDER BY (entry_id=$4) DESC,created_at DESC,name) AS position
        FROM personal_library_aliases WHERE account_id=$1 AND project_id=$2
        AND entry_id=ANY($3::text[]) AND active)
      UPDATE personal_library_aliases a SET active=FALSE FROM ranked r
      WHERE a.account_id=$1 AND a.name=r.name AND r.position>1`,
      [
        account_id,
        resource.project_id,
        [...oldEntries, resource.entry_id],
        resource.entry_id,
      ],
    );
    await db.query(
      "UPDATE personal_library_aliases SET entry_id=$4 WHERE account_id=$1 AND project_id=$2 AND entry_id=ANY($3::text[])",
      [account_id, resource.project_id, oldEntries, resource.entry_id],
    );
  }
  const pins = (
    await db.query(
      "SELECT pin_key FROM personal_library_pins WHERE account_id=$1 ORDER BY rank,pin_key LIMIT $2",
      [account_id, PERSONAL_LIBRARY_MAX_PINS + 1],
    )
  ).rows;
  if (pins.length > PERSONAL_LIBRARY_MAX_PINS)
    throw Error("Personal library pin limit exceeded");
  const historical = new Set(oldEntries);
  for (const pin of pins) {
    if (
      pin.pin_key === key ||
      (!historical.has(hash(pin.pin_key)) && pin.pin_key !== old?.pin_key)
    )
      continue;
    await db.query(
      "DELETE FROM personal_library_pins WHERE account_id=$1 AND pin_key=$2 AND EXISTS(SELECT 1 FROM personal_library_pins WHERE account_id=$1 AND pin_key=$3)",
      [account_id, pin.pin_key, key],
    );
    await db.query(
      "UPDATE personal_library_pins SET pin_key=$3 WHERE account_id=$1 AND pin_key=$2",
      [account_id, pin.pin_key, key],
    );
  }
  await db.query(
    "UPDATE collaboration_artifact_bindings SET entry_id=$3,pin_key=$4 WHERE account_id=$1 AND entry_key=$2",
    [account_id, entry_key, resource.entry_id, key],
  );
}

/** Metadata-only owner lookup can precede this account's first projection. */
export async function reconcileCollaborationArtifactPersonalState(
  account_id: string,
  resources: CollaborationOwnedResource[],
) {
  const moved = resources.filter(
    (r) => r.kind === "artifact" && r.artifact_entry_ids?.length,
  );
  if (!moved.length) return;
  await withAccountRehomeWriteFence({
    account_id,
    action: "reconcile collaboration Library locators",
    fn: async (db) => {
      for (const resource of moved)
        await moveCollaborationArtifactPersonalState(
          db,
          account_id,
          resource,
          entryKey(resource),
        );
    },
  });
}
export const LEGACY_PERSONAL_JOINS = `
  LEFT JOIN agent_personal_names an ON r.kind='agent' AND an.account_id=r.account_id
    AND an.project_id=r.project_id AND an.agent_id::text=r.metadata->>'agent_id' AND an.retired_at IS NULL
  LEFT JOIN personal_library_aliases la ON r.kind='artifact' AND la.account_id=r.account_id
    AND la.project_id=r.project_id AND la.entry_id=r.metadata->>'entry_id' AND la.active
  LEFT JOIN personal_library_pins lp ON r.kind='artifact' AND lp.account_id=r.account_id
    AND lp.pin_key=('[' || to_json(r.project_id::text)::text || ',' || to_json(r.metadata->>'chat_path')::text
      || ',' || to_json(r.metadata->>'thread_id')::text || ',' || to_json(r.metadata->>'artifact_id')::text || ']')`;
export const EFFECTIVE_ALIAS =
  "CASE r.kind WHEN 'agent' THEN COALESCE(an.name,s.alias) WHEN 'artifact' THEN la.name ELSE s.alias END";
export function effectiveCollected(pinsParameter: string) {
  return `CASE r.kind WHEN 'agent' THEN (COALESCE(r.metadata->>'agent_id'=ANY(${pinsParameter}::text[]),FALSE) OR COALESCE(s.collected,FALSE)) WHEN 'artifact' THEN lp.pin_key IS NOT NULL ELSE s.collected END`;
}

export async function legacyCollaborationPersonalState(
  account_id: string,
  resource: CollaborationOwnedResource,
  base: CollaborationPersonalState,
): Promise<CollaborationPersonalState> {
  await reconcileCollaborationArtifactPersonalState(account_id, [resource]);
  if (
    resource.kind === "conversation" ||
    (resource.kind === "agent" && !resource.agent_id)
  )
    return base;
  const state = { ...base, alias: undefined, collected: false };
  if (resource.kind === "agent" && resource.agent_id) {
    state.alias =
      (
        await getPool().query(
          "SELECT name FROM agent_personal_names WHERE account_id=$1 AND project_id=$2 AND agent_id::text=$3 AND retired_at IS NULL",
          [account_id, resource.project_id, resource.agent_id],
        )
      ).rows[0]?.name ?? base.alias;
    state.collected =
      base.collected ||
      (await collaborationAgentPins(account_id)).includes(resource.agent_id);
  } else if (resource.kind === "artifact") {
    state.alias = (
      await getPool().query(
        "SELECT name FROM personal_library_aliases WHERE account_id=$1 AND project_id=$2 AND entry_id=$3 AND active",
        [account_id, resource.project_id, resource.entry_id ?? ""],
      )
    ).rows[0]?.name;
    state.collected =
      (
        await getPool().query(
          "SELECT 1 FROM personal_library_pins WHERE account_id=$1 AND pin_key=$2",
          [account_id, collaborationArtifactPin(resource)],
        )
      ).rows.length > 0;
  }
  return state;
}

/** An explicit endpoint edit supersedes only the matching unnamed-thread fallback. */
export async function clearCollaborationAgentFallback(
  account_id: string,
  resource: CollaborationResource,
  fields: { alias: boolean; collected: boolean },
) {
  return withAccountRehomeWriteFence({
    account_id,
    action: "replace unnamed agent personal state",
    fn: async (db) => {
      const key = entryKey(collaborationAgentPersonalResource(resource));
      await db.query(
        `UPDATE collaboration_personal SET alias=CASE WHEN $3 THEN NULL ELSE alias END,
      collected=CASE WHEN $4 THEN FALSE ELSE collected END WHERE account_id=$1 AND entry_key=$2`,
        [account_id, key, fields.alias, fields.collected],
      );
      if (fields.alias)
        await db.query(
          "UPDATE collaboration_index SET search_text=metadata->>'title' WHERE account_id=$1 AND entry_key=$2",
          [account_id, key],
        );
    },
  });
}
