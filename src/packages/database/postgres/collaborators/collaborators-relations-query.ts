/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type {
  CollaborationRelationQuery,
  CollaborationReferenceRelation,
} from "@cocalc/util/collaboration-relations";
import type { CollaborationPage } from "@cocalc/util/collaborators";
import {
  assertCollaborationAccountAuthority,
  getOwnedCollaborationResource,
} from "./collaborators-owner";
import {
  collaborationPageQuery,
  collaborationNextCursor,
} from "./collaborators-discovery";
import {
  boundedText,
  entryKey,
  PAGE_BYTES,
  transaction,
  uuid,
  validateTarget,
} from "./collaborators-common";

async function readRelations(
  input: CollaborationRelationQuery,
  authority: { owning_bay_id: string },
  kind: "participants" | "references",
) {
  validateTarget(input);
  uuid(input.account_id, "account_id");
  if (input.message_id !== undefined)
    boundedText(input.message_id, "message_id", 256);
  if (kind === "participants" && input.message_id !== undefined)
    throw Error("participants do not accept a message filter");
  const owned = await getOwnedCollaborationResource(
    input,
    input.account_id!,
    authority,
  );
  if (!owned) return { items: [], coverage: "complete" as const };
  const key = entryKey({
    ...owned,
    resource_id: owned.agent_catalog_resource_id ?? owned.resource_id,
  });
  return transaction(async (db) => {
    await assertCollaborationAccountAuthority(
      db,
      input.project_id,
      input.account_id!,
      authority,
    );
    const current = (
      await db.query(
        `SELECT c.relation_set,c.relation_thread,p.generation,s.coverage,s.coverage_message FROM collaboration_catalog c
      JOIN collaboration_projects p USING(project_id) JOIN collaboration_sources s ON s.source_id=c.source_id
      WHERE c.entry_key=$1 AND c.deleted_at IS NULL
      AND c.metadata->>'chat_path'=$2 AND c.metadata->>'thread_id'=$3`,
        [key, owned.chat_path, owned.thread_id],
      )
    ).rows[0];
    if (!current?.relation_set || !current.relation_thread)
      return {
        items: [],
        coverage: "indexing" as const,
        coverage_message:
          "Complete source relations have not been indexed yet.",
      };
    const q = collaborationPageQuery(
      input,
      `relations:${kind}:${key}:${current.generation}:${current.relation_set}:${current.relation_thread}:${input.message_id ?? ""}`,
    );
    let rows: any[];
    if (kind === "participants") {
      if (q.after) uuid(q.after.key, "participant cursor");
      rows = (
        await db.query(
          `SELECT participant_id AS account_id,participant_id::text AS key FROM collaboration_participants
        WHERE set_key=$1 AND thread_key=$2 AND ($3::uuid IS NULL OR participant_id>$3::uuid) ORDER BY participant_id LIMIT $4`,
          [
            current.relation_set,
            current.relation_thread,
            q.after?.key ?? null,
            q.limit + 1,
          ],
        )
      ).rows;
    } else
      rows = (
        await db.query(
          `SELECT id AS key,payload FROM collaboration_references WHERE set_key=$1 AND thread_key=$2
      AND ($3::text IS NULL OR message_id=$3) AND id>$4 ORDER BY id LIMIT $5`,
          [
            current.relation_set,
            current.relation_thread,
            input.message_id ?? null,
            q.after?.key ?? "",
            q.limit + 1,
          ],
        )
      ).rows;
    const items: any[] = [];
    let bytes = 2048;
    for (const row of rows.slice(0, q.limit)) {
      const value =
        kind === "participants" ? { account_id: row.account_id } : row.payload;
      const size = Buffer.byteLength(JSON.stringify(value));
      if (bytes + size > PAGE_BYTES) break;
      items.push(value);
      bytes += size;
    }
    const last = rows[items.length - 1];
    return {
      items,
      ...(current.coverage === "complete"
        ? { coverage: "complete" as const }
        : {
            coverage: "partial" as const,
            coverage_message:
              current.coverage_message ??
              "Showing the last complete source relations; refresh is incomplete.",
          }),
      ...(last && rows.length > items.length
        ? { next: collaborationNextCursor(q.binding, 0, last.key) }
        : {}),
    };
  });
}
export function listCollaborationParticipants(
  input: CollaborationRelationQuery,
  authority: { owning_bay_id: string },
): Promise<CollaborationPage<{ account_id: string }>> {
  return readRelations(input, authority, "participants");
}
export function listCollaborationReferences(
  input: CollaborationRelationQuery,
  authority: { owning_bay_id: string },
): Promise<CollaborationPage<CollaborationReferenceRelation>> {
  return readRelations(input, authority, "references");
}
