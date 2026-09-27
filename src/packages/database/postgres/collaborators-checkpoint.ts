/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { CollaboratorsApi } from "@cocalc/conat/hub/api/collaborators";
import {
  assertCollaborationWriterAuthority,
  type CollaborationWriterAuthority,
} from "./collaborators-owner";
import {
  boundedText,
  hash,
  integer,
  sourceKey,
  transaction,
  validateSource,
} from "./collaborators-common";

/** Recover metadata activity floors, not message bodies or notification history. */
export async function collaborationCheckpointPage(
  input: Parameters<CollaboratorsApi["checkpointPage"]>[0],
  authority: CollaborationWriterAuthority,
): ReturnType<CollaboratorsApi["checkpointPage"]> {
  const source = validateSource(input);
  return transaction(async (db) => {
    await assertCollaborationWriterAuthority(db, source.project_id, authority);
    const source_id = sourceKey(source);
    const row = (
      await db.query(
        `SELECT s.epoch,s.revision,p.generation FROM collaboration_sources s
        JOIN collaboration_projects p USING(project_id) WHERE source_id=$1 AND relocated_to IS NULL`,
        [source_id],
      )
    ).rows[0];
    if (!row) throw Error("collaboration source not registered");
    const binding = hash(
      JSON.stringify([
        source_id,
        authority.host_id,
        row.epoch,
        String(row.revision),
        row.generation,
      ]),
    );
    let key = "";
    if (input.after !== undefined) {
      boundedText(input.after, "checkpoint cursor", 1024);
      try {
        const cursor = JSON.parse(
          Buffer.from(input.after, "base64url").toString(),
        );
        if (
          cursor.v !== 1 ||
          cursor.binding !== binding ||
          !Number.isFinite(cursor.expires) ||
          cursor.expires <= Date.now() ||
          !/^[a-f0-9]{64}$/.test(cursor.key)
        )
          throw Error();
        key = cursor.key;
      } catch {
        throw Error(
          "invalid or changed collaboration checkpoint; restart paging",
        );
      }
    }
    const { rows } = await db.query(
      `SELECT entry_key,kind,COALESCE(resource_id,metadata->>'resource_id') AS resource_id,
      GREATEST(activity_floor,(metadata->>'activity')::bigint) AS activity
      FROM collaboration_catalog WHERE source_id=$1 AND entry_key>$2
      AND COALESCE(resource_id,metadata->>'resource_id') IS NOT NULL ORDER BY entry_key LIMIT 51`,
      [source_id, key],
    );
    const items = rows.slice(0, 50).map((r) => ({
      resource_id: r.resource_id,
      kind: r.kind,
      activity: integer(Number(r.activity), "checkpoint activity"),
    }));
    return {
      epoch: row.epoch,
      items,
      ...(rows.length > 50
        ? {
            next: Buffer.from(
              JSON.stringify({
                v: 1,
                binding,
                key: rows[49].entry_key,
                expires: Date.now() + 10 * 60 * 1000,
              }),
            ).toString("base64url"),
          }
        : {}),
    };
  });
}
