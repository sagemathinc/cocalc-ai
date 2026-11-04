/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Account-scoped catalog reads on the project-owning bay. Authorization is
// decided here, in SQL, from this bay's own project rows: never from a
// project list supplied by a caller or another bay.

import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";
import type { CatalogEntry } from "@cocalc/conat/hub/api/artifact-catalog";
import { isValidUUID } from "@cocalc/util/misc";
import { liveOnBay } from "./artifact-catalog";

type Queryable = Pick<PoolClient, "query">;

// Roles that may read a project's artifact catalog (viewers may not).
export const ARTIFACT_CATALOG_READ_GROUPS = ["owner", "collaborator"];
export const ARTIFACT_CATALOG_MAX_ENTRIES_PER_LOOKUP = 100;

// One uniform error for any unauthorized, missing or foreign project, so a
// lookup cannot be used to learn which projects or entries exist.
export const ARTIFACT_CATALOG_NOT_PERMITTED = "not found or not permitted";

const ENTRY_ID = /^[a-f0-9]{64}$/;

/**
 * The projects among `project_ids` that `account_id` may read on this bay:
 * a live project row owned by this bay, with the account an owner or
 * collaborator. The account ban check is the caller's (it is cached state,
 * as in assertActor).
 */
export async function authorizedArtifactCatalogProjects(
  db: Queryable,
  {
    account_id,
    owning_bay_id,
    project_ids,
  }: { account_id: string; owning_bay_id: string; project_ids: string[] },
): Promise<Set<string>> {
  if (!isValidUUID(account_id)) throw Error("invalid account_id");
  if (project_ids.length === 0) return new Set();
  const { rows } = await db.query(
    `SELECT project_id FROM projects
     WHERE project_id = ANY($2::uuid[])
       AND users ? $1
       AND users -> $1 ->> 'group' = ANY($4::text[])
       AND ${liveOnBay("", "$3")}`,
    [account_id, project_ids, owning_bay_id, ARTIFACT_CATALOG_READ_GROUPS],
  );
  return new Set(rows.map((row) => row.project_id as string));
}

export interface CatalogEntryRef {
  project_id: string;
  entry_id: string;
}

function validateEntryRefs(items: unknown): CatalogEntryRef[] {
  if (
    !Array.isArray(items) ||
    items.length < 1 ||
    items.length > ARTIFACT_CATALOG_MAX_ENTRIES_PER_LOOKUP
  )
    throw Error("invalid catalog entry list");
  const seen = new Set<string>();
  const refs: CatalogEntryRef[] = [];
  for (const item of items) {
    const project_id = (item as any)?.project_id;
    const entry_id = (item as any)?.entry_id;
    if (
      typeof project_id !== "string" ||
      !isValidUUID(project_id) ||
      typeof entry_id !== "string" ||
      !ENTRY_ID.test(entry_id)
    )
      throw Error("invalid catalog entry list");
    const key = `${project_id}/${entry_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ project_id, entry_id });
  }
  return refs;
}

/**
 * Point lookups for up to 100 entries (pins, names, the open artifact).
 * Every distinct project is authorized before any entry is read; if any is
 * not readable the whole request fails with one uniform error. Entries that
 * are absent are simply omitted.
 */
export async function readArtifactCatalogEntriesForAccount(
  db: Queryable,
  {
    account_id,
    owning_bay_id,
    items,
  }: { account_id: string; owning_bay_id: string; items: unknown },
): Promise<CatalogEntry[]> {
  const refs = validateEntryRefs(items);
  const projects = [...new Set(refs.map((ref) => ref.project_id))];
  const allowed = await authorizedArtifactCatalogProjects(db, {
    account_id,
    owning_bay_id,
    project_ids: projects,
  });
  if (projects.some((project_id) => !allowed.has(project_id)))
    throw Error(ARTIFACT_CATALOG_NOT_PERMITTED);
  const { rows } = await db.query(
    `SELECT c.project_id,c.entry_id,s.chat_path,c.metadata
     FROM unnest($1::uuid[],$2::text[]) AS r(project_id,entry_id)
     JOIN artifact_catalog c
       ON c.project_id=r.project_id AND c.entry_id=r.entry_id AND NOT c.deleted
     JOIN artifact_catalog_sources s ON s.source_id=c.source_id
     ORDER BY c.project_id,c.entry_id`,
    [refs.map((ref) => ref.project_id), refs.map((ref) => ref.entry_id)],
  );
  return rows.map((row) => ({
    entry_id: row.entry_id,
    project_id: row.project_id,
    chat_path: row.chat_path,
    item: row.metadata,
  }));
}

export async function readArtifactCatalogEntriesForAccountLocal(opts: {
  account_id: string;
  owning_bay_id: string;
  items: unknown;
}): Promise<CatalogEntry[]> {
  return await readArtifactCatalogEntriesForAccount(getPool(), opts);
}
