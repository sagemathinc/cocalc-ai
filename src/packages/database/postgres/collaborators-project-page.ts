/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import getPool from "@cocalc/database/pool";
import type {
  CollaborationPage,
  CollaborationResource,
} from "@cocalc/util/collaborators";
import type {
  CollaborationProjectResourceQuery,
  CollaborationOwnedResource,
} from "@cocalc/conat/inter-bay/collaborators";
import { assertCollaborationAccountAuthority } from "./collaborators-owner";
import {
  collaborationPageQuery,
  collaborationNextCursor,
} from "./collaborators-discovery";
import {
  entryKey,
  PAGE_BYTES,
  transaction,
  uuid,
} from "./collaborators-common";
import {
  collaborationAgentPins,
  EFFECTIVE_ALIAS,
  effectiveCollected,
  LEGACY_PERSONAL_JOINS,
  reconcileCollaborationArtifactPersonalState,
} from "./collaborators-personal";

/** One selected project only. Never fans out or depends on account index capacity. */
export async function readCollaborationProjectPage(
  input: CollaborationProjectResourceQuery,
  authority: { owning_bay_id: string },
): Promise<CollaborationPage<CollaborationOwnedResource>> {
  uuid(input.project_id, "project_id");
  uuid(input.account_id, "account_id");
  if ((input as any).scope && (input as any).scope !== "all")
    throw Error(
      "project fallback supports shared metadata, not personal scopes",
    );
  return transaction(async (db) => {
    await assertCollaborationAccountAuthority(
      db,
      input.project_id,
      input.account_id!,
      authority,
    );
    const state = (
      await db.query(
        "SELECT generation FROM collaboration_projects WHERE project_id=$1",
        [input.project_id],
      )
    ).rows[0];
    const q = collaborationPageQuery(
      input,
      `owner-resources:${state?.generation ?? "empty"}`,
    );
    const values: any[] = [q.project_id];
    const param = (value: any) => {
      values.push(value);
      return `$${values.length}`;
    };
    const where = ["c.project_id=$1", "c.deleted_at IS NULL"];
    if (q.kind) where.push(`c.kind=${param(q.kind)}`);
    if (q.search)
      where.push(
        `to_tsvector('simple',COALESCE(c.metadata->>'title','')) @@ plainto_tsquery('simple',${param(q.search)})`,
      );
    if (q.person_id) {
      const v = param(q.person_id);
      where.push(
        `(c.metadata->>'created_by'=${v} OR c.metadata->'participant_ids' @> jsonb_build_array(${v}::text))`,
      );
    }
    if (!q.include_archived)
      where.push("NOT COALESCE((c.metadata->>'archived')::boolean,FALSE)");
    if (q.after)
      where.push(
        `(c.activity,c.entry_key)<(${param(q.after.order)}::bigint,${param(q.after.key)}::text)`,
      );
    const { rows } = await db.query(
      `SELECT c.entry_key,c.activity,c.metadata,c.artifact_entry_ids,left(p.title,128) AS project_title
      FROM collaboration_catalog c JOIN projects p USING(project_id) WHERE ${where.join(" AND ")}
      ORDER BY c.activity DESC,c.entry_key DESC LIMIT ${param(q.limit + 1)}`,
      values,
    );
    const items: CollaborationOwnedResource[] = [];
    let bytes = 2048;
    for (const row of rows.slice(0, q.limit)) {
      const item = {
        ...row.metadata,
        project_title: row.project_title,
        ...(row.artifact_entry_ids?.length
          ? { artifact_entry_ids: row.artifact_entry_ids }
          : {}),
      };
      // Reserve room for home personal labels and next/revision tokens.
      const size = Buffer.byteLength(JSON.stringify(item)) + 512;
      if (bytes + size > PAGE_BYTES) break;
      items.push(item);
      bytes += size;
    }
    const last = rows[items.length - 1];
    return {
      items,
      ...(last && rows.length > items.length
        ? {
            next: collaborationNextCursor(
              q.binding,
              Number(last.activity),
              last.entry_key,
            ),
          }
        : {}),
      coverage: "partial",
      coverage_message:
        "Selected-project owner catalog; search covers shared titles. Unindexed legacy sources and truncated participant relations may be absent.",
    };
  });
}

/** Bounded bulk overlay, including resources omitted by the account quota. */
export async function overlayCollaborationProjectPage(
  account_id: string,
  page: CollaborationPage<CollaborationOwnedResource>,
): Promise<CollaborationPage<CollaborationResource>> {
  if (
    page.items.length > 50 ||
    Buffer.byteLength(JSON.stringify(page)) > PAGE_BYTES
  )
    throw Error("project page limit exceeded");
  if (!page.items.length) return page;
  await reconcileCollaborationArtifactPersonalState(account_id, page.items);
  const pins = await collaborationAgentPins(account_id);
  const { rows } = await getPool().query(
    `WITH r AS (
    SELECT $1::uuid AS account_id,e.entry_key,e.project_id,e.kind,e.metadata FROM jsonb_to_recordset($2::jsonb)
    AS e(entry_key text,project_id uuid,kind text,metadata jsonb))
    SELECT r.entry_key,${EFFECTIVE_ALIAS} AS alias,${effectiveCollected("$3")} AS collected,s.following,s.muted,s.read_through,s.last_mention,s.notify_after
    FROM r LEFT JOIN collaboration_personal s ON s.account_id=r.account_id AND s.entry_key=r.entry_key ${LEGACY_PERSONAL_JOINS}`,
    [
      account_id,
      JSON.stringify(
        page.items.map((resource) => ({
          entry_key: entryKey(resource),
          project_id: resource.project_id,
          kind: resource.kind,
          metadata: resource,
        })),
      ),
      pins,
    ],
  );
  const states = new Map(rows.map((row) => [row.entry_key, row]));
  return {
    ...page,
    items: page.items.map(({ artifact_entry_ids: _history, ...item }) => {
      const row = states.get(entryKey(item));
      const personal = {
        ...(row?.alias ? { alias: row.alias } : {}),
        collected: !!row?.collected,
        following: !!row?.following,
        muted: !!row?.muted,
        read_through: Number(row?.read_through ?? 0),
      };
      return {
        ...item,
        personal,
        ...(Number(row?.last_mention ?? 0) >
        Math.max(personal.read_through, Number(row?.notify_after ?? 0))
          ? { reason: "mention" as const }
          : personal.following
            ? { reason: "following" as const }
            : item.participant_ids.includes(account_id)
              ? { reason: "participation" as const }
              : {}),
      };
    }),
  };
}
