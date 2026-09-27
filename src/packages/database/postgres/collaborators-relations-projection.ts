/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { PoolClient } from "@cocalc/database/pool";
import type {
  CollaborationProjectionPage,
  CollaborationProjectionRequest,
} from "@cocalc/conat/inter-bay/collaborators";
import type { CollaborationParticipantContinuation } from "@cocalc/util/collaboration-relations";
import { integer, uuid } from "./collaborators-common";

type Item = Extract<
  CollaborationProjectionPage,
  { allowed: true }
>["items"][number];
const key = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
export const sameParticipantContinuation = (
  a: CollaborationParticipantContinuation | undefined,
  b: CollaborationParticipantContinuation | undefined,
) =>
  (!a && !b) ||
  (!!a &&
    !!b &&
    a.entry_key === b.entry_key &&
    a.revision === b.revision &&
    a.set_key === b.set_key &&
    a.thread_key === b.thread_key &&
    a.count === b.count &&
    a.after === b.after);

/** One bounded participant page, reusing the ordinary catalog outbox cursor. */
export async function readOwnerParticipantProjection(
  db: PoolClient,
  item: Item | undefined,
  row: any,
  after?: CollaborationParticipantContinuation,
): Promise<{ next?: CollaborationParticipantContinuation }> {
  if (!item?.resource || !row?.relation_set || !row.relation_thread) return {};
  if (
    after &&
    (Buffer.byteLength(JSON.stringify(after)) > 1024 ||
      !key(after.entry_key) ||
      !key(after.set_key) ||
      !key(after.thread_key))
  )
    throw Error("invalid participant projection continuation");
  if (after) {
    integer(after.revision, "participant revision");
    integer(after.count, "participant progress");
    uuid(after.after, "participant continuation");
  }
  const continuing =
    after?.entry_key === item.entry_key &&
    after.revision === item.revision &&
    after.set_key === row.relation_set &&
    after.thread_key === row.relation_thread;
  const lower = continuing ? after!.after : null;
  const count = continuing ? after!.count : 0;
  if (count > Number(row.relation_count))
    throw Error("invalid participant progress");
  const rows = (
    await db.query(
      `SELECT participant_id FROM collaboration_participants
    WHERE set_key=$1 AND thread_key=$2 AND ($3::uuid IS NULL OR participant_id>$3::uuid)
    ORDER BY participant_id LIMIT 201`,
      [row.relation_set, row.relation_thread, lower],
    )
  ).rows;
  const ids = rows.slice(0, 200).map((r) => r.participant_id as string),
    complete = rows.length <= 200;
  item.participants = {
    set_key: row.relation_set,
    thread_key: row.relation_thread,
    after: lower,
    ids,
    count: Number(row.relation_count),
    complete,
  };
  return complete
    ? {}
    : {
        next: {
          count: count + ids.length,
          entry_key: item.entry_key,
          revision: item.revision,
          set_key: row.relation_set,
          thread_key: row.relation_thread,
          after: ids[ids.length - 1],
        },
      };
}

/** Caller holds the account-home claim/access fence. Staged edges are not query-visible. */
export async function applyHomeParticipantProjection(
  db: PoolClient,
  job: CollaborationProjectionRequest,
  page: Extract<CollaborationProjectionPage, { allowed: true }>,
) {
  let continuation: CollaborationParticipantContinuation | undefined;
  for (const item of page.items) {
    if (!item.resource) continue;
    const p = item.participants;
    if (!p) {
      await db.query(
        "UPDATE collaboration_index SET relation_set=NULL,relation_thread=NULL,relations_complete=FALSE,relation_budget=0 WHERE account_id=$1 AND entry_key=$2",
        [job.account_id, item.entry_key],
      );
      await db.query(
        "DELETE FROM collaboration_participant_index WHERE account_id=$1 AND entry_key=$2",
        [job.account_id, item.entry_key],
      );
      continue;
    }
    if (
      !key(p.set_key) ||
      !key(p.thread_key) ||
      !Array.isArray(p.ids) ||
      p.ids.length > 200 ||
      typeof p.complete !== "boolean"
    )
      throw Error("invalid participant projection page");
    integer(p.count, "participant count");
    if (p.count > 1_000_000 || (!p.complete && !p.ids.length))
      throw Error("participant projection limit exceeded");
    let previous = p.after;
    if (previous !== null) uuid(previous, "participant cursor");
    for (const id of p.ids) {
      uuid(id, "participant");
      if (id !== id.toLowerCase() || (previous !== null && id <= previous))
        throw Error("unordered participant projection");
      previous = id;
    }
    const expected = {
      count: p.after === null ? 0 : (job.relation_after?.count ?? 0),
      entry_key: item.entry_key,
      revision: item.revision,
      set_key: p.set_key,
      thread_key: p.thread_key,
      after: p.after,
    };
    if (
      p.after !== null &&
      (page.reset ||
        !sameParticipantContinuation(
          { ...expected, after: p.after },
          job.relation_after,
        ))
    )
      throw Error("participant continuation mismatch");
    if (p.after === null) {
      const current = (
        await db.query(
          `SELECT relation_set,relation_thread,relations_complete FROM collaboration_index
        WHERE account_id=$1 AND entry_key=$2`,
          [job.account_id, item.entry_key],
        )
      ).rows[0];
      const retained =
        current?.relations_complete && current.relation_thread === p.thread_key
          ? current.relation_set
          : null;
      await db.query(
        "DELETE FROM collaboration_participant_index WHERE account_id=$1 AND entry_key=$2 AND ($3::text IS NULL OR set_key<>$3)",
        [job.account_id, item.entry_key, retained],
      );
      await db.query(
        `UPDATE collaboration_index SET relation_set=$3,relation_thread=CASE WHEN $3::text IS NULL THEN NULL ELSE relation_thread END,
        relations_complete=($3::text IS NOT NULL),relation_budget=$4+(
          SELECT count(*) FROM collaboration_participant_index WHERE account_id=$1 AND entry_key=$2 AND set_key<>$5)
        WHERE account_id=$1 AND entry_key=$2`,
        [job.account_id, item.entry_key, retained, p.count, p.set_key],
      );
      // Reserve the full incoming set once, not by repeatedly scanning all edges.
      const reserved = Number(
        (
          await db.query(
            "SELECT COALESCE(sum(relation_budget),0) AS n FROM collaboration_index WHERE account_id=$1",
            [job.account_id],
          )
        ).rows[0].n,
      );
      if (reserved > 2_000_000)
        throw Error("account participant projection quota exceeded");
    }
    await db.query(
      `INSERT INTO collaboration_participant_index(account_id,entry_key,project_id,set_key,participant_id)
      SELECT $1,$2,$3,$4,unnest($5::uuid[]) ON CONFLICT DO NOTHING`,
      [job.account_id, item.entry_key, job.project_id, p.set_key, p.ids],
    );
    const count = expected.count + p.ids.length;
    if (count > p.count || (p.complete && count !== p.count))
      throw Error("incomplete participant projection");
    if (p.complete) {
      await db.query(
        `UPDATE collaboration_index SET relation_set=$3,relation_thread=$4,relations_complete=TRUE,relation_budget=$5
      WHERE account_id=$1 AND entry_key=$2`,
        [job.account_id, item.entry_key, p.set_key, p.thread_key, p.count],
      );
      await db.query(
        "DELETE FROM collaboration_participant_index WHERE account_id=$1 AND entry_key=$2 AND set_key<>$3",
        [job.account_id, item.entry_key, p.set_key],
      );
    } else {
      if (continuation || page.items.length !== 1 || page.complete)
        throw Error("invalid pending participant page");
      continuation = { ...expected, count, after: p.ids[p.ids.length - 1] };
    }
  }
  if (!sameParticipantContinuation(continuation, page.relation_after))
    throw Error("participant cursor handoff mismatch");
}

export function homeParticipation(alias: string, person: string) {
  return `EXISTS(SELECT 1 FROM collaboration_participant_index cp WHERE cp.account_id=${alias}.account_id
    AND cp.entry_key=${alias}.entry_key AND cp.set_key=${alias}.relation_set AND cp.participant_id=${person}::uuid AND ${alias}.relations_complete)`;
}
export function ownerParticipation(alias: string, person: string) {
  return `EXISTS(SELECT 1 FROM collaboration_participants cp WHERE cp.set_key=${alias}.relation_set
    AND cp.thread_key=${alias}.relation_thread AND cp.participant_id=${person}::uuid)`;
}
